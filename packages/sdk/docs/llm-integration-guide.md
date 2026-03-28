# AI Agent Integration Guide

This guide is designed for AI coding assistants (LLMs, copilots, agents) that need to implement chat features using `@pedi/chika-sdk` in a React Native app. It covers the correct patterns, common pitfalls, and copy-paste-ready recipes.

## Critical Rules

Before generating any code, internalize these rules:

1. **Always provide a generic type parameter.** Use `useChat<PediChat>()` not `useChat()`. Without it, `sendMessage` accepts any string for type/role, defeating type safety.

2. **`channelId` is the effect dependency.** The hook re-runs when `channelId` changes. Do NOT pass a new object reference for `config` or `profile` on every render — store them in refs or memoize them. The hook already uses refs internally for `config`, `profile`, and `onMessage`.

3. **`sendMessage` throws.** Always wrap in try/catch. It can throw `ChatDisconnectedError` or `ChannelClosedError`.

4. **Don't conditionally call the hook.** Like all React hooks, `useChat` cannot be called conditionally. If you need to delay connection, render the chat component conditionally instead.

5. **One hook per channel.** Never call `useChat` twice for the same `channelId` in the same component tree. It creates duplicate SSE connections and duplicate messages.

---

## Minimal Working Example

This is the simplest correct implementation. Start here and add features incrementally.

```typescript
import React, { useState } from 'react';
import { View, TextInput, FlatList, Text, ActivityIndicator } from 'react-native';
import { useChat, createManifest, ChatDisconnectedError } from '@pedi/chika-sdk';
import type { PediChat } from '@pedi/chika-types';

const CHAT_CONFIG = {
  manifest: createManifest('https://chat.example.com'),
  headers: { Authorization: `Bearer ${token}` },
};

function ChatScreen({ bookingId, user }: { bookingId: string; user: UserProfile }) {
  const [input, setInput] = useState('');

  const { messages, participants, status, error, sendMessage } = useChat<PediChat>({
    config: CHAT_CONFIG,
    channelId: `booking_${bookingId}`,
    profile: {
      id: user.id,
      role: 'rider',
      name: user.name,
      profile_image: user.avatar,
    },
  });

  const handleSend = async () => {
    if (!input.trim()) return;
    const text = input;
    setInput('');

    try {
      await sendMessage('chat', text);
    } catch (err) {
      if (err instanceof ChatDisconnectedError) {
        // Re-populate input so user can retry
        setInput(text);
      }
    }
  };

  if (status === 'connecting') return <ActivityIndicator />;
  if (status === 'closed') return <Text>This conversation has ended.</Text>;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <Text>
            <Text style={{ fontWeight: 'bold' }}>{item.sender_role}: </Text>
            {item.body}
          </Text>
        )}
      />
      <TextInput
        value={input}
        onChangeText={setInput}
        onSubmitEditing={handleSend}
        placeholder={status === 'connected' ? 'Type a message...' : 'Reconnecting...'}
        editable={status === 'connected' || status === 'reconnecting'}
      />
    </View>
  );
}
```

---

## Patterns and Recipes

### Setting Up Config (Do This Once)

Config should be a stable reference. Define it outside the component or use `useMemo`.

```typescript
// CORRECT: Stable reference outside component
const CHAT_CONFIG = {
  manifest: createManifest(ENV.CHAT_SERVER_URL),
  headers: { 'X-Api-Key': ENV.CHAT_API_KEY },
};

function ChatScreen() {
  const chat = useChat<PediChat>({ config: CHAT_CONFIG, ... });
}
```

```typescript
// CORRECT: useMemo when headers depend on state
function ChatScreen({ token }: { token: string }) {
  const config = useMemo(() => ({
    manifest: createManifest(ENV.CHAT_SERVER_URL),
    headers: { Authorization: `Bearer ${token}` },
  }), [token]);

  const chat = useChat<PediChat>({ config, ... });
}
```

```typescript
// WRONG: New object every render (works, but wasteful — the hook
// uses a ref internally, so it won't cause reconnects, but it's
// still bad practice)
function ChatScreen() {
  const chat = useChat<PediChat>({
    config: { manifest: createManifest(url), headers: { ... } }, // new object each render
    ...
  });
}
```

### Dynamic Auth Token

If your auth token changes (refresh), update the config headers. The hook reads `config` from a ref, so it picks up the latest value on the next request without reconnecting.

```typescript
function ChatScreen({ bookingId }: { bookingId: string }) {
  const { token } = useAuth(); // token may refresh

  const config = useMemo<ChatConfig>(() => ({
    manifest: createManifest(ENV.CHAT_SERVER_URL),
    headers: { Authorization: `Bearer ${token}` },
  }), [token]);

  const chat = useChat<PediChat>({
    config,
    channelId: `booking_${bookingId}`,
    profile: { id: user.id, role: 'rider', name: user.name },
  });
}
```

