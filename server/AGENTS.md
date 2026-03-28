# chika-server — Agent Guide

> **Maintenance rule:** When you modify server code, update this file to reflect your changes. Add new endpoints, update module descriptions, note new conventions.

Hono.js chat server running on Bun with MongoDB persistence and SSE real-time delivery.

## Module Map

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Entry point — mounts routes, connects DB, exports Bun server config with `idleTimeout: 0` |
| `src/env.ts` | Parses and validates `Bun.env` using Zod |
| `src/db.ts` | MongoDB client, collections, all query/mutation functions |
| `src/broadcaster.ts` | In-memory `Map<channelId, Set<Connection>>` for SSE fan-out and dead-connection cleanup |
| `src/unread-broadcaster.ts` | Per-channel-participant SSE broadcaster for unread notifications. Keyed by `channelId:participantId` with secondary `channelParticipants` index for efficient channel-wide broadcasts |
| `src/routes/channels.ts` | Client-facing: join, send message, SSE stream, unread SSE stream, mark-read |
| `src/routes/internal.ts` | Internal: system messages, history, close channel |
| `src/middleware/api-key.ts` | Validates `X-Api-Key` header via `timingSafeEqual` |
| `src/middleware/auth.ts` | Optional token auth — dynamically loads `auth.config.ts`, caches results |
| `auth.config.example.ts` | Example auth config — copy to `auth.config.ts` (gitignored) to enable |
| `auth.config.d.ts` | Type stub for the optional auth.config file |

## Key Patterns

- All request validation uses Zod schemas from `@pedi/chika-types` via `@hono/zod-validator`
- `broadcaster.ts` manages an in-memory `Map<string, Set<Connection>>` — no Redis/pub-sub at Phase 1 scale
- SSE streams use Hono's `streamSSE` helper with `stream.onAbort` for cleanup
- Heartbeat events omit `id` to avoid resetting `Last-Event-ID` on the client
- `idleTimeout: 0` in the export prevents Bun from closing idle SSE connections
- MongoDB indexes are created on startup in `connectDb()`
- Channel close terminates all active SSE connections via `disconnectChannel()`
- API key comparison uses `timingSafeEqual` with length pre-check
- `getMessagesSince` uses ULID-based `_id` ordering (not timestamps) for gap-free replay
- `getChannelMessages` is capped at 200 messages (matches internal history max)
- `addParticipant` upserts: updates profile data if participant exists, inserts if new
- SSE stream endpoint rejects closed channels with 410
- **Idempotency:** `POST /channels/:channelId/messages` accepts optional `idempotency_key` (string, 1-64 chars). Enforced by sparse unique index on `{ channel_id, idempotency_key }`. On duplicate (MongoDB E11000), returns the original message's `id` and `created_at` without re-broadcasting. Messages without a key have no dedup overhead (sparse index).
- `insertMessage` runs `insertOne` first, then `updateOne` for `last_activity_at` as best-effort (logged at warn on failure, never masks a successful insert)
- `last_read_message_id` tracked per participant in the channel document for unread counting
- `updateLastRead` only advances the read cursor, never regresses (uses `$elemMatch` with `$lt` guard)
- `/join` auto-marks messages as read by setting `last_read_message_id` to the latest message
- Unread SSE stream sends `unread_snapshot` on connect, `unread_update` on new messages, `unread_clear` on mark-read
- Unread SSE is passive: does not require channel to exist or participant to have joined (sends count 0 and listens)
- `unread_update` events are minimal: `{ channel_id, message_id, created_at }` (no message body)

## Data Model

### Participant
- `id` — unique identifier
- `role` — free-form string (e.g., `"driver"`, `"rider"`, `"agent"`)
- `name`, `profile_image` — display fields
- `metadata` — optional `Record<string, unknown>` for domain-specific data

### Message
- `sender_role` — string (matches participant's `role`, or `"system"` for internal messages)
- `sender_id` — participant ID, or `null` for system messages
- `idempotency_key` — optional string (1-64 chars), used for client retry deduplication

## Adding a New Endpoint

1. Add Zod schema to `packages/types/src/` (relevant file)
2. Export it from `packages/types/src/index.ts`
3. Add route handler in `src/routes/channels.ts` or `src/routes/internal.ts`
4. Use `zValidator` middleware for request validation
5. Update this AGENTS.md with the new endpoint

## Type Checking

```bash
bunx tsc --noEmit   # Run from server/ directory (uses local tsconfig.json + @types/bun)
```
