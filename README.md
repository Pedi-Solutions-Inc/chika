# Pedi Chika

Self-hosted real-time chat service for rider-driver communications.

> **Note:** This project is built for our own use. We publish the packages publicly for convenience, but they are not intended as a general-purpose chat library for external consumers. We may introduce breaking changes, opinionated defaults, or domain-specific types (like our ride-hailing models) at any time to suit our own needs. You're welcome to use or fork it, but don't expect a stable public API contract or community-driven feature decisions.

## What It Does

Pedi Chika provides the complete chat infrastructure for a ride-hailing platform. When a rider books a trip, a chat channel is created where the rider and driver can exchange messages in real-time. The system handles the full conversation lifecycle — from channel creation through live messaging to automatic cleanup after the trip ends.

## Problems It Solves

- **No third-party chat dependency** — Fully self-hosted, no per-message pricing, no vendor lock-in
- **Real-time without polling** — Server-Sent Events deliver messages instantly to connected clients
- **Works on unstable networks** — Automatic reconnection with gap-fill ensures no messages are lost when mobile connections drop
- **Mobile-first design** — AppState-aware lifecycle management handles backgrounding, foregrounding, and platform differences between iOS and Android
- **Type-safe across the stack** — A single shared type package ensures the server and client SDK always agree on data shapes
- **Domain-flexible** — The generic type system can be adapted for any chat use case beyond ride-hailing

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│   React Native App  │     │   Backend Services   │
│  (@pedi/chika-sdk)  │     │                      │
│                     │     │                      │
│  useChat<PediChat>  │     │  System messages     │
│  - Join channel     │     │  - Booking events    │
│  - Send messages    │     │  - Close channels    │
│  - Receive via SSE  │     │  - Fetch history     │
└────────┬────────────┘     └────────┬─────────────┘
         │                           │
         │  /channels/* (public)     │  /internal/* (API key)
         │                           │
         └───────────┐   ┌──────────┘
                     ▼   ▼
              ┌──────────────────┐
              │   chika-server   │
              │   (Hono + SSE)   │
              │                  │
              │  - Channel mgmt  │
              │  - Message store │
              │  - SSE broadcast │
              │  - Auto cleanup  │
              └────────┬─────────┘
                       │
                       ▼
                ┌────────────┐
                │  MongoDB   │
                └────────────┘
```

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`server`](./server/) | — | Hono.js chat server with MongoDB and SSE streaming |
| [`packages/sdk`](./packages/sdk/) | `@pedi/chika-sdk` | React Native SDK with `useChat` hook |
| [`packages/types`](./packages/types/) | `@pedi/chika-types` | Shared TypeScript types and Zod validation schemas |

## Versioning

`@pedi/chika-types` and `@pedi/chika-sdk` are always released together at the same version. The server is versioned independently.

| Component | Tag format | Example |
|-----------|------------|---------|
| SDK + Types | `v*` | `v1.2.0` |
| Server | `server-v*` | `server-v1.3.0` |

Check [COMPATIBILITY.md](./COMPATIBILITY.md) for a table of which server versions are compatible with which SDK/Types versions. This file is updated automatically on every release.

For publishing setup and release instructions, see [PUBLISHING.md](./PUBLISHING.md).

## Quick Start

### Docker

```bash
# Build the image
docker build -t pedi-chika .

# Run (requires MongoDB)
docker run -p 3000:3000 --env-file .env pedi-chika
```

Your `.env` file should contain:

```env
MONGODB_URI=mongodb://host.docker.internal:27017
API_KEY=your-secret-key
```

To enable authentication, create `server/auth.config.ts` (see [Authentication](#authentication)). It is included in the image at build time — use environment variables for any secrets.

### Local Development

```bash
# Install dependencies
bun install

# Start the server (requires MongoDB)
export MONGODB_URI="mongodb://localhost:27017"
export API_KEY="your-secret-key"
bun run --cwd server dev

# Type check everything
bunx tsc --noEmit              # packages/types + packages/sdk
cd server && bunx tsc --noEmit # server
```

## Key Features

### Server
- SSE-based real-time message streaming with heartbeat keep-alive
- MongoDB persistence with ULID-ordered message IDs
- Automatic channel creation on first join
- Gap-fill replay via `Last-Event-ID` for seamless reconnection
- IP-based rate limiting on public endpoints
- API key-authenticated internal endpoints for system integrations
- Pluggable token authentication via `auth.config.ts` (see [Authentication](#authentication))
- **Plugin architecture** — Extend server behavior with interceptors (block/modify messages before storage) and after-send hooks (fire-and-forget side effects). See [Plugins](#plugins)
- **Real-time unread notifications** — SSE-backed per-participant unread counts with passive listening (monitor channels before joining). See [Unread Notifications](#unread-notifications)
- Stale channel auto-cleanup (24h inactivity)
- Sentry error tracking (optional)

### SDK
- `useChat<D>()` React hook with full TypeScript generics
- `createChatSession<D>()` imperative API for non-React usage
- **`useUnread()` hook** — Real-time unread count tracking with AppState-aware lifecycle management. See [Unread Notifications](#unread-notifications)
- **System message profiles** — Make system messages appear as a participant (e.g. driver) via `resolveSystemProfile`
- Automatic SSE reconnection with configurable delay
- Platform-aware AppState handling (iOS vs Android)
- Optimistic message sending with automatic deduplication
- Hash-based bucket routing for multi-server deployments

### Types
- Generic `ChatDomain` system for strongly-typed chat domains
- Pre-built `PediChat` domain (driver/rider roles, booking events, vehicle metadata)
- Zod schemas for all API request validation
- Zero dependencies beyond Zod

## Tech Stack

- **Runtime:** Bun
- **Server:** Hono.js
- **Database:** MongoDB
- **Streaming:** Server-Sent Events (SSE)
- **Validation:** Zod
- **Client:** React Native (>= 0.72) + React (>= 18)
- **Error Tracking:** Sentry (optional)

## Authentication

By default, client-facing endpoints (`/channels/*`) are open — no token validation is required. To enable authentication, create an `auth.config.ts` file in the `server/` directory:

```bash
cp server/auth.config.example.ts server/auth.config.ts
```

Then implement the `validate` function with your own token-verification logic. The validator receives all request headers and the channel ID:

```typescript
import type { AuthConfig } from '@pedi/chika-types';

export default {
  validate: async ({ headers, channelId }) => {
    const auth = headers['authorization']; // e.g. "Driver <token>" or "Rider <token>"
    if (!auth) return { valid: false };

    const [role, token] = auth.split(' ');
    const res = await fetch('https://your-api.com/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, role }),
    });

    if (!res.ok) return { valid: false };
    const data = await res.json();
    return { valid: true, userId: data.user_id };
  },
  cacheTtl: 300_000,       // cache valid results for 5 minutes
  invalidCacheTtl: 2_000,  // cache invalid results for 2 seconds
} satisfies AuthConfig;
```

The file is gitignored — your auth logic stays private and won't cause merge conflicts. For Docker deployments, the file is included in the image at build time. Use environment variables for any secrets your auth logic needs.

The SDK already supports custom headers — pass them in the `headers` option:

```typescript
useChat<PediChat>({
  manifest,
  headers: { Authorization: 'Driver <token>' },
});
```

## Plugins

The server supports a plugin architecture that lets you extend message processing without modifying source code. Plugins live in the `server/plugins/` directory (gitignored) and hook into two phases of the message lifecycle:

- **Interceptors** — Run sequentially before a message is stored. Can inspect, modify, or block messages (e.g. content filters, rate limiters, message transformers).
- **After-send hooks** — Run in parallel after a message is broadcast. Fire-and-forget side effects (e.g. forwarding to external APIs, analytics, push notifications).

```typescript
import { definePlugin } from '../src/plugins';

export default definePlugin({
  name: 'content-filter',
  priority: 10,
  critical: true,

  intercept({ message, source }) {
    if (source === 'system') return { action: 'allow' };
    if (containsProfanity(message.body)) {
      return { action: 'block', reason: 'Inappropriate content' };
    }
    return { action: 'allow' };
  },

  async afterSend({ message, channelId, request }) {
    await fetch('https://api.example.com/events', {
      method: 'POST',
      headers: { Authorization: request.authorization! },
      body: JSON.stringify({ message, channelId }),
    });
  },
});
```

Plugins are priority-ordered, support configurable timeouts, and can be marked as `critical` (fail-closed) or non-critical (fail-open). Copy `server/plugins/_example.ts` to get started. See the full [Plugin Documentation](./server/docs/plugins.md) for details.

## Unread Notifications

Real-time unread message tracking via a dedicated SSE stream. Supports **passive listening** — clients can monitor unread counts for channels they haven't joined yet.

### Server

`GET /channels/:id/unread?participant_id=<id>` opens an SSE connection that delivers three event types:

| Event | When | Payload |
|-------|------|---------|
| `unread_snapshot` | On connect | `{ channel_id, unread_count, last_message_at }` |
| `unread_update` | New message from another participant | `{ channel_id, message_id, created_at }` |
| `unread_clear` | After marking messages as read | `{ channel_id, unread_count }` |

Mark messages as read by calling `POST /channels/:id/read` with `{ participant_id, message_id }`.

### SDK

The `useUnread()` hook connects to the unread SSE endpoint and manages the full mobile lifecycle:

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

The hook handles SSE reconnection, AppState-aware teardown/reconnect (with Android grace periods), and can be paused via `enabled: false` when `useChat` is already active on the same channel.

## Documentation

Each package has its own detailed docs:

**Server** — [`server/docs/`](./server/docs/)
- [Configuration](./server/docs/configuration.md) — Environment variables, setup, Sentry, cleanup
- [API Reference](./server/docs/api-reference.md) — All endpoints with request/response examples
- [Architecture](./server/docs/architecture.md) — Data model, SSE broadcasting, middleware

**SDK** — [`packages/sdk/docs/`](./packages/sdk/docs/)
- [API Reference](./packages/sdk/docs/api-reference.md) — `useChat`, `createChatSession`, utilities, errors
- [Guides](./packages/sdk/docs/guides.md) — Connection lifecycle, AppState, reconnection, deduplication
- [AI Agent Integration Guide](./packages/sdk/docs/llm-integration-guide.md) — Patterns and recipes for LLM-assisted implementation

**Types** — [`packages/types/docs/`](./packages/types/docs/)
- [Type Reference](./packages/types/docs/type-reference.md) — All types, interfaces, and Zod schemas
- [Chat Domain Guide](./packages/types/docs/chat-domain-guide.md) — Generic domain system with examples
