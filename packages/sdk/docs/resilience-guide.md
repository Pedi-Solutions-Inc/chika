# Network Resilience Guide

In-depth guide for the SDK's built-in network resilience features — automatic retry, offline message queuing, network monitoring, and persistent storage.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Retry Behavior](#retry-behavior)
- [Offline Message Queue](#offline-message-queue)
- [Network Monitoring](#network-monitoring)
- [Persistent Storage](#persistent-storage)
- [Per-Message Status](#per-message-status)
- [Idempotency](#idempotency)
- [Error Handling with Resilience](#error-handling-with-resilience)
- [Disabling Resilience](#disabling-resilience)
- [Known Limitations](#known-limitations)

---

## Overview

The SDK includes built-in resilience for unreliable mobile networks. All resilience features are **enabled by default** and can be toggled via `ChatConfig.resilience`.

Resilience covers:

1. **Automatic Retry** — Failed requests (network errors, 5xx, 408, 429) are retried with exponential backoff.
2. **Offline Message Queue** — Messages sent while offline are queued locally and sent when connectivity returns.
3. **Network Monitoring** — The SDK tracks network connectivity state and gates queue draining on actual connectivity.
4. **Persistent Storage** — Queued messages can survive app restarts via AsyncStorage or MMKV.
5. **Per-Message Status** — UI can track sending/queued/failed state for each message via `pendingMessages`.
6. **Idempotency** — Each message is assigned a unique key, preventing duplicate inserts on retry.

---

## Configuration

Resilience is configured via the `resilience` property in `ChatConfig`. You can enable all features (default), disable all, or granularly control each one.

### Default Behavior (All Features On)

```typescript
const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  // resilience: undefined — all features enabled with defaults
};
```

### Disable All Resilience

```typescript
const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: false, // Behaves exactly as before resilience was added
};
```

### Granular Control

```typescript
const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {
    retry: { maxAttempts: 5, baseDelayMs: 500 }, // Custom retry
    offlineQueue: true,                            // Keep queue on
    maxQueueSize: 100,                             // Larger queue
    networkMonitor: myCustomMonitor,               // Custom connectivity tracking
    queueStorage: createQueueStorage() ?? undefined, // Persistent storage
  },
};
```

### ResilienceConfig Interface

```typescript
interface ResilienceConfig {
  /** Retry config overrides. Set false to disable retry entirely. */
  retry?: Partial<RetryConfig> | false;

  /** Enable offline message queuing. Default: true. */
  offlineQueue?: boolean;

  /** Max queued messages. Default: 50. */
  maxQueueSize?: number;

  /** Inject custom NetworkMonitor (bypasses built-in NetInfo detection). */
  networkMonitor?: NetworkMonitor;

  /** Persistent storage adapter for queue (AsyncStorage/MMKV/etc). */
  queueStorage?: QueueStorage;
}

interface RetryConfig {
  maxAttempts: number;           // Default: 3
  baseDelayMs: number;           // Default: 1000
  maxDelayMs: number;            // Default: 10000
  jitterFactor: number;          // Default: 0.3
}
```

### Full Example

```typescript
import { useChat, createManifest, createQueueStorage } from '@pedi/chika-sdk';

const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {
    retry: { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10000, jitterFactor: 0.3 },
    offlineQueue: true,
    maxQueueSize: 100,
    queueStorage: createQueueStorage() ?? undefined,
  },
};

function ChatScreen() {
  const {
    messages,
    sendMessage,
    pendingMessages,
    retryMessage,
    cancelMessage,
  } = useChat({
    config,
    channelId: 'chat_123',
    profile: { id: 'user_1', name: 'Alice', role: 'driver' },
  });

  // Use pendingMessages to show retry/cancel UI
  return (
    <View>
      {messages.map(msg => <MessageItem key={msg.id} message={msg} />)}
      {pendingMessages.map(pm => (
        <PendingMessageItem
          key={pm.optimisticId}
          status={pm.status}
          error={pm.error}
          onRetry={() => retryMessage(pm.optimisticId)}
          onCancel={() => cancelMessage(pm.optimisticId)}
        />
      ))}
    </View>
  );
}
```

---

## Retry Behavior

The SDK automatically retries failed requests using exponential backoff with jitter. Retry is applied to:

- `POST /channels/{channelId}/join` — Join request
- `POST /channels/{channelId}/messages` — Send message
- `POST /channels/{channelId}/read` — Mark as read (limited retries)

### Exponential Backoff Formula

```
delay = min(baseDelay * 2^attempt, maxDelay) * jitter

where jitter ∈ [0.7, 1.3]
```

**Example with defaults** (baseDelay: 1000ms, maxDelay: 10000ms):

| Attempt | Calculated Delay | Min Jitter | Max Jitter |
|---------|------------------|-----------|-----------|
| 0       | 1000ms           | 700ms     | 1300ms    |
| 1       | 2000ms           | 1400ms    | 2600ms    |
| 2       | 4000ms           | 2800ms    | 5200ms    |

After 3 attempts, a `RetryExhaustedError` is thrown (configurable).

### Retryable vs Non-Retryable Errors

**Retryable errors** (automatically retried):
- `TypeError` — Network failure (fetch error)
- `408` (Request Timeout)
- `429` (Too Many Requests) — Respects `Retry-After` header
- `5xx` (Server Errors)

**Non-retryable errors** (thrown immediately):
- `400`-`499` (Client errors, except 408 and 429)
- `ChannelClosedError` (410 response)
- `ChatDisconnectedError` (no active session)
- `QueueFullError` (queue at capacity)
- `AbortError` (request was cancelled)

### Retry-After Header

For 429 (Too Many Requests) responses, the SDK respects the `Retry-After` header if present:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 30

// SDK will wait 30 seconds before retry, instead of exponential backoff
```

### Mark As Read Retry Config

The `markAsRead` operation uses a lower retry configuration (best-effort):

```
maxAttempts: 2
baseDelayMs: 500
maxDelayMs: 2000
jitterFactor: 0.3
```

If `markAsRead` fails after 2 attempts, the error is logged but not thrown (fire-and-forget).

### SSE Reconnection Backoff

When the SSE connection drops, the SDK reconnects using exponential backoff:

```
baseDelay: 3000ms (configurable via reconnectDelayMs)
maxDelay: 30000ms
jitterFactor: 0.3
```

The SDK waits for network connectivity before attempting reconnection (see [Network Monitoring](#network-monitoring)).

---

## Offline Message Queue

When the network is unavailable, the SDK queues outgoing messages locally. The queue survives session disconnections and React Navigation stack transitions, but is lost on app kill (unless persistent storage is configured).

### How It Works

1. User sends a message via `sendMessage()`
2. If the network is unavailable, the message is enqueued with status `'queued'`
3. The optimistic message appears in the UI (if `optimisticSend: true`)
4. When network connectivity returns, queued messages are sent in order with retry
5. On success, the message is removed from the queue
6. On failure, the message is marked `'failed'` and can be manually retried or cancelled

### Queue Configuration

```typescript
resilience: {
  offlineQueue: true,      // Enable/disable queuing (default: true)
  maxQueueSize: 50,        // Max queued messages (default: 50)
}
```

Attempting to enqueue a message when the queue is full throws `QueueFullError`:

```typescript
try {
  await sendMessage('chat', 'Hello');
} catch (err) {
  if (err instanceof QueueFullError) {
    showAlert('Too many pending messages — please wait');
  }
}
```

### Queue Lifetime

**Queue survives:**
- Session disconnect/reconnect on background
- Component remount (e.g., React Navigation navigation)
- AppState transitions (background → foreground)

**Queue is lost on:**
- App kill (unless `queueStorage` is configured)
- Explicit `disconnect()` call (queue is cleared)

### Drain Behavior

The queue drains (sends messages) when:

1. Network connectivity is `true` (from the `NetworkMonitor`)
2. Status is not `'disconnected'` or `'error'`

**Important:** The queue is gated on `NetworkMonitor.isConnected()`, not just raw fetch success. This prevents queuing on networks that appear connected but don't have internet (e.g., captive WiFi).

### Queue Interaction with Optimistic Send

If `optimisticSend: true`, messages appear in the UI immediately:

1. Message is added to `messages` array with optimistic ID
2. Message is enqueued with status `'sending'`/`'queued'`
3. `pendingMessages` tracks the queue entry

If the send succeeds, the optimistic message is updated with the server ID. If it fails, the message remains in the array (tracked in `pendingMessages` with status `'failed'`) and can be retried or cancelled.

---

## Network Monitoring

The SDK can track network connectivity using `@react-native-community/netinfo` (optional peer dependency). This ensures the queue drains only when the device has actual internet access.

### Auto-Detection

The SDK automatically detects `@react-native-community/netinfo` via lazy require:

```typescript
// If netinfo is installed, the SDK uses it
// If not, the SDK falls back to a stub monitor (always online)
```

### Custom Monitor Injection

Inject a custom `NetworkMonitor` to bypass auto-detection:

```typescript
import type { NetworkMonitor } from '@pedi/chika-sdk';

const myMonitor: NetworkMonitor = {
  isConnected: () => /* your logic */,
  subscribe: (cb) => {
    // Subscribe to connectivity changes
    // Return unsubscribe function
    return () => {};
  },
  waitForOnline: (signal?) => Promise.resolve(),
  dispose: () => {},
};

const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {
    networkMonitor: myMonitor,
  },
};
```

### NetworkMonitor Interface

```typescript
interface NetworkMonitor {
  /** Check if device is connected to the internet. */
  isConnected(): boolean;

  /** Subscribe to connectivity changes. Returns unsubscribe function. */
  subscribe(cb: (connected: boolean) => void): () => void;

  /** Wait for online state. Rejects if aborted. */
  waitForOnline(signal?: AbortSignal): Promise<void>;

  /** Cleanup. */
  dispose(): void;
}
```

### Auto-Rejoin on Connectivity

When network returns and the session is in `'error'` state, the SDK automatically attempts to rejoin:

```typescript
// Pseudo-code
if (networkMonitor.isConnected() && status === 'error') {
  startSession(); // Auto-rejoin attempt
}
```

### SSE Connection Waits for Network

The SSE connection respects network state:

```typescript
// When SSE drops:
// 1. Set status to 'reconnecting'
// 2. Call networkMonitor.waitForOnline()
// 3. Perform exponential backoff
// 4. Reconnect when network is online
```

### Independent Monitors for useChat and useUnread

By default, `useChat` and `useUnread` each create independent `NetworkMonitor` instances if resilience is enabled. To share a single monitor:

```typescript
const sharedMonitor = createNetworkMonitor();

function App() {
  const chatConfig = {
    manifest: createManifest('https://chat.example.com'),
    resilience: { networkMonitor: sharedMonitor },
  };

  const unreadConfig = {
    manifest: createManifest('https://chat.example.com'),
    resilience: { networkMonitor: sharedMonitor },
  };

  return (
    <>
      <ChatScreen config={chatConfig} />
      <ChatListScreen config={unreadConfig} />
    </>
  );
}
```

---

## Persistent Storage

By default, the queue is in-memory and lost on app kill. To survive app restarts, configure `queueStorage` with a persistent adapter.

### Auto-Detection via createQueueStorage()

```typescript
import { createQueueStorage } from '@pedi/chika-sdk';

const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {
    queueStorage: createQueueStorage() ?? undefined,
  },
};
```

`createQueueStorage()` auto-detects (in priority order):

1. **react-native-mmkv** (fastest, synchronous)
2. **@react-native-async-storage/async-storage**
3. **null** (no storage, in-memory only)

All packages are optional peer dependencies — no hard requirements.

### Explicit AsyncStorage Adapter

```typescript
import { createAsyncStorageAdapter } from '@pedi/chika-sdk';

const adapter = createAsyncStorageAdapter(); // Returns null if AsyncStorage not installed

const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {
    queueStorage: adapter ?? undefined,
  },
};
```

### Custom Storage Adapter

Implement the `QueueStorage` interface for any storage backend:

```typescript
interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// Example: Custom storage backed by SQLite
const sqliteAdapter: QueueStorage = {
  getItem: async (key) => {
    const result = await db.query('SELECT value FROM queue_storage WHERE key = ?', [key]);
    return result[0]?.value ?? null;
  },
  setItem: async (key, value) => {
    await db.run('INSERT OR REPLACE INTO queue_storage (key, value) VALUES (?, ?)', [key, value]);
  },
  removeItem: async (key) => {
    await db.run('DELETE FROM queue_storage WHERE key = ?', [key]);
  },
};

const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: {
    queueStorage: sqliteAdapter,
  },
};
```

### Storage Restoration

On mount, the SDK attempts to restore queued messages from storage:

```typescript
// Pseudo-code
const restored = await storage.getItem('chika_queue_chat_123');
// restored = '[{"optimisticId": "optimistic_1234_abc5", "retryCount": 0}, ...]'
```

Restored entries are **fire-and-forget** — they are retried to send, but no promise is returned to the caller (the original `sendMessage()` caller is gone after app restart).

Success/failure is reported via SDK callbacks and the `error` field on `useChat`.

### Storage Failures

If persistent storage fails (read/write error), the SDK logs the error but continues with in-memory queuing. Storage is non-fatal.

```typescript
// If setItem() fails:
// 1. Error is passed to onError callback
// 2. Queue continues in-memory
// 3. Messages are not persisted
```

---

## Per-Message Status

The `pendingMessages` array on `UseChatReturn` tracks the status of each queued or failed message:

```typescript
interface QueuedMessage {
  optimisticId: string;         // The message's optimistic ID
  status: 'sending' | 'queued' | 'failed'; // Current state
  error?: Error;                // Error (if status === 'failed')
  retryCount: number;           // Number of retry attempts
}
```

### Message Lifecycle

```
1. User calls sendMessage('chat', 'Hello')
   ↓
2. Optimistic message added to UI (if optimisticSend: true)
   ↓
3. Message enqueued with status 'queued' (if offline) or 'sending' (if online)
   ↓
4a. Send succeeds → removed from queue, optimistic ID replaced with server ID
    ↓
    (Message appears with server ID in messages array)

4b. Send fails → status set to 'failed', error populated, retryCount incremented
    ↓
    (Message remains visible in UI via pendingMessages)
    ↓
    User can call retryMessage(optimisticId) to re-send
    or cancelMessage(optimisticId) to remove
```

### Example: Render Pending Message UI

```typescript
function ChatScreen() {
  const { messages, sendMessage, pendingMessages, retryMessage, cancelMessage } =
    useChat({ /* ... */ });

  return (
    <FlashList
      data={[...messages, ...pendingMessages]}
      renderItem={({ item }) => {
        if ('optimisticId' in item) {
          // It's a pending message from pendingMessages
          const pending = item as QueuedMessage;
          return (
            <View style={styles.messageBubble}>
              <Text>{pending.status === 'sending' ? 'Sending...' : 'Failed'}</Text>
              {pending.status === 'failed' && (
                <View style={styles.actions}>
                  <Pressable onPress={() => retryMessage(pending.optimisticId)}>
                    <Text>Retry</Text>
                  </Pressable>
                  <Pressable onPress={() => cancelMessage(pending.optimisticId)}>
                    <Text>Cancel</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        } else {
          // It's a server message from messages
          const msg = item as Message;
          return <MessageBubble message={msg} />;
        }
      }}
    />
  );
}
```

### Cancel Message

Cancel a queued or failed message by its optimistic ID:

```typescript
cancelMessage(optimisticId);
```

This:
1. Aborts any in-flight send request
2. Removes the message from the queue
3. Removes the optimistic message from the UI

### Retry Message

Retry a failed message:

```typescript
retryMessage(optimisticId);
```

This:
1. Changes the message's status from `'failed'` to `'queued'`
2. Clears the error field
3. Triggers queue flush
4. Message is re-sent with the same optimistic ID (and idempotency key)

---

## Idempotency

Each message is assigned a unique **idempotency key** to prevent duplicates when the client retries after network failure.

### Key Generation

```typescript
const messageKey = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
```

This combines:
- Current timestamp (`Date.now()` — millisecond precision)
- Random suffix (`Math.random().toString(36).slice(2, 7)` — base-36 string)

**Example:** `optimistic_1711274234567_a1b2c`

### Idempotency Scope

The idempotency key serves double duty:

1. **Optimistic message ID** — Used in the UI before server confirmation
2. **Server-side idempotency key** — Sent as `idempotency_key` in the request body

### Server-Side Enforcement

The server enforces idempotency via a sparse unique index on `(channel_id, idempotency_key)`:

```
// Pseudo-code: MongoDB
db.messages.createIndex(
  { channel_id: 1, idempotency_key: 1 },
  { sparse: true, unique: true }
);
```

When a duplicate request arrives with the same `idempotency_key`:
- If the message already exists, return the existing message (idempotent)
- If the insert fails due to unique constraint, reject the request

This prevents duplicate messages when the client retries after network failure or timeout.

### Retry Idempotency

When `retryMessage()` is called, the same `messageKey` (and `idempotency_key`) is reused:

```typescript
// First attempt
await sendMessage('chat', 'Hello');
// messageKey = 'optimistic_1711274234567_a1b2c'
// Request sent with idempotency_key: 'optimistic_1711274234567_a1b2c'

// Network timeout — message marked 'failed'

// User calls retryMessage('optimistic_1711274234567_a1b2c')
// Same messageKey is used, so same idempotency_key is sent
// Server recognizes the duplicate and returns the existing message
```

This is safe because the `doSend` closure reads `sessionRef.current`, so retries after reconnect use the healthy session.

### Entropy

The key has approximately **25.8 bits of entropy** (timestamp precision + random suffix). This is sufficient for per-channel scope where messages are rate-limited.

For example, if a channel receives 1000 messages per second, the birthday paradox suggests a collision probability of < 1 in a billion after 10,000 years of continuous service.

---

## Error Handling with Resilience

Resilience introduces new error types and conditions. Handle them appropriately in your UI.

### Error Types

```typescript
import {
  ChatDisconnectedError,
  ChannelClosedError,
  RetryExhaustedError,
  QueueFullError,
} from '@pedi/chika-sdk';

try {
  await sendMessage('chat', text);
} catch (err) {
  if (err instanceof RetryExhaustedError) {
    // All retry attempts failed
    // Message is marked 'failed' in pendingMessages
    // User can retryMessage() or cancelMessage()
    showAlert('Message failed to send. Please try again.');
  } else if (err instanceof QueueFullError) {
    // Queue is at capacity (max queue size exceeded)
    // Message was not queued
    showAlert('Too many pending messages. Please wait.');
  } else if (err instanceof ChatDisconnectedError) {
    // Not connected and queue not available
    // Session disconnected or not yet connected
    showAlert('No connection. Try again when online.');
  } else if (err instanceof ChannelClosedError) {
    // Channel is permanently closed
    navigation.goBack();
    showAlert('This conversation has ended.');
  } else {
    // Other errors (network, server, etc.)
    showAlert('Send failed: ' + err.message);
  }
}
```

### Pending Messages

When `RetryExhaustedError` is thrown, the message is NOT removed from the UI. Instead:

```typescript
// Message remains visible via pendingMessages with:
{
  optimisticId: 'optimistic_1711274234567_a1b2c',
  status: 'failed',
  error: RetryExhaustedError(...),
  retryCount: 3,
}
```

Users can:
- Call `retryMessage(id)` to retry
- Call `cancelMessage(id)` to remove

### Monitoring Status Changes

Track connection status to show appropriate UI:

```typescript
function ChatScreen() {
  const { status, error } = useChat({ /* ... */ });

  useEffect(() => {
    if (status === 'connecting') {
      showIndicator('Connecting...');
    } else if (status === 'connected') {
      hideIndicator();
    } else if (status === 'reconnecting') {
      showIndicator('Reconnecting...');
    } else if (status === 'error') {
      showAlert('Connection error: ' + error?.message);
    } else if (status === 'closed') {
      navigation.goBack();
    }
  }, [status, error]);
}
```

---

## Disabling Resilience

You can disable resilience entirely or granularly:

### Disable All

```typescript
const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  resilience: false, // Exact behavior before resilience was added
};
```

With `resilience: false`:
- No retry
- No offline queue
- No network monitoring
- No persistent storage
- All errors are thrown immediately

### Disable Retry Only

```typescript
resilience: {
  retry: false,        // Disable retry
  offlineQueue: true,  // Keep queue
}
```

### Disable Queue Only

```typescript
resilience: {
  retry: { maxAttempts: 3 },  // Keep retry
  offlineQueue: false,        // Disable queue
}
```

### Advanced: Direct API Usage

If you're not using `useChat`, you can use the retry utilities directly:

```typescript
import { withRetry, isRetryableError, DEFAULT_RETRY_CONFIG } from '@pedi/chika-sdk';

try {
  const result = await withRetry(
    () => fetch(...),
    { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10000, jitterFactor: 0.3 },
  );
} catch (err) {
  if (isRetryableError(err)) {
    // This error is retryable (network, 5xx, 408, 429)
  }
}
```

---

## Known Limitations

### Queue Persistence

- Queue is **in-memory by default** — lost on app kill
- Requires `queueStorage` configuration to survive restarts
- Restored entries are **fire-and-forget** — no promise returned to original caller

### Server-Side Idempotency

- Idempotency keys are **stored indefinitely** in the sparse index
- No expiry mechanism — old keys persist on the server
- Not a practical issue for most deployments, but worth noting for cleanup policies

### Network Monitor Independence

- `useChat` and `useUnread` create **independent monitors by default**
- Share via config injection to avoid duplicate connectivity tracking
- The stub monitor (when netinfo is not installed) always reports online

### Entropy

- Idempotency key has ~**25.8 bits of entropy**
- Sufficient for per-channel rate-limited scope
- Not suitable for globally unique IDs across all channels

### Queue Draining

- Queue drains when `NetworkMonitor.isConnected()` returns `true`
- If the app has a captive portal (appears online but no internet), messages won't send until portal is cleared
- No automatic timeout or fallback

### Restored Entries

- Messages restored from persistent storage after app kill have no associated caller promise
- Status changes are reported via `pendingMessages` and error callbacks
- Original `await sendMessage()` caller is already gone after app restart

---

## Best Practices

1. **Always configure `queueStorage`** if you want offline messages to survive app restarts:
   ```typescript
   resilience: {
     queueStorage: createQueueStorage() ?? undefined,
   }
   ```

2. **Share `NetworkMonitor` between hooks** if using both `useChat` and `useUnread`:
   ```typescript
   const monitor = createNetworkMonitor();
   // Pass to both useChat and useUnread via resilience config
   ```

3. **Handle `pendingMessages` in your UI** to show retry/cancel actions:
   ```typescript
   {pendingMessages.map(pm => (
     <PendingMessage
       key={pm.optimisticId}
       status={pm.status}
       onRetry={() => retryMessage(pm.optimisticId)}
       onCancel={() => cancelMessage(pm.optimisticId)}
     />
   ))}
   ```

4. **Monitor `status` changes** to show connection state to users:
   ```typescript
   useEffect(() => {
     if (status === 'reconnecting') showIndicator('Reconnecting...');
   }, [status]);
   ```

5. **Respect `Retry-After` headers** — the SDK handles this automatically, but be aware when implementing custom retry logic.

6. **Test offline behavior** using network throttling tools (Xcode Network Link Conditioner, Android Emulator) or by disabling network connectivity.
