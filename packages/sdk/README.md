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

## Key Features

- `useChat<D>()` React hook with full TypeScript generics
- `createChatSession<D>()` imperative API for non-React usage
- Automatic SSE reconnection with configurable delay
- Platform-aware AppState handling (iOS vs Android)
- Optimistic message sending with deduplication
- Hash-based bucket routing for multi-server deployments
- Custom error classes (`ChatDisconnectedError`, `ChannelClosedError`)

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

**Peer dependencies:** `react >= 18`, `react-native >= 0.72`

## Documentation

See the [docs](./docs/) for detailed documentation:

- [API Reference](./docs/api-reference.md) — `useChat`, `createChatSession`, utilities, error classes, and all config options
- [Guides](./docs/guides.md) — Connection lifecycle, AppState handling, reconnection, deduplication, custom domains
- [AI Agent Integration Guide](./docs/llm-integration-guide.md) — Patterns, recipes, pitfalls, and checklists for LLM-assisted implementation