### Handling All Status States

Always handle every status. This is a complete status handler:

```typescript
function StatusBanner({ status, error }: { status: ChatStatus; error: Error | null }) {
  switch (status) {
    case 'connecting':
      return <Banner text="Connecting..." icon="loading" />;
    case 'connected':
      return null; // No banner needed
    case 'reconnecting':
      return <Banner text="Reconnecting..." icon="loading" color="warning" />;
    case 'disconnected':
      return <Banner text="Disconnected" icon="offline" />;
    case 'closed':
      return <Banner text="Conversation ended" icon="check" />;
    case 'error':
      return <Banner text={error?.message ?? 'Connection error'} icon="error" color="danger" />;
  }
}
```

### Sending Different Message Types

The Pedi domain supports these message types: `'chat' | 'driver_arrived' | 'booking_started' | 'booking_completed' | 'booking_cancelled' | 'system_notice'`.

```typescript
// Regular chat message
await sendMessage('chat', 'I am at the corner near 7-Eleven', {
  device: 'ios',
  location: { latitude: 14.5995, longitude: 120.9842 },
});

// Driver arrival notification
await sendMessage('driver_arrived', 'I have arrived at the pickup point', {
  location: currentLocation,
  booking_id: bookingId,
});

// Booking lifecycle events
await sendMessage('booking_started', 'Trip has started', { booking_id: bookingId });
await sendMessage('booking_completed', 'Trip completed', { booking_id: bookingId });
```

### Rendering Messages by Type

Different message types should render differently:

```typescript
function MessageBubble({ message }: { message: Message<PediChat> }) {
  // System messages (sender_id is null, sender_role is 'system')
  if (message.sender_role === 'system') {
    return <SystemNotice text={message.body} />;
  }

  // Event messages
  switch (message.type) {
    case 'driver_arrived':
      return <EventCard icon="pin" text={message.body} />;
    case 'booking_started':
      return <EventCard icon="play" text="Trip started" />;
    case 'booking_completed':
      return <EventCard icon="check" text="Trip completed" />;
    case 'booking_cancelled':
      return <EventCard icon="x" text="Booking cancelled" color="danger" />;
    case 'chat':
    default:
      return (
        <ChatBubble
          text={message.body}
          isOwn={message.sender_id === currentUserId}
          senderName={findParticipant(message.sender_id)?.name}
          time={message.created_at}
        />
      );
  }
}
```

### Listening for Specific Events

Use `onMessage` to react to specific message types (push notifications, haptics, navigation):

```typescript
const chat = useChat<PediChat>({
  config: CHAT_CONFIG,
  channelId: `booking_${bookingId}`,
  profile: myProfile,
  onMessage: (msg) => {
    // Vibrate on new chat messages from others
    if (msg.type === 'chat' && msg.sender_id !== myProfile.id) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    // Navigate when booking completes
    if (msg.type === 'booking_completed') {
      navigation.replace('Rating', { bookingId });
    }

    // Show arrival alert
    if (msg.type === 'driver_arrived') {
      Alert.alert('Driver Arrived', msg.body);
    }
  },
});
```

### Channel Closed Handling

When a channel is closed (booking ended), navigate the user away:

```typescript
const { status, error } = useChat<PediChat>({ ... });

useEffect(() => {
  if (status === 'closed') {
    // Navigate to rating screen or home
    navigation.replace('Rating', { bookingId });
  }
}, [status]);
```

### Scroll to Bottom on New Message

```typescript
const flatListRef = useRef<FlatList>(null);

const chat = useChat<PediChat>({
  ...options,
  onMessage: () => {
    // Small delay to let FlatList update
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  },
});
```

### Driver Profile with Vehicle Metadata

```typescript
const driverProfile: Participant<PediChat> = {
  id: driver.id,
  role: 'driver',
  name: driver.name,
  profile_image: driver.avatar,
  metadata: {
    vehicle: {
      plate_number: driver.vehicle.plate,
      body_number: driver.vehicle.bodyNumber,
      color: driver.vehicle.color,
      brand: driver.vehicle.brand,
    },
    rating: driver.rating,
    current_location: driver.location
      ? { latitude: driver.location.lat, longitude: driver.location.lng }
      : null,
  },
};
```

---

## Common Mistakes

### Mistake: Calling `sendMessage` Without Error Handling

```typescript
// WRONG: Crashes if disconnected
const handleSend = () => {
  sendMessage('chat', input);
};

// CORRECT: Handle errors gracefully
const handleSend = async () => {
  try {
    await sendMessage('chat', input);
    setInput('');
  } catch (err) {
    if (err instanceof ChatDisconnectedError) {
      showToast('Reconnecting, please wait...');
    } else if (err instanceof ChannelClosedError) {
      showToast('Conversation has ended');
    }
  }
};
```

