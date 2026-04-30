# @pedi/chika-sdk

React Native SDK for real-time chat over Server-Sent Events (SSE).

## What It Does

Provides a drop-in React hook (`useChat`) that connects your React Native app to a Chika chat server. Handles the entire chat lifecycle — joining a channel, streaming messages in real-time, sending messages, reconnecting on network loss, and cleaning up when the component unmounts or the app backgrounds.

## Problems It Solves

- **SSE in React Native** — Wraps `react-native-sse` with proper lifecycle management so you don't have to manually open/close connections
- **Reconnection and gap-fill** — Automatically reconnects when the network drops and replays missed messages using `Last-Event-ID`, so conversations never have gaps
- **AppState-aware lifecycle** — Tears down connections when the app backgrounds and reconnects when it returns, with platform-specific handling (Android grace period for keyboard/dialog triggers)
- **Message deduplication** — Prevents duplicate messages from SSE echo and reconnection replays
- **Optimistic UI** — Messages appear in the local list instantly on send, before server confirmation
- **Type-safe chat domains** — Full generic support via `ChatDomain` so message types, roles, and attributes are enforced at compile time
- **Automatic retry on failure** — Failed message sends are automatically retried with exponential backoff before giving up
- **Offline message queuing** — Messages sent while offline are queued and flushed when connectivity returns
- **Network-aware reconnection** — SSE reconnection waits for network availability and uses exponential backoff instead of fixed delays

## Key Features

- `useChat<D>()` React hook with full TypeScript generics
- `createChatSession<D>()` imperative API for non-React usage
- **`useUnread()` hook** — Real-time unread count tracking via dedicated SSE stream with passive listening support
- Automatic SSE reconnection with configurable delay
- Platform-aware AppState handling (iOS vs Android)
- Optimistic message sending with deduplication
- Hash-based bucket routing for multi-server deployments
- Custom error classes (`ChatDisconnectedError`, `ChannelClosedError`, `HttpError`, `RetryExhaustedError`, `QueueFullError`, `SendTimeoutError`)
- Per-request send timeout via `sendTimeoutMs` (default 15 s) so weak-signal sends never hang indefinitely
- Network resilience with automatic retry (exponential backoff, jitter, 429 Retry-After support)
- Offline message queue with per-message status tracking (`sending`, `queued`, `failed`)
- Optional `@react-native-community/netinfo` integration for network-aware reconnection
- Persistent queue storage via auto-detected MMKV or AsyncStorage
- Server-side idempotency keys to prevent duplicate messages on retry
- Per-message `cancelMessage()` and `retryMessage()` controls
- All resilience features togglable — set `resilience: false` to disable

## Quick Start

```typescript
import { useChat, createManifest } from '@pedi/chika-sdk';
import type { PediChat } from '@pedi/chika-types';

function ChatScreen({ bookingId, user }) {
  const { messages, status, sendMessage } = useChat<PediChat>({
    config: {
      manifest: createManifest('https://chat.example.com'),
      headers: { Authorization: `Bearer ${token}` },
    },
    channelId: `booking_${bookingId}`,
    profile: { id: user.id, role: 'rider', name: user.name },
  });

  await sendMessage('chat', 'Hello!', { device: 'ios' });
}
```

### Unread Notifications

Monitor unread message counts in real-time — even for channels the user hasn't joined yet:

```typescript
import { useUnread } from '@pedi/chika-sdk';

function ChatListItem({ channelId, userId, config }) {
  const { unreadCount, hasUnread, lastMessageAt } = useUnread({
    config,
    channelId,
    participantId: userId,
  });

  return (
    <View>
      <Text>{channelId}</Text>
      {hasUnread && <Badge count={unreadCount} />}
    </View>
  );
}
```

The hook handles SSE reconnection and AppState-aware lifecycle management automatically. Disable it with `enabled: false` when `useChat` is already active on the same channel.

### Network Resilience

Resilience features automatically handle failures, offline scenarios, and network transitions:

```typescript
import { useChat, createManifest, createQueueStorage } from '@pedi/chika-sdk';

function ChatScreen({ bookingId, user }) {
  const {
    messages, status, sendMessage,
    pendingMessages, cancelMessage, retryMessage,
  } = useChat<PediChat>({
    config: {
      manifest: createManifest('https://chat.example.com'),
      headers: { Authorization: `Bearer ${token}` },
      resilience: {
        retry: { maxAttempts: 5 },
        queueStorage: createQueueStorage() ?? undefined,
      },
    },
    channelId: `booking_${bookingId}`,
    profile: { id: user.id, role: 'rider', name: user.name },
  });

  // Messages queue automatically when offline, retry on failure
  await sendMessage('chat', 'Hello!');

  // Show per-message status in UI
  for (const msg of pendingMessages) {
    if (msg.status === 'failed') {
      // Show retry/cancel buttons
      retryMessage(msg.optimisticId);
      // or: cancelMessage(msg.optimisticId);
    }
  }
}
```

Resilience is enabled by default. Disable with `resilience: false` for manual control.

### Send Failure Contract

When resilience is enabled (the default), a failed `sendMessage` call leaves the optimistic message visible in `messages` and surfaces the failure via `pendingMessages[i].status === 'failed'`. Render that state in your UI and wire `retryMessage(optimisticId)` / `cancelMessage(optimisticId)` to user actions. Applies to `RetryExhaustedError`, `HttpError` (non-retryable), `SendTimeoutError`, `AbortError`, and any future post-enqueue error class.

The exceptions are:

- **`ChatDisconnectedError` (synchronous, no session yet)** — thrown directly from `sendMessage` before any optimistic insertion. The SDK has nothing to attach to. Callers must keep a tiny shadow queue in their own state and drain it once `status === 'connected'`.
- **`QueueFullError`** — thrown synchronously from `enqueue()` when at `maxQueueSize`. The optimistic insertion is rolled back; show a "queue full" message and let the user retry later.
- **`resilience: false` mode** — there is no `pendingMessages` tracking, so the SDK falls back to removing the optimistic on error. Callers in this mode are responsible for their own failure UX.

### Consumer Obligations

When wiring `useChat` into a UI, the consumer is responsible for:

- Rendering `pendingMessages` to show retrying / failed bubbles. The SDK provides the state; the consumer renders it.
- Wiring retry/cancel UI to `retryMessage(optimisticId)` / `cancelMessage(optimisticId)`.
- Handling synchronous `ChatDisconnectedError` from `sendMessage` — typically with a shadow queue that drains on the next `'connected'` status.
- Avoiding `optimisticSend: false` if the rendering pipeline relies on a `pendingByOptimisticId` join keyed by `messages[i].id`.
- Treating the SDK-issued `messageKey` as both the optimistic id and the server idempotency key — never synthesize your own.

**Peer dependencies:** `react >= 18`, `react-native >= 0.72`

**Optional peer dependencies:** `@react-native-community/netinfo` (network monitoring), `react-native-mmkv` or `@react-native-async-storage/async-storage` (queue persistence)

## Documentation

See the [docs](./docs/) for detailed documentation:

- [API Reference](./docs/api-reference.md) — `useChat`, `createChatSession`, utilities, error classes, and all config options
- [Guides](./docs/guides.md) — Connection lifecycle, AppState handling, reconnection, deduplication, custom domains
- [Network Resilience Guide](./docs/resilience-guide.md) — Retry, offline queue, network monitoring, persistent storage, and configuration
- [AI Agent Integration Guide](./docs/llm-integration-guide.md) — Patterns, recipes, pitfalls, and checklists for LLM-assisted implementation
