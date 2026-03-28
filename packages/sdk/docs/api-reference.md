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

Low-level SSE connection utility. Handles EventSource lifecycle, automatic reconnection, heartbeat keep-alive, and error/410 detection. Used internally by `createChatSession` and `useUnread`. Available for custom SSE integrations.

### SSEConnectionConfig

```typescript
interface SSEConnectionConfig {
  url: string;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  lastEventId?: string;
  customEvents?: string[];
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | `string` | **Required** | SSE endpoint URL |
| `headers` | `Record<string, string>` | `undefined` | Custom headers (auth, etc.) |
| `reconnectDelayMs` | `number` | `3000` | Delay before reconnection attempt |
| `lastEventId` | `string` | `undefined` | Initial `Last-Event-ID` for resumption |
| `customEvents` | `string[]` | `[]` | Additional SSE event types to listen for (beyond `message`) |

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
}
```

Call `close()` to terminate the connection and prevent further reconnection attempts.

---

## createChatSession\<D\>

```typescript
function createChatSession<D extends ChatDomain = DefaultDomain>(
  config: ChatConfig,
  channelId: string,
  profile: Participant<D>,
  callbacks: SessionCallbacks<D>
): Promise<ChatSession<D>>
```

Lower-level imperative API for creating a chat session outside of React. Used internally by `useChat` and available for non-React integrations (e.g. background services, testing).

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
  sendMessage: (
    type: D['messageType'],
    body: string,
    attributes?: MessageAttributes<D>
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
| `sendMessage` | `function` | Send a message to the channel |
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

## Configuration Types

### ChatConfig

```typescript
interface ChatConfig {
  manifest: ChatManifest;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  backgroundGraceMs?: number;
  optimisticSend?: boolean;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `manifest` | `ChatManifest` | **Required** | Server routing manifest. Use `createManifest()` for single-server setups. |
| `headers` | `Record<string, string>` | `undefined` | Custom headers sent with all HTTP and SSE requests (e.g. auth tokens) |
| `reconnectDelayMs` | `number` | `3000` | Milliseconds to wait before attempting SSE reconnection |
| `backgroundGraceMs` | `number` | `2000` (Android) / `0` (iOS) | Milliseconds to wait before tearing down connection when app backgrounds |
| `optimisticSend` | `boolean` | `true` | If `true`, messages are appended to the local `messages` array immediately on send, before server confirmation |

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