### Mistake: Not Importing Error Classes

```typescript
// WRONG: Checking error by message string (fragile)
catch (err) {
  if (err.message.includes('disconnected')) { ... }
}

// CORRECT: Use instanceof
import { ChatDisconnectedError, ChannelClosedError } from '@pedi/chika-sdk';

catch (err) {
  if (err instanceof ChatDisconnectedError) { ... }
  if (err instanceof ChannelClosedError) { ... }
}
```

### Mistake: Using `messages.length` as Unread Count

```typescript
// WRONG: messages includes all history, not just unread
const unreadCount = messages.length;

// CORRECT: Use the useUnread hook on non-chat pages
import { useUnread } from '@pedi/chika-sdk';

const { unreadCount, hasUnread } = useUnread({
  config,
  channelId: `booking_${bookingId}`,
  participantId: userId,
});
// useChat automatically marks messages as read on unmount,
// so useUnread will show 0 after the user leaves the chat page.
```

### Mistake: Filtering Messages Incorrectly

```typescript
// WRONG: Filtering by sender_id === null for "non-system" messages
// (system messages have sender_id: null AND sender_role: 'system')
const chatMessages = messages.filter(m => m.sender_id !== null);

// CORRECT: Filter by type or sender_role
const chatMessages = messages.filter(m => m.type === 'chat');
// or
const userMessages = messages.filter(m => m.sender_role !== 'system');
```

### Mistake: Conditional Hook Call

```typescript
// WRONG: Conditional hook (React rules violation)
function ChatScreen({ bookingId }: Props) {
  if (!bookingId) return <Loading />;
  const chat = useChat<PediChat>({ channelId: bookingId, ... }); // ❌ conditional
}

// CORRECT: Conditional rendering of the component that uses the hook
function BookingScreen({ bookingId }: Props) {
  if (!bookingId) return <Loading />;
  return <ChatScreen bookingId={bookingId} />;
}

function ChatScreen({ bookingId }: { bookingId: string }) {
  const chat = useChat<PediChat>({ channelId: bookingId, ... }); // ✅ always called
}
```

### Mistake: Clearing Input Before Send Succeeds

```typescript
// WRONG: Input cleared, but send might fail — user loses their message
const handleSend = async () => {
  setInput('');
  await sendMessage('chat', input); // if this throws, message is lost
};

// CORRECT: Clear on success, restore on failure
const handleSend = async () => {
  const text = input;
  setInput(''); // Clear optimistically for UX

  try {
    await sendMessage('chat', text);
  } catch {
    setInput(text); // Restore on failure
    showToast('Failed to send, please try again');
  }
};
```

---

## Type Reference (Quick)

These are the imports you'll need most often:

```typescript
// Hook and utilities
import {
  useChat,
  useUnread,
  createManifest,
  ChatDisconnectedError,
  ChannelClosedError,
} from '@pedi/chika-sdk';

// Types
import type {
  ChatConfig,
  ChatStatus,
  UseChatReturn,
  UseUnreadReturn,
  Message,
  Participant,
  PediChat,
  PediRole,
  PediMessageType,
  PediMessageAttributes,
  PediParticipantMeta,
  PediVehicle,
  PediLocation,
  SendMessageResponse,
} from '@pedi/chika-sdk';
```

Note: All types from `@pedi/chika-types` are re-exported from `@pedi/chika-sdk` for convenience. You don't need to import from both packages.

---

## Implementation Checklist

When building a chat screen, verify all of these:

- [ ] `useChat` is called with a generic type parameter (`<PediChat>`)
- [ ] `config` is a stable reference (not created inline every render)
- [ ] `channelId` is a string (not undefined/null) — guard with conditional rendering
- [ ] `profile` includes all required fields: `id`, `role`, `name`
- [ ] `sendMessage` is wrapped in try/catch
- [ ] `ChatDisconnectedError` and `ChannelClosedError` are handled
- [ ] All `ChatStatus` values are handled in the UI
- [ ] `status === 'closed'` triggers navigation away from chat
- [ ] `messages` are rendered with `keyExtractor={(m) => m.id}`
- [ ] System messages (`sender_role === 'system'`) render differently
- [ ] Event messages (non-`chat` types) render as cards/banners, not bubbles
- [ ] Input is disabled or shows placeholder when `status !== 'connected'`
- [ ] FlatList scrolls to bottom on new messages
- [ ] Unread indicators use `useUnread` hook (not `messages.length`)
- [ ] `useUnread` is disabled (`enabled: false`) when on the active chat page
