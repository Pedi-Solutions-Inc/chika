# SDK API Reference

Complete reference for all exports from `@pedi/chika-sdk`.

## Table of Contents

- [useChat\<D\>](#usechatd) — Main React hook
- [useUnread](#useunread) — Unread notification hook
- [createChatSession\<D\>](#createchatsessiond) — Imperative API
- [createSSEConnection](#createsseconnection) — Shared SSE utility
- [resolveServerUrl](#resolveserverurl) — Bucket routing
- [createManifest](#createmanifest) — Single-server helper
- [ChatDisconnectedError](#chatdisconnectederror) — Error class
- [ChannelClosedError](#channelclosederror) — Error class
- [HttpError](#httperror) — HTTP error class
- [RetryExhaustedError](#retryexhaustederror) — Retry exhaustion error
- [QueueFullError](#queuefullerror) — Queue capacity error
- [withRetry](#withretry) — Retry utility
- [createNetworkMonitor](#createnetworkmonitor) — Network detection
- [createQueueStorage](#createqueuestorage) — Storage adapter resolution
- [createAsyncStorageAdapter](#createasyncstorageadapter) — AsyncStorage adapter
- [Configuration Types](#configuration-types)

---

## useChat\<D\>

```typescript
function useChat<D extends ChatDomain = DefaultDomain>(
  options: UseChatOptions<D>
): UseChatReturn<D>
```

The primary React hook for chat functionality. Manages the full lifecycle: joining a channel, streaming messages via SSE, sending messages, handling reconnection, and cleaning up on unmount.

### Options

```typescript
interface UseChatOptions<D extends ChatDomain = DefaultDomain> {
  config: ChatConfig;
  channelId: string;
  profile: Participant<D>;
  onMessage?: (message: Message<D>) => void;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `config` | `ChatConfig` | Yes | Connection and behavior configuration |
| `channelId` | `string` | Yes | Channel to connect to |
| `profile` | `Participant<D>` | Yes | Current user's participant profile (sent on join) |
| `onMessage` | `(msg: Message<D>) => void` | No | Callback fired for each new message (after deduplication) |

### Return Value

```typescript
interface UseChatReturn<D extends ChatDomain = DefaultDomain> {
  messages: Message<D>[];
  participants: Participant<D>[];
  status: ChatStatus;
  error: Error | null;
  sendMessage: (
    type: D['messageType'],
    body: string,
    attributes?: MessageAttributes<D>
  ) => Promise<SendMessageResponse>;
  disconnect: () => void;
  pendingMessages: QueuedMessage[];
  cancelMessage: (messageKey: string) => void;
  retryMessage: (messageKey: string) => void;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Message<D>[]` | All messages — historical (from join) + new (from SSE). Grows over the session lifetime. |
| `participants` | `Participant<D>[]` | Current channel participants (from join response) |
| `status` | `ChatStatus` | Current connection status |
| `error` | `Error \| null` | Most recent error, or `null` |
| `sendMessage` | `function` | Send a message. Returns the server's `SendMessageResponse`. Throws `ChatDisconnectedError` if not connected. |
| `disconnect` | `() => void` | Manually close the SSE connection and set status to `disconnected` |
| `pendingMessages` | `QueuedMessage[]` | Per-message send status. Empty when resilience disabled. |
| `cancelMessage` | `(messageKey: string) => void` | Cancel a queued or failed message |
| `retryMessage` | `(messageKey: string) => void` | Retry a failed message |

### Example

```typescript
import { useChat, createManifest } from '@pedi/chika-sdk';
import type { PediChat } from '@pedi/chika-types';

function ChatScreen({ bookingId, user, token }) {
  const {
    messages,
    participants,
    status,
    error,
    sendMessage,
    disconnect,
  } = useChat<PediChat>({
    config: {
      manifest: createManifest('https://chat.example.com'),
      headers: { Authorization: `Bearer ${token}` },
      reconnectDelayMs: 5000,
      optimisticSend: true,
    },
    channelId: `booking_${bookingId}`,
    profile: {
      id: user.id,
      role: 'rider',
      name: user.name,
      profile_image: user.avatar,
      metadata: {
        rating: user.rating,
        current_location: user.location,
      },
    },
    onMessage: (msg) => {
      // Trigger push notification, haptic feedback, etc.
      if (msg.type === 'driver_arrived') {
        showAlert('Your driver has arrived!');
      }
    },
  });

  const handleSend = async (text: string) => {
    try {
      const { id, created_at } = await sendMessage('chat', text, {
        device: 'ios',
        app_version: '2.1.0',
      });
      console.log('Sent:', id);
    } catch (err) {
      if (err instanceof ChatDisconnectedError) {
        showToast('Cannot send — reconnecting...');
      }
    }
  };

  // Clean up on navigation
  useEffect(() => {
    return () => disconnect();
  }, []);
}
```

---

## useUnread

```typescript
function useUnread(options: UseUnreadOptions): UseUnreadReturn
```

React hook for real-time unread message notifications. Connects to a per-channel SSE stream that delivers unread count updates. Designed for "red dot" indicators and badge counts on non-chat pages.

### Options

```typescript
interface UseUnreadOptions {
  config: ChatConfig;
  channelId: string;
  participantId: string;
  enabled?: boolean;
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `config` | `ChatConfig` | Yes | — | Same connection config as `useChat` |
| `channelId` | `string` | Yes | — | Channel to monitor for unread messages |
| `participantId` | `string` | Yes | — | Current user's participant ID |
| `enabled` | `boolean` | No | `true` | Set `false` to pause the SSE connection (e.g., when `useChat` is active for this channel) |

### Return Value

```typescript
interface UseUnreadReturn {
  unreadCount: number;
  hasUnread: boolean;
  lastMessageAt: string | null;
  error: Error | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `unreadCount` | `number` | Number of unread messages in the channel |
| `hasUnread` | `boolean` | Convenience flag — `true` when `unreadCount > 0` |
| `lastMessageAt` | `string \| null` | ISO 8601 timestamp of the most recent message, or `null` if no messages |
| `error` | `Error \| null` | Most recent error, or `null` |

### SSE Events

The hook connects to `GET /channels/:channelId/unread?participant_id=xxx` and handles three event types:

| Event | When | Effect |
|-------|------|--------|
| `unread_snapshot` | On initial connection | Sets `unreadCount` and `lastMessageAt` from server state |
| `unread_update` | New message from another participant | Increments `unreadCount`, updates `lastMessageAt` |
| `unread_clear` | Read cursor updated (via `POST /read` or join) | Sets `unreadCount` to server-provided value |

### Behavior

- **AppState handling:** Disconnects on background, reconnects on foreground (same pattern as `useChat`)
- **State reset:** When `channelId` or `participantId` changes, state resets to zero before the new connection delivers a fresh snapshot
- **Auto-mark-read integration:** When the user opens the chat (via `useChat`), the join handler marks messages as read server-side. The next time `useUnread` reconnects, the snapshot reflects count `0`.

### Example

```typescript
import { useUnread, createManifest } from '@pedi/chika-sdk';

const config = { manifest: createManifest('https://chat.example.com') };

function ChatListItem({ channelId, userId }) {
  const { hasUnread, unreadCount } = useUnread({
    config,
    channelId,
    participantId: userId,
  });

  return (
    <Pressable onPress={() => navigate('Chat', { channelId })}>
      <Text>{channelId}</Text>
      {hasUnread && <Badge count={unreadCount} />}
    </Pressable>
  );
}
```

---

## createSSEConnection

```typescript
function createSSEConnection(
  config: SSEConnectionConfig,
  callbacks: SSEConnectionCallbacks
): SSEConnection
```

Low-level SSE connection utility. Handles EventSource lifecycle, automatic reconnection with exponential backoff, heartbeat keep-alive, and error/410 detection. Used internally by `createChatSession` and `useUnread`. Available for custom SSE integrations.

### SSEConnectionConfig

```typescript
interface SSEConnectionConfig {
  url: string;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  lastEventId?: string;
  customEvents?: string[];
  networkMonitor?: NetworkMonitor;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | **Required** | SSE endpoint URL |
| `headers` | `Record<string, string>` | `undefined` | Custom headers (auth, etc.) |
| `reconnectDelayMs` | `number` | `3000` | Delay before reconnection attempt |
| `lastEventId` | `string` | `undefined` | Initial `Last-Event-ID` for resumption |
| `customEvents` | `string[]` | `[]` | Additional SSE event types to listen for (beyond `message`) |
| `networkMonitor` | `NetworkMonitor` | `undefined` | Network monitor for intelligent reconnection. Waits for online before reconnecting. |

### SSEConnectionCallbacks

```typescript
interface SSEConnectionCallbacks {
  onOpen?: () => void;
  onEvent: (eventType: string, data: string, lastEventId?: string) => void;
  onError?: (error: Error) => void;
  onClosed?: () => void;
  onReconnecting?: () => void;
}
```

| Callback | Description |
|----------|-------------|
| `onOpen` | SSE connection established |
| `onEvent` | Any SSE event received — `eventType` is `'message'` or one of `customEvents` |
| `onError` | Connection error (non-410) |
| `onClosed` | Channel permanently closed (410 detected) — no reconnection attempted |
| `onReconnecting` | Reconnection scheduled after error/close |

### SSEConnection

```typescript
interface SSEConnection {
  close: () => void;
  reconnectImmediate: () => void;
}
```

| Method | Description |
|--------|-------------|
| `close()` | Terminate the connection and prevent further reconnection attempts |
| `reconnectImmediate()` | Close the current connection and reconnect immediately, resetting the backoff counter |

---

## createChatSession\<D\>

```typescript
function createChatSession<D extends ChatDomain = DefaultDomain>(
  config: ChatConfig,
  channelId: string,
  profile: Participant<D>,
  callbacks: SessionCallbacks<D>,
  networkMonitor?: NetworkMonitor
): Promise<ChatSession<D>>
```

Lower-level imperative API for creating a chat session outside of React. Used internally by `useChat` and available for non-React integrations (e.g. background services, testing). Optionally accepts a custom `NetworkMonitor` for intelligent reconnection and offline detection.

### SessionCallbacks

```typescript
interface SessionCallbacks<D extends ChatDomain = DefaultDomain> {
  onMessage: (message: Message<D>) => void;
  onStatusChange: (status: ChatStatus) => void;
  onError: (error: Error) => void;
  onResync: () => void;
}
```

| Callback | Description |
|----------|-------------|
| `onMessage` | Called for each new message received via SSE |
| `onStatusChange` | Called when connection status changes |
| `onError` | Called on connection or send errors |
| `onResync` | Called when the server sends a `resync` event (client should re-fetch state) |

### ChatSession

```typescript
interface ChatSession<D extends ChatDomain = DefaultDomain> {
  serviceUrl: string;
  channelId: string;
  initialParticipants: Participant<D>[];
  initialMessages: Message<D>[];
  networkMonitor: NetworkMonitor | null;
  sendMessage: (
    type: D['messageType'],
    body: string,
    attributes?: MessageAttributes<D>,
    idempotencyKey?: string
  ) => Promise<SendMessageResponse>;
  markAsRead: (messageId: string) => Promise<void>;
  disconnect: () => void;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `serviceUrl` | `string` | The resolved server URL (from manifest bucket routing) |
| `channelId` | `string` | Channel ID |
| `initialParticipants` | `Participant<D>[]` | Participants returned by the join endpoint |
| `initialMessages` | `Message<D>[]` | Recent messages returned by the join endpoint |
| `networkMonitor` | `NetworkMonitor \| null` | The network monitor instance, if provided |
| `sendMessage` | `function` | Send a message to the channel. Optional `idempotencyKey` enables server-side deduplication on retries. |
| `markAsRead` | `(messageId: string) => Promise<void>` | Mark messages as read up to the given message ID. Throws on server error. |
| `disconnect` | `() => void` | Close the SSE connection |

### Example

```typescript
import { createChatSession, createManifest } from '@pedi/chika-sdk';
import type { PediChat } from '@pedi/chika-types';

const session = await createChatSession<PediChat>(
  {
    manifest: createManifest('https://chat.example.com'),
    headers: { Authorization: `Bearer ${token}` },
  },
  'booking_123',
  { id: 'user_1', role: 'rider', name: 'Juan' },
  {
    onMessage: (msg) => console.log('New:', msg.body),
    onStatusChange: (status) => console.log('Status:', status),
    onError: (err) => console.error('Error:', err),
    onResync: () => console.log('Server requested resync'),
  },
);

console.log('History:', session.initialMessages.length, 'messages');
console.log('Participants:', session.initialParticipants.map(p => p.name));

await session.sendMessage('chat', 'Hello from imperative API!');

// Later...
session.disconnect();
```

---

## resolveServerUrl

```typescript
function resolveServerUrl(manifest: ChatManifest, channelId: string): string
```

Resolves a server URL from a manifest using hash-based bucket routing.

**Hash algorithm:** Sum of all character codes in `channelId`, modulo 100. The resulting number (0-99) is matched against bucket ranges.

```typescript
import { resolveServerUrl } from '@pedi/chika-sdk';

const manifest: ChatManifest = {
  buckets: [
    { group: 'us-east', range: [0, 49], server_url: 'https://chat-us-east.example.com' },
    { group: 'us-west', range: [50, 99], server_url: 'https://chat-us-west.example.com' },
  ],
};

const url = resolveServerUrl(manifest, 'booking_123');
// Hashes to a number 0-99, returns the matching server URL
```

Throws an error if no bucket matches the computed hash.

---

## createManifest

```typescript
function createManifest(serverUrl: string): ChatManifest
```

Helper to create a single-server manifest that covers the full hash range (0-99). Use this when you have a single chat server.

```typescript
import { createManifest } from '@pedi/chika-sdk';

const manifest = createManifest('https://chat.example.com');
// {
//   buckets: [
//     { group: 'default', range: [0, 99], server_url: 'https://chat.example.com' }
//   ]
// }
```

---

## ChatDisconnectedError

```typescript
class ChatDisconnectedError extends Error {
  status: ChatStatus;
}
```

Thrown when `sendMessage` is called while the chat session is not connected.

| Property | Type | Description |
|----------|------|-------------|
| `status` | `ChatStatus` | The current connection status at the time of the error |
| `message` | `string` | `"Cannot send message: chat is <status>"` |

```typescript
try {
  await sendMessage('chat', 'Hello');
} catch (err) {
  if (err instanceof ChatDisconnectedError) {
    if (err.status === 'reconnecting') {
      showToast('Reconnecting, please wait...');
    } else {
      showToast('Disconnected from chat');
    }
  }
}
```

---

## ChannelClosedError

```typescript
class ChannelClosedError extends Error {
  channelId: string;
}
```

Thrown when the server returns HTTP 410 (Gone), indicating the channel has been permanently closed.

| Property | Type | Description |
|----------|------|-------------|
| `channelId` | `string` | The closed channel's ID |
| `message` | `string` | `"Channel <channelId> is closed"` |

```typescript
if (error instanceof ChannelClosedError) {
  navigation.goBack();
  showAlert('This conversation has ended.');
}
```

---

## HttpError

```typescript
class HttpError extends Error {
  status: number;
  body: string;
  retryAfter?: number;
}
```

Thrown on non-OK HTTP responses (status < 200 or >= 300). Structured status allows retry classification. `retryAfter` is parsed from the `Retry-After` response header (in seconds) when present.

| Property | Type | Description |
|----------|------|-------------|
| `status` | `number` | HTTP status code |
| `body` | `string` | Response body text |
| `retryAfter` | `number \| undefined` | Seconds to wait before retry (from `Retry-After` header) |
| `message` | `string` | `"HTTP <status>: <body>"` |

```typescript
try {
  await sendMessage('chat', 'Hello');
} catch (err) {
  if (err instanceof HttpError) {
    if (err.status === 429) {
      const delayMs = (err.retryAfter ?? 60) * 1000;
      showToast(`Rate limited. Retry after ${delayMs}ms`);
    } else if (err.status >= 500) {
      showToast('Server error. Retrying...');
    }
  }
}
```

---

## RetryExhaustedError

```typescript
class RetryExhaustedError extends Error {
  operation: string;
  attempts: number;
  lastError: Error;
}
```

Thrown when all retry attempts are exhausted. Contains the number of attempts and the last error encountered.

| Property | Type | Description |
|----------|------|-------------|
| `operation` | `string` | Description of the operation that failed |
| `attempts` | `number` | Number of attempts made |
| `lastError` | `Error` | The final error that caused exhaustion |
| `message` | `string` | `"<operation> failed after <attempts> attempts: <lastError.message>"` |

---

## QueueFullError

```typescript
class QueueFullError extends Error {
  maxSize: number;
}
```

Thrown when the offline message queue is at capacity and `sendMessage` is called while offline.

| Property | Type | Description |
|----------|------|-------------|
| `maxSize` | `number` | Maximum queue size |
| `message` | `string` | `"Message queue full (max <maxSize>)"` |

```typescript
try {
  await sendMessage('chat', 'Hello');
} catch (err) {
  if (err instanceof QueueFullError) {
    showToast(`Queue full (max ${err.maxSize} pending). Cancel some messages.`);
  }
}
```

---

## Configuration Types

### ChatConfig

```typescript
interface ChatConfig {
  manifest: ChatManifest;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  backgroundGraceMs?: number;
  optimisticSend?: boolean;
  resilience?: ResilienceConfig | false;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `manifest` | `ChatManifest` | **Required** | Server routing manifest. Use `createManifest()` for single-server setups. |
| `headers` | `Record<string, string>` | `undefined` | Custom headers sent with all HTTP and SSE requests (e.g. auth tokens) |
| `reconnectDelayMs` | `number` | `3000` | Milliseconds to wait before attempting SSE reconnection |
| `backgroundGraceMs` | `number` | `2000` (Android) / `0` (iOS) | Milliseconds to wait before tearing down connection when app backgrounds |
| `optimisticSend` | `boolean` | `true` | If `true`, messages are appended to the local `messages` array immediately on send, before server confirmation |
| `resilience` | `ResilienceConfig \| false` | `undefined` | Network resilience options. Enabled by default. Set `false` to disable all. |

### ResilienceConfig

```typescript
interface ResilienceConfig {
  retry?: Partial<RetryConfig> | false;
  offlineQueue?: boolean;
  maxQueueSize?: number;
  networkMonitor?: NetworkMonitor;
  queueStorage?: QueueStorage;
}
```

Controls retry, offline queuing, and network monitoring behavior.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `retry` | `Partial<RetryConfig> \| false` | `RetryConfig defaults` | Retry configuration. Set `false` to disable retries. Partial config merges with defaults. |
| `offlineQueue` | `boolean` | `true` | Enable offline message queuing. When offline, messages queue locally and send when online. |
| `maxQueueSize` | `number` | `50` | Maximum queued messages. Older messages are dropped if limit exceeded. |
| `networkMonitor` | `NetworkMonitor` | `auto-detect` | Custom network monitor. By default, uses `@react-native-community/netinfo` if available. |
| `queueStorage` | `QueueStorage` | `auto-detect` | Persistent storage adapter. By default, auto-detects MMKV > AsyncStorage > null. |

**Toggle semantics:**
- Omit `resilience` — Full defaults (retry + offline queue enabled)
- `resilience: false` — Disable all resilience (no retries, no queuing)
- `resilience: { retry: false }` — Enable queuing only, disable retries
- `resilience: { offlineQueue: false }` — Enable retries only, disable queuing

### RetryConfig

```typescript
interface RetryConfig {
  maxAttempts: number;    // default: 3
  baseDelayMs: number;    // default: 1000
  maxDelayMs: number;     // default: 10000
  jitterFactor: number;   // default: 0.3
}
```

Configures exponential backoff retry behavior.

| Field | Type | Description |
|-------|------|-------------|
| `maxAttempts` | `number` | Total attempts (1 initial + retries). Default: 3 (1 initial + 2 retries). |
| `baseDelayMs` | `number` | Initial delay between retries. Doubles for each attempt up to `maxDelayMs`. |
| `maxDelayMs` | `number` | Maximum delay between attempts. Prevents excessively long waits. |
| `jitterFactor` | `number` | Random jitter (0.3 = ±30%). Prevents thundering herd on recovery. |

**Backoff formula:** `delay = min(baseDelayMs * 2^attempt, maxDelayMs) * (1 ± jitter)`

### QueuedMessage

```typescript
interface QueuedMessage {
  optimisticId: string;
  status: MessageSendStatus;  // 'sending' | 'queued' | 'failed'
  error?: Error;
  retryCount: number;
}
```

Per-message send status in the offline queue.

| Field | Type | Description |
|-------|------|-------------|
| `optimisticId` | `string` | Unique ID for this message. Provided to `cancelMessage()` and `retryMessage()`. |
| `status` | `MessageSendStatus` | Current send state: `'sending'` (in-flight), `'queued'` (waiting), `'failed'` (error). |
| `error` | `Error \| undefined` | Last error if status is `'failed'`. |
| `retryCount` | `number` | Number of times this message has been retried. |

### QueueStorage

```typescript
interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

Async key-value storage adapter for persisting offline queue across app restarts.

| Method | Description |
|--------|-------------|
| `getItem(key)` | Retrieve a value by key. Returns `null` if not found. |
| `setItem(key, value)` | Store a string value. |
| `removeItem(key)` | Delete a key. |

### NetworkMonitor

```typescript
interface NetworkMonitor {
  isConnected(): boolean;
  subscribe(cb: (connected: boolean) => void): () => void;
  waitForOnline(signal?: AbortSignal): Promise<void>;
  dispose(): void;
}
```

Detects network connectivity state and notifies listeners of changes.

| Method | Description |
|--------|-------------|
| `isConnected()` | Return `true` if currently online, `false` if offline. |
| `subscribe(cb)` | Register a callback fired when connectivity changes. Returns an unsubscribe function. |
| `waitForOnline(signal?)` | Return a promise that resolves when online. Rejects if `signal` is aborted. |
| `dispose()` | Clean up listeners and stop monitoring. |

---

## withRetry

```typescript
function withRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  signal?: AbortSignal
): Promise<T>
```

Executes a promise-returning function with exponential backoff retry and jitter. Retries only on classified retryable errors (network failures, 5xx, 408, 429). Respects `Retry-After` headers from 429 responses.

| Parameter | Type | Description |
|-----------|------|-------------|
| `fn` | `() => Promise<T>` | Function to execute and retry |
| `config` | `RetryConfig` | Retry configuration. Defaults to `DEFAULT_RETRY_CONFIG`. |
| `signal` | `AbortSignal` | Abort signal. Rejects promise if aborted. |

**Returns:** `Promise<T>` resolving to the function's return value on success.

**Throws:** `RetryExhaustedError` if all attempts fail, or the last non-retryable error.

```typescript
import { withRetry } from '@pedi/chika-sdk';

const data = await withRetry(
  async () => {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  { maxAttempts: 5, baseDelayMs: 500 }
);
```

---

## isRetryableError

```typescript
function isRetryableError(error: unknown): boolean
```

Classifies an error as retryable. Returns `true` for network failures, 5xx status, 408 (Request Timeout), 429 (Too Many Requests), and `TypeError` from fetch. Returns `false` for `ChatDisconnectedError`, `ChannelClosedError`, `QueueFullError`, and `AbortError`.

```typescript
import { isRetryableError, HttpError } from '@pedi/chika-sdk';

try {
  await someOperation();
} catch (err) {
  if (isRetryableError(err)) {
    console.log('Will be retried automatically');
  } else if (err instanceof HttpError && err.status === 401) {
    console.log('Auth error — refresh token');
  }
}
```

---

## createNetworkMonitor

```typescript
function createNetworkMonitor(): NetworkMonitor
```

Creates a network monitor that detects online/offline state. On React Native, integrates with `@react-native-community/netinfo` if available. On other platforms, returns a stub that always reports online.

**Returns:** `NetworkMonitor` instance.

```typescript
import { createNetworkMonitor, createChatSession } from '@pedi/chika-sdk';

const networkMonitor = createNetworkMonitor();

const session = await createChatSession(config, channelId, profile, callbacks, networkMonitor);

// Later...
networkMonitor.dispose();
```

---

## createQueueStorage

```typescript
function createQueueStorage(): QueueStorage | null
```

Auto-detects and returns the best available persistent storage for queue persistence. Priority: `react-native-mmkv` (fastest, synchronous) > `@react-native-async-storage/async-storage` > `null`.

Returns `null` if neither storage backend is installed — the SDK continues to work, queuing only in memory (lost on app restart).

**Returns:** `QueueStorage` instance or `null` if no storage available.

```typescript
import { createQueueStorage } from '@pedi/chika-sdk';

const storage = createQueueStorage();
// storage is QueueStorage | null

const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {
    queueStorage: storage ?? undefined,
  },
};
```

---

## createAsyncStorageAdapter

```typescript
function createAsyncStorageAdapter(): QueueStorage | null
```

Explicitly creates a `QueueStorage` adapter backed by `@react-native-async-storage/async-storage`. Returns `null` if the package is not installed.

Use this if you want to force AsyncStorage even if MMKV is available, or if you manage storage installation yourself.

**Returns:** `QueueStorage` instance or `null` if package not installed.

```typescript
import { createAsyncStorageAdapter } from '@pedi/chika-sdk';

const asyncStorage = createAsyncStorageAdapter();
if (!asyncStorage) {
  console.warn('@react-native-async-storage/async-storage not installed');
}
```

---

### ChatStatus

```typescript
type ChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed' | 'error';
```

| Status | Description |
|--------|-------------|
| `connecting` | Initial connection in progress (join + SSE setup) |
| `connected` | SSE stream is active and receiving events |
| `reconnecting` | Connection lost; waiting `reconnectDelayMs` before retry |
| `disconnected` | Manually disconnected via `disconnect()` or app backgrounded |
| `closed` | Channel is permanently closed (HTTP 410). Cannot reconnect. |
| `error` | An unrecoverable error occurred |
