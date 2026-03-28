# @pedi/chika-sdk — Agent Guide

> **Maintenance rule:** When you modify the SDK, update this file. Document new exports, changed hook behavior, new files.

React Native SDK providing a generic, hook-based API for real-time chat over SSE.

## ChatDomain Generics

The entire SDK is parameterized by `ChatDomain`. When a consumer defines their domain, all types flow through:

```typescript
import { useChat, type ChatDomain } from '@pedi/chika-sdk';

interface MyChat extends ChatDomain {
  role: 'agent' | 'customer';
  metadata: { tier?: string };
  messageType: 'chat' | 'escalated' | 'resolved';
  attributes: { priority?: number };
}

const { messages, sendMessage } = useChat<MyChat>({ config, channelId, profile });
// messages is Message<MyChat>[]
// sendMessage attributes are typed as { priority?: number }
// profile.role must be 'agent' | 'customer'
```

Without a generic, everything defaults to `DefaultDomain` (fully open strings/records).

## File Map

| File | Contents |
|------|----------|
| `src/index.ts` | Barrel re-exports: all hooks, utilities, error classes, and consumer-facing types |
| `src/types.ts` | `ChatConfig`, `ChatStatus`, `ResilienceConfig`, `UseChatOptions<D>`, `UseChatReturn<D>` |
| `src/resolve-url.ts` | `resolveServerUrl()` — manifest bucket hashing by channel ID |
| `src/errors.ts` | `ChatDisconnectedError`, `ChannelClosedError`, `HttpError`, `RetryExhaustedError`, `QueueFullError` |
| `src/retry.ts` | `withRetry()`, `calculateBackoff()`, `isRetryableError()`, `resolveRetryConfig()`, `sleep()` — pure retry utility with no React/RN deps |
| `src/network-monitor.ts` | `NetworkMonitor` interface + `createNetworkMonitor()` — optional `@react-native-community/netinfo` wrapper with always-online stub fallback |
| `src/message-queue.ts` | `MessageQueue` class, `QueueStorage` interface, `createQueueStorage()`, `createAsyncStorageAdapter()` — offline message queue with per-message status tracking and optional persistent storage |
| `src/sse-connection.ts` | `createSSEConnection()` — shared SSE primitive with exponential backoff, network-aware reconnection, `reconnectImmediate()` for server-initiated resync |
| `src/session.ts` | `createChatSession<D>()` — imperative callback-based session with retry wrapping, `HttpError` classification, idempotency key support, `markAsRead()` best-effort retry |
| `src/use-chat.ts` | `useChat<D>()` — React hook wrapping session lifecycle, AppState, module-scope message queue (survives remounts), network monitor, per-message status |
| `src/use-unread.ts` | `useUnread()` — per-channel SSE-backed unread notification hook with network-aware reconnection |

## Primary API: `useChat<D>` Hook

```typescript
const {
  messages, participants, status, error,
  sendMessage, disconnect,
  pendingMessages, cancelMessage, retryMessage,
} = useChat<D>({
  config,     // ChatConfig with manifest + optional resilience config
  channelId,  // any string
  profile,    // Participant<D>
});
```

Returns:
- `messages: Message<D>[]` — reactive, accumulates from join history + SSE
- `participants: Participant<D>[]` — from join response (refreshed on reconnect)
- `status: ChatStatus` — `'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed' | 'error'`
- `error: Error | null` — last error, cleared on successful reconnect
- `sendMessage(type, body, attributes?)` — sends a chat message with retry + queue support
- `disconnect()` — tears down session and SSE
- `pendingMessages: QueuedMessage[]` — per-message send status (`'sending' | 'queued' | 'failed'`). Empty when resilience disabled.
- `cancelMessage(messageKey)` — cancel a queued/failed message, removes optimistic message
- `retryMessage(messageKey)` — retry a failed message

## Unread API: `useUnread` Hook

