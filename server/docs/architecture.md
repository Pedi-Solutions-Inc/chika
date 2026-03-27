# Server Architecture

## Overview

```
Client (SDK)
    │
    ├── POST /channels/:id/join       → MongoDB upsert
    ├── POST /channels/:id/messages   → MongoDB insert + SSE broadcast
    └── GET  /channels/:id/stream     → SSE connection (in-memory)
                                           │
Backend Services                           │
    │                                      │
    ├── POST /internal/.../messages   → MongoDB insert + SSE broadcast
    ├── GET  /internal/.../messages   → MongoDB query
    └── POST /internal/.../close      → MongoDB update + disconnect streams
```

## Data Model

### Channels Collection

Each channel represents a conversation between participants (typically one rider and one driver).

```typescript
{
  _id: string;                      // Channel ID — client-specified (e.g. "booking_456")
  status: 'active' | 'closed';     // Lifecycle state
  participants: Array<{
    id: string;                     // Participant ID
    role: string;                   // e.g. "rider", "driver"
    name: string;                   // Display name
    profile_image?: string;         // Avatar URL
    metadata?: Record<string, unknown>;  // Domain-specific data (vehicle, rating, etc.)
    joined_at: string;              // ISO 8601 — when participant joined
  }>;
  created_at: string;               // ISO 8601 — channel creation time
  closed_at: string | null;         // ISO 8601 — when closed, or null
  last_activity_at: string;         // ISO 8601 — updated on every message insert
}
```

**Indexes:** `{ status: 1 }`

Channels are created lazily on first `join` request via `findOrCreateChannel()` (upsert). The `_id` is the channel ID provided by the client, not auto-generated.

### Messages Collection

```typescript
{
  _id: string;                      // msg_<ULID> — time-ordered unique ID
  channel_id: string;               // Foreign key to channels._id
  sender_id: string | null;         // null for system messages
  sender_role: string;              // Participant role or "system"
  type: string;                     // Message type (e.g. "chat", "driver_arrived")
  body: string;                     // Message content (1-10,000 chars)
  attributes: Record<string, unknown>;  // Arbitrary metadata (defaults to {})
  created_at: string;               // ISO 8601 timestamp
}
```

**Indexes:**
- `{ channel_id: 1, created_at: 1 }` — Fetching messages by channel with time ordering
- `{ created_at: 1 }` — Time-based queries for cleanup and history

### ID Generation

Message IDs use the `msg_<ULID>` format. ULIDs are:

- **Time-ordered** — Lexicographic sorting equals chronological sorting
- **Unique** — No collisions even under concurrent inserts
- **Compact** — 26-character Crockford Base32 encoding

This enables gap-fill via `Last-Event-ID` — the server can query "all messages with `_id` greater than this ULID" efficiently.

## SSE Broadcasting

### In-Memory Connection Manager

The broadcaster (`src/broadcaster.ts`) maintains an in-memory `Map<string, Set<Connection>>` that maps channel IDs to active SSE connections.

```
Map {
  "booking_456" => Set { Connection1, Connection2 },
  "booking_789" => Set { Connection3 },
}
```

**Functions:**

| Function | Description |
|----------|-------------|
| `subscribe(channelId, stream)` | Register a new SSE connection for a channel |
| `unsubscribe(channelId, conn)` | Remove a connection; clean up map entry if the set becomes empty |
| `broadcast(channelId, message)` | Write message to all connections for a channel; auto-remove failed writes |
| `disconnectChannel(channelId)` | Force-close all connections (used when closing a channel) |
| `getAllChannelIds()` | Iterate over channels with active connections |
| `getConnectionCount(channelId)` | Number of active connections for a channel |

### Connection Lifecycle

1. Client opens `GET /channels/:id/stream`
2. Server creates an SSE `StreamingApi` and calls `subscribe(channelId, stream)`
3. On message send, `broadcast()` writes to all connections in the channel's set
4. If a write fails (client disconnected), the connection is automatically removed from the set
5. On client abort, `stream.onAbort()` triggers `unsubscribe()`
6. On channel close, `disconnectChannel()` force-closes all connections

### Gap-Fill and Resync

When a client reconnects with a `Last-Event-ID` header:

1. Server calls `getMessagesSince(channelId, lastEventId)`
2. If the ID is found in the database, all subsequent messages are replayed as SSE `message` events
3. If the ID is **not** found (too old or pruned), the function returns `{ resync: true }`
4. The server sends an SSE `resync` event, signaling the client to discard local state and re-join

