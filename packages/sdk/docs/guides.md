# SDK Guides

In-depth guides for understanding how the SDK works under the hood.

## Table of Contents

- [Connection Lifecycle](#connection-lifecycle)
- [AppState Handling](#appstate-handling)
- [Reconnection and Gap-Fill](#reconnection-and-gap-fill)
- [Message Deduplication](#message-deduplication)
- [Optimistic Send](#optimistic-send)
- [Resync](#resync)
- [Custom Domains](#custom-domains)
- [Multi-Server Routing](#multi-server-routing)
- [Error Handling](#error-handling)

---

## Connection Lifecycle

When `useChat` mounts (or `createChatSession` is called), the following sequence occurs:

```
1. Resolve server URL from manifest (hash-based bucket routing)
2. POST /channels/{channelId}/join
   ├── Sends participant profile
   └── Receives: channel status, participants, recent messages
3. Open SSE connection to /channels/{channelId}/stream
4. Begin receiving real-time events:
   ├── message  → append to messages array
   ├── heartbeat → no-op (keeps connection alive)
   └── resync   → clear state, fire onResync callback
```

On unmount, if the connection is active, `markAsRead` is called with the last message ID (fire-and-forget), then the SSE connection is closed. A `disposedRef` flag prevents any further state updates.

---

## AppState Handling

The SDK monitors React Native's `AppState` to manage the SSE connection as the app moves between foreground and background.

### iOS Behavior

| App State | Action |
|-----------|--------|
| `active` → `inactive` | **Disconnect** immediately |
| `active` → `background` | **Disconnect** immediately |
| `inactive` → `active` | **Reconnect** |
| `background` → `active` | **Reconnect** |

iOS moves to `inactive` when the user swipes the notification shade, opens the app switcher, or when a system dialog appears. Since all of these may lead to the app being suspended, the SDK tears down connections immediately.

### Android Behavior

| App State | Action |
|-----------|--------|
| `active` → `inactive` | **No action** (ignore) |
| `active` → `background` | **Start grace timer**, disconnect after `backgroundGraceMs` |
| `background` → `active` | **Cancel grace timer** if still running, then **reconnect** |

Android fires `inactive` for keyboard appearance, permission dialogs, and overlay menus — none of which should disconnect the chat. The SDK only acts on the `background` state.

### Background Grace Period

The `backgroundGraceMs` config (default: 2000ms on Android, 0ms on iOS) adds a delay before tearing down the connection. This prevents connection thrashing when the app briefly backgrounds:

- Android permission dialogs
- File picker overlays
- Quick app-switch and return

If the app returns to `active` within the grace period, the timer is cancelled and the existing connection continues uninterrupted.

---

## Reconnection and Gap-Fill

When an SSE connection drops (network loss, server restart, etc.), the SDK:

1. Sets status to `reconnecting`
2. Waits `reconnectDelayMs` (default: 3000ms)
3. Opens a new SSE connection with the `Last-Event-ID` header set to the ID of the last received message
4. The server replays all messages since that ID (gap-fill)
5. Replayed messages are deduplicated against the local `seenMessageIds` set
6. Status returns to `connected`

If the server cannot find the `Last-Event-ID` (message too old or pruned), it sends a `resync` event instead. See [Resync](#resync).

### What Triggers Reconnection

- SSE `error` event
- SSE `close` event
- Network timeout
- Return from background (AppState change)

### What Does NOT Trigger Reconnection

- Manual `disconnect()` call (status stays `disconnected`)
- Channel closed (status becomes `closed`)
- Component unmount (connection is torn down, not reconnected)

---

## Message Deduplication

The SDK maintains a `Set<string>` of seen message IDs (capped at 500, LRU-trimmed) to prevent duplicate messages from appearing in the `messages` array.

Duplicates can arise from:

1. **SSE echo** — When you send a message, the server broadcasts it to all SSE connections, including yours. If `optimisticSend` is enabled, the message is already in the array, so the SSE echo must be dropped.

2. **Reconnection replay** — When reconnecting with `Last-Event-ID`, the server replays messages. Some of these may already be in the local array from the previous connection.

### How It Works

```
Message received via SSE
    │
    ├── Is ID in seenMessageIds? → DROP (duplicate)
    │
    └── Not seen → ADD to seenMessageIds, append to messages array
```

When `optimisticSend` is enabled, the message ID returned by the server is pre-added to `seenMessageIds` on send, so the SSE echo is automatically dropped.

The set is capped at 500 entries. When the cap is reached, the oldest entries are removed.

---

## Optimistic Send

When `optimisticSend` is `true` (the default), calling `sendMessage` immediately:

1. Constructs a local `Message` object with the data you're sending
2. Appends it to the `messages` array (for instant UI update)
3. Adds the server-returned message ID to `seenMessageIds`
4. The SSE echo of this message is then automatically deduplicated

This provides an instant messaging feel — the message appears in the UI the moment the user sends it, without waiting for the server round-trip.

### When Optimistic Send Fails

If the `sendMessage` HTTP request fails, the optimistically-added message remains in the array. The SDK does not automatically remove it. Handle this in your UI:

```typescript
try {
  await sendMessage('chat', text);
} catch (err) {
  // Optionally mark the message as failed in your UI
  showRetryButton(text);
}
```

### Disabling Optimistic Send

Set `optimisticSend: false` in the config to only add messages when they arrive via SSE:

```typescript
const config: ChatConfig = {
  manifest: createManifest('https://chat.example.com'),
  optimisticSend: false, // Messages only appear after server confirmation
};
```

---

## Resync

A `resync` event is sent by the server when:

- The client's `Last-Event-ID` cannot be found in the database
- The message was pruned or is too old to replay

When resync occurs:

1. The SDK clears the local `messages` and `seenMessageIds`
2. The `onResync` callback fires
3. The client should re-join the channel to get fresh state

In the `useChat` hook, resync is handled automatically — the hook re-fetches initial state from the server.

---

## Custom Domains

The SDK is fully parameterized by `ChatDomain`. See the [Chat Domain Guide](../../types/docs/chat-domain-guide.md) for the full explanation.

### Quick Example

```typescript
import type { ChatDomain } from '@pedi/chika-types';
import { useChat, createManifest } from '@pedi/chika-sdk';

interface DeliveryChat extends ChatDomain {
  role: 'courier' | 'customer' | 'merchant';
  metadata: {
    vehicle_type?: 'bike' | 'car' | 'motorcycle';
    store_name?: string;
  };
  messageType: 'chat' | 'order_picked_up' | 'order_delivered' | 'system_notice';
  attributes: {
    order_id?: string;
    eta_minutes?: number;
    location?: { lat: number; lng: number };
  };
}

function DeliveryChatScreen({ orderId, user }) {
  const { messages, sendMessage } = useChat<DeliveryChat>({
    config: { manifest: createManifest('https://chat.delivery.com') },
    channelId: `order_${orderId}`,
    profile: {
      id: user.id,
      role: 'courier',
      name: user.name,
      metadata: { vehicle_type: 'motorcycle' },
    },
  });

  // sendMessage enforces DeliveryChat types
  await sendMessage('order_picked_up', 'On my way!', {
    order_id: orderId,
    eta_minutes: 15,
    location: { lat: 14.5, lng: 120.9 },
  });
}
```

---

## Multi-Server Routing

For deployments with multiple chat servers, the SDK uses hash-based bucket routing via `ChatManifest`:

```typescript
const manifest: ChatManifest = {
  buckets: [
    { group: 'region-a', range: [0, 33], server_url: 'https://chat-a.example.com' },
    { group: 'region-b', range: [34, 66], server_url: 'https://chat-b.example.com' },
    { group: 'region-c', range: [67, 99], server_url: 'https://chat-c.example.com' },
  ],
};
```

The routing algorithm:
1. Compute hash: sum of all character codes in `channelId` modulo 100
2. Find the bucket whose `range` contains the hash
3. Return that bucket's `server_url`

This ensures a given channel always routes to the same server, which is necessary because SSE connections and in-memory broadcasting are server-local.

For single-server deployments, use `createManifest(url)` which creates a single bucket covering range `[0, 99]`.

---

## Unread Notifications

The `useUnread` hook provides real-time unread message counts via a per-channel SSE stream. It's designed for showing "red dot" indicators or badge counts when the user is not on the chat page.

### Basic Usage

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
    <Pressable>
      <Text>{channelId}</Text>
      {hasUnread && <View style={styles.redDot} />}
    </Pressable>
  );
}
```

### How It Works

1. On mount, the hook connects to `GET /channels/:channelId/unread?participant_id=xxx`
2. The server sends an `unread_snapshot` event with the current unread count
3. When a new message arrives (from another participant), the server pushes an `unread_update` event — the hook increments the count
4. When `useChat` marks messages as read (on unmount or via `POST /read`), the server pushes an `unread_clear` event — the hook updates the count

### Integration with useChat

The `useChat` hook auto-marks messages as read when the component unmounts (if connected). This means:

1. User is on a list page → `useUnread` shows badge count
2. User opens chat → `useChat` connects, joins channel (auto-marks-read on join)
3. User leaves chat → `useChat` unmounts, calls `markAsRead` with the last message ID
4. User is back on list page → `useUnread` reconnects, gets snapshot with count `0`

Use the `enabled` prop to pause `useUnread` when the chat is open:

```typescript
const [onChatPage, setOnChatPage] = useState(false);

// On list page
const { hasUnread } = useUnread({
  config,
  channelId,
  participantId: userId,
  enabled: !onChatPage,
});
```

### AppState Behavior

`useUnread` follows the same AppState patterns as `useChat`:
- **iOS:** Disconnects on `inactive`/`background`, reconnects on `active`
- **Android:** Grace period before disconnect on `background`
- On reconnection, a fresh `unread_snapshot` is delivered

---

## Error Handling

### Connection Errors

Connection errors set `status` to `'error'` and populate the `error` field:

```typescript
const { status, error } = useChat<PediChat>({ /* ... */ });

if (status === 'error') {
  console.error('Chat error:', error?.message);
}
```

### Send Errors

`sendMessage` can throw two specific errors:

```typescript
import { ChatDisconnectedError, ChannelClosedError } from '@pedi/chika-sdk';

try {
  await sendMessage('chat', text);
} catch (err) {
  if (err instanceof ChatDisconnectedError) {
    // Not connected — show reconnecting UI
    // err.status tells you the current state
  } else if (err instanceof ChannelClosedError) {
    // Channel permanently closed — navigate away
    // err.channelId identifies which channel
  } else {
    // Network error, server error, etc.
  }
}
```

### Channel Closed

When the server returns HTTP 410 (channel closed), the SDK:
1. Sets `status` to `'closed'`
2. Sets `error` to a `ChannelClosedError`
3. Does not attempt reconnection

Handle this in your UI to navigate the user away from the chat screen:

```typescript
useEffect(() => {
  if (status === 'closed') {
    navigation.goBack();
    showAlert('This conversation has ended.');
  }
}, [status]);
```