```typescript
const { unreadCount, hasUnread, lastMessageAt, error } = useUnread({
  config,          // ChatConfig with manifest
  channelId,       // channel to monitor
  participantId,   // current user's ID
  enabled,         // optional, default true — set false when useChat is active
});
```

Connects to `GET /channels/:channelId/unread?participant_id=xxx` SSE stream. Receives `unread_snapshot` on connect, `unread_update` on new messages, `unread_clear` on mark-read. Resets state when `channelId`/`participantId` changes.

## Secondary API: `createChatSession<D>`

Lower-level imperative API with callbacks (`onMessage`, `onStatusChange`, `onError`). Used by `useChat` internally. Available for non-React or custom integrations. Includes `markAsRead(messageId)` for read receipts.

## Network Resilience

Enabled by default. All features are togglable via `ChatConfig.resilience`.

### Configuration

```typescript
const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {                          // or `false` to disable all
    retry: { maxAttempts: 5 },           // or `false` to disable retry
    offlineQueue: true,                  // default: true
    maxQueueSize: 50,                    // default: 50
    networkMonitor: myCustomMonitor,     // optional, bypasses built-in NetInfo
    queueStorage: createQueueStorage(),  // optional, auto-detects MMKV > AsyncStorage
  },
};
```

**Toggle semantics:**
- `resilience: undefined` (default) → all features on
- `resilience: false` → all off, exact pre-resilience behavior
- `resilience: { retry: false }` → no retry, keep queue + monitoring
- `resilience: { offlineQueue: false }` → no queue, keep retry

### Retry (`retry.ts`)
- `withRetry(fn, config, signal)` wraps async functions with exponential backoff + jitter
- `isRetryableError()` classifies errors: `TypeError` (network), `HttpError` 5xx/408/429 → retryable. `ChannelClosedError`, 4xx, `AbortError` → not retryable
- 429 responses with `Retry-After` header respect the server-specified delay
- `HttpError` class replaces raw `Error('Send failed: ...')` — structured `status`, `body`, `retryAfter` fields
- `RetryExhaustedError` thrown after all attempts fail — contains `operation`, `attempts`, `lastError`
- Join, sendMessage, and markAsRead are all wrapped with `withRetry` when resilience enabled
- `markAsRead` uses a lower retry config (`{ maxAttempts: 2, baseDelayMs: 500 }`) and is fire-and-forget (non-retryable errors surfaced via `onError`, `RetryExhaustedError` swallowed)

### SSE Exponential Backoff (`sse-connection.ts`)
- Replaces fixed-delay reconnection with `calculateBackoff(attempt, config)`
- Backoff: `min(baseDelay * 2^attempt, 30s) * jitter` where jitter is `[0.7, 1.3]`
- Attempt counter resets to 0 on successful `onOpen`
- `reconnectImmediate()` method bypasses backoff for server-initiated resync
- Optional `networkMonitor` in config — waits for connectivity before attempting reconnect

### Network Monitor (`network-monitor.ts`)
- `NetworkMonitor` interface: `isConnected()`, `subscribe(cb)`, `waitForOnline(signal?)`, `dispose()`
- `createNetworkMonitor()` uses lazy `try { require('@react-native-community/netinfo') } catch {}` — returns always-online stub if not installed
- Consumers can inject custom monitor via `config.resilience.networkMonitor` (primary documented approach)
- When connectivity returns and status is `'error'`, the hook auto-retries `startSession()`
- **Note:** `useChat` and `useUnread` create independent monitors by default. Share via `config.resilience.networkMonitor` when using both hooks.