### Heartbeat

A heartbeat event is sent every 30 seconds to each SSE connection:

```
event: heartbeat
data:
```

The heartbeat intentionally does **not** include an `id` field. This prevents the browser/client from updating `Last-Event-ID` to a non-message value, which would break gap-fill on reconnection.

## Middleware Stack

Middleware is applied in this order:

### 1. Logger (`hono/logger`)
Logs all incoming requests with method, path, and response time.

### 2. CORS (`hono/cors`)
Enables cross-origin requests from any origin. Required for web-based clients.

### 3. Body Limit (`hono/body-limit`)
Limits request body size to **64 KB**. Prevents abuse from oversized payloads. Returns 413 if exceeded.

### 4. Rate Limiter (`hono-rate-limiter`)
Applied per-route on client endpoints only. Uses an in-memory store (resets on server restart). See [API Reference](./api-reference.md#rate-limits) for limits per endpoint.

### 5. Auth Validator (`src/middleware/auth.ts`)
Applied to `/channels/:channelId/*` routes. Dynamically imports `auth.config.ts` at startup — if the file is absent, auth is completely disabled (passthrough). When enabled, the validator receives all request headers and the channel ID, and returns `{ valid, userId? }`. Results are cached in-memory (valid: 5min, invalid: 2s, configurable). See `auth.config.example.ts` for usage.

### 6. Zod Validator (`@hono/zod-validator`)
Validates request bodies and query parameters using schemas from `@pedi/chika-types`. Returns 400 with flattened Zod errors on failure.

### 7. API Key Middleware (`src/middleware/api-key.ts`)
Applied to `/internal/*` routes only. Validates the `X-Api-Key` header using `crypto.timingSafeEqual` to prevent timing attacks. Pre-checks buffer length to avoid information leakage.

### 8. Global Error Handler
Catches unhandled exceptions, logs them, reports to Sentry (if configured), and returns a generic `500 Internal server error` response.

## Database Operations

Core database functions in `src/db.ts`:

| Function | Description |
|----------|-------------|
| `connectDb()` | Connect to MongoDB, create indexes on startup |
| `disconnectDb()` | Close the MongoDB client connection |
| `getDb()` | Get the `Db` instance (used for health check pings) |
| `findChannel(channelId)` | Fetch a channel by `_id` |
| `findOrCreateChannel(channelId)` | Upsert — create channel if it doesn't exist, return existing if it does |
| `addParticipant(channelId, participant)` | Upsert participant in channel's participants array |
| `insertMessage(doc)` | Insert message document; atomically updates `last_activity_at` on the channel |
| `getChannelMessages(channelId, limit?)` | Fetch up to `limit` (default 50) most recent messages |
| `getMessagesSince(channelId, sinceMessageId)` | Fetch messages after a ULID; returns `{ docs, resync }` |
| `getMessagesSinceTime(channelId, sinceTime)` | Fetch messages after an ISO timestamp |
| `getMessageHistory(channelId, options)` | Paginated history with `before`/`after` cursors; capped at 200 |
| `closeChannel(channelId)` | Set status to `closed` and `closed_at` timestamp; returns `true` if modified |
| `toMessage(doc)` | Convert internal `MessageDocument` to public `Message` type |

### Atomicity

`insertMessage()` performs two operations atomically within a single database call:
1. Inserts the message document into the messages collection
2. Updates `last_activity_at` on the parent channel

This ensures `last_activity_at` is always consistent with the actual last message time.

## Project Structure

```
server/
├── package.json
├── tsconfig.json
├── auth.config.d.ts              # Type stub for optional auth config
├── auth.config.example.ts        # Example auth config — copy to auth.config.ts to enable
├── AGENTS.md                     # Internal maintenance guide
├── README.md
└── src/
    ├── index.ts                  # Entry point — app setup, middleware, route mounting, server export
    ├── env.ts                    # Zod-validated environment variables
    ├── db.ts                     # MongoDB client, collections, all query functions
    ├── broadcaster.ts            # In-memory SSE connection manager
    ├── sentry.ts                 # Sentry initialization
    ├── channel-cleanup.ts        # Hourly stale channel cleanup job
    ├── middleware/
    │   ├── api-key.ts            # Timing-safe API key validation
    │   └── auth.ts               # Optional token auth — loads auth.config.ts, caches results
    └── routes/
        ├── channels.ts           # Client routes: join, send message, stream
        └── internal.ts           # Internal routes: system messages, history, close
```
