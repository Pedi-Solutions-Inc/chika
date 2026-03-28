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
| `src/index.ts` | Barrel re-exports: `useChat`, `useUnread`, `createChatSession`, `createSSEConnection`, `resolveServerUrl`, all consumer-facing types |
| `src/types.ts` | `ChatConfig`, `ChatStatus`, `UseChatOptions<D>`, `UseChatReturn<D>` |
| `src/resolve-url.ts` | `resolveServerUrl()` — manifest bucket hashing by channel ID |
| `src/sse-connection.ts` | `createSSEConnection()` — shared SSE primitive handling EventSource lifecycle, reconnection, heartbeat, error/410 detection. Accepts `customEvents` array for extensibility. |
| `src/session.ts` | `createChatSession<D>()` — imperative callback-based session using `createSSEConnection`. Includes `markAsRead()` for read receipts. |
| `src/use-chat.ts` | `useChat<D>()` — React hook wrapping session lifecycle, AppState, state management. Auto-marks-read on unmount when connected. |
| `src/use-unread.ts` | `useUnread()` — per-channel SSE-backed unread notification hook. Returns `{ unreadCount, hasUnread, lastMessageAt, error }`. Supports `enabled` toggle and AppState handling. |

## Primary API: `useChat<D>` Hook

```typescript
const { messages, participants, status, error, sendMessage, disconnect } = useChat<D>({
  config,     // ChatConfig with manifest
  channelId,  // any string
  profile,    // Participant<D>
});
```

Returns:
- `messages: Message<D>[]` — reactive, accumulates from join history + SSE
- `participants: Participant<D>[]` — from join response (refreshed on reconnect)
- `status: ChatStatus` — `'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'`
- `error: Error | null` — last error, cleared on successful reconnect
- `sendMessage(body, attributes?)` — sends a chat message, `attributes` typed as `D['attributes']`
- `disconnect()` — tears down session and SSE

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

## Key Behaviors

### Reconnection
- `pollingInterval: 0` disables react-native-sse's built-in reconnection
- `createSSEConnection` manages reconnection with configurable delay (default 3s)
- `Last-Event-ID` tracked locally (not mutating config) from each received event and sent on reconnect
- Full session recreation on AppState foreground return (authoritative server state)

### Deduplication
- `seenMessageIds` Set tracks all message IDs (from join history, SSE events, sent message responses)
- SSE events with already-seen IDs are silently dropped
- Prevents duplicates from SSE echo of own messages and reconnection replay

### AppState (React Native)
- **iOS:** Tears down on `inactive`/`background`, reconnects on `active`
- **Android:** Only tears down on `background` — `inactive` is ignored because keyboards, dialogs, overlays, and multi-window all trigger `inactive` on Android. 2-second grace period before teardown.
- Grace timer cancelled if app returns to `active` quickly (avoids thrashing for brief transitions)

### Unmount Safety
- `disposedRef` shared across effects prevents state updates after unmount
- New sessions created during async reconnect are disconnected if component already unmounted
- Background timers cleared on cleanup

### Stale Closure Prevention
- `profile` and `config` stored in refs, read via `.current` in callbacks
- No unnecessary reconnections when parent re-renders with new object references

## Dependencies

- `@pedi/chika-types` — shared types (generic)
- `react-native-sse` — EventSource for React Native (typed with `EventSource<ChatEvents>`)
- Peer deps: `react`, `react-native`
- Dev deps: `@types/react`

## Type Re-exports

The SDK re-exports all consumer-facing types so consumers only need `@pedi/chika-sdk`:
`ChatDomain`, `DefaultDomain`, `Message`, `Participant`, `MessageAttributes`, `SendMessageResponse`, `ChatManifest`, `ChatBucket`