### Message Queue (`message-queue.ts`)
- In-memory FIFO queue with configurable cap (default 50, throws `QueueFullError` when full)
- Per-message status: `'sending' | 'queued' | 'failed'` with error and retryCount
- Per-message `AbortController` — `cancel()` aborts individual, `dispose()` aborts all
- Queue drain gated on `'connected'` status (not raw network return) to avoid race with resync
- Module-scope registry in `use-chat.ts` keyed by `channelId` (ref-counted) — survives component remounts (React Navigation)
- Disposed when last subscriber for channelId unmounts
- **Persistent storage** via optional `QueueStorage` adapter (`getItem`/`setItem`/`removeItem`)
  - `createQueueStorage()` auto-detects: MMKV (priority 1) > AsyncStorage (priority 2) > null
  - `createAsyncStorageAdapter()` for explicit AsyncStorage selection
  - Storage failures are non-fatal (logged via `onError`, queue starts empty in-memory)
  - Restored entries are fire-and-forget (no caller awaiting — original enqueue promise is gone after app restart)

### Idempotency
- Each `sendMessage` call generates a `messageKey` (used as both optimistic ID and idempotency key)
- Sent as `idempotency_key` in the request body (Zod-validated, proxy-safe)
- Server enforces dedup via sparse unique index on `(channel_id, idempotency_key)`
- `doSend` closure reads `sessionRef.current` (not captured session) — retries after reconnect use the healthy session

### Error Classes
- `HttpError(status, body, retryAfter?)` — structured HTTP error with retry classification
- `RetryExhaustedError(operation, attempts, lastError)` — all retry attempts failed
- `QueueFullError(maxSize)` — queue at capacity

## Key Behaviors

### Reconnection
- `pollingInterval: 0` disables react-native-sse's built-in reconnection
- `createSSEConnection` manages reconnection with exponential backoff (base 3s, max 30s)
- `Last-Event-ID` tracked locally from each received event and sent on reconnect
- Full session recreation on AppState foreground return (authoritative server state)
- Session waits for network monitor to initialize before first connection (no double-connect)

### Deduplication
- `seenMessageIds` Set tracks all message IDs (from join history, SSE events, sent message responses)
- SSE events with already-seen IDs are silently dropped
- Prevents duplicates from SSE echo of own messages and reconnection replay
- Server-side idempotency key prevents duplicate inserts on client retry

### AppState (React Native)
- **iOS:** Tears down on `inactive`/`background`, reconnects on `active`
- **Android:** Only tears down on `background` — `inactive` is ignored because keyboards, dialogs, overlays, and multi-window all trigger `inactive` on Android. 2-second grace period before teardown.
- Grace timer cancelled if app returns to `active` quickly (avoids thrashing for brief transitions)
- Message queue survives session teardown on background — flushes on reconnect

### Unmount Safety
- `disposedRef` shared across effects prevents state updates after unmount
- New sessions created during async reconnect are disconnected if component already unmounted
- Background timers cleared on cleanup
- Queue `dispose()` aborts all pending message AbortControllers — no state-update-on-unmounted warnings

### Stale Closure Prevention
- `profile` and `config` stored in refs, read via `.current` in callbacks
- `monitor` uses both `useState` (for effect deps) and `monitorRef` (for closure-safe access)
- `doSend` reads `sessionRef.current` — not a captured session reference
- No unnecessary reconnections when parent re-renders with new object references

## Dependencies

- `@pedi/chika-types` — shared types (generic)
- `react-native-sse` — EventSource for React Native
- Peer deps: `react`, `react-native`
- Optional peer deps: `@react-native-community/netinfo` (network monitoring), `@react-native-async-storage/async-storage` (queue persistence), `react-native-mmkv` (queue persistence, preferred)
- Dev deps: `@types/react`

## Type Re-exports

The SDK re-exports all consumer-facing types so consumers only need `@pedi/chika-sdk`:
`ChatDomain`, `DefaultDomain`, `Message`, `Participant`, `MessageAttributes`, `SendMessageResponse`, `ChatManifest`, `ChatBucket`, `RetryConfig`, `ResilienceConfig`, `NetworkMonitor`, `QueueStorage`, `QueuedMessage`, `MessageSendStatus`
