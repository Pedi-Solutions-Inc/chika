# Pedi Chika — Agent Guide

> **Maintenance rule:** When you modify code in this repo, update the relevant AGENTS.md to reflect your changes. This includes adding/removing endpoints, changing module responsibilities, updating conventions, or altering the tech stack. AGENTS.md must always reflect the current state of the codebase.

## Overview

Pedi Chika is a self-hosted, general-purpose chat communications service. It provides real-time messaging over SSE with HTTP endpoints for channel management. Channels are generic — any use case that needs real-time chat (rider-driver, support, group chat) can use this service.

**Monorepo structure:** Bun workspaces with three packages.

## Architecture

```
packages/
  types/              @pedi/chika-types — shared Zod schemas + TypeScript types
  sdk/                @pedi/chika-sdk  — React Native client SDK (react-native-sse + useChat hook)
server/               chika-server     — Hono.js API + MongoDB + SSE broadcaster
```

### Package Dependency Graph

```
@pedi/chika-types     ← zero-dep (only zod), shared by everything
  ├── @pedi/chika-sdk ← depends on chika-types + react-native-sse + react
  └── chika-server    ← depends on chika-types + hono + mongodb + ulid
```

## Tech Stack

- **Runtime:** Bun
- **Server framework:** Hono.js
- **Database:** MongoDB
- **Real-time:** SSE (Server-Sent Events) via in-memory broadcaster
- **Validation:** Zod + @hono/zod-validator
- **Client SSE:** react-native-sse (pollingInterval disabled, SDK manages reconnection manually)
- **IDs:** ULID (prefixed with `msg_`)

## ChatDomain Generic System

All domain-specific types (`Participant`, `Message`, `JoinResponse`, etc.) are parameterized by a single `ChatDomain` interface:

```typescript
interface ChatDomain {
  role: string;                      // constrains participant roles
  metadata: Record<string, unknown>; // constrains participant metadata
  messageType: string;               // constrains message types
  attributes: Record<string, unknown>; // constrains message attributes
}
```

Consumers define their domain once and pass it as a generic to the SDK:
```typescript
const { messages } = useChat<RideHailingChat>({ ... });
```

All generics default to `DefaultDomain` (fully open) for backward compatibility. The server uses loose runtime types — generics are compile-time only.

## Key Conventions

- Channel IDs are opaque strings — no enforced format. The service is general-purpose.
- Message IDs are `msg_` + ULID
- Participant `role` is constrained at compile time by `ChatDomain['role']`, validated as `string` at runtime
- Participant `metadata` is domain-specific data constrained by `ChatDomain['metadata']`
- Client-facing endpoints are optionally authenticated via `auth.config.ts` (see below)
- Internal endpoints require `X-Api-Key` header (timing-safe comparison)
- System messages have `sender_id: null` and `sender_role: "system"`
- All timestamps are ISO 8601 strings
- Message `attributes` constrained by `ChatDomain['attributes']` at compile time, `Record<string, unknown>` at runtime
- `seenMessageIds` Set in the SDK deduplicates messages across SSE echo and reconnection replay

## Server Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/channels/:channelId/join` | Optional¹ | Register participant + fetch history |
| POST | `/channels/:channelId/messages` | Optional¹ | Send chat message |
| GET | `/channels/:channelId/stream` | Optional¹ | SSE live stream (rejects closed channels) |
| POST | `/internal/channels/:channelId/messages` | API Key | Send system message |
| GET | `/internal/channels/:channelId/messages` | API Key | Fetch message history (paginated) |
| POST | `/internal/channels/:channelId/close` | API Key | Close channel + disconnect all SSE |
| GET | `/health` | None | Health check |

¹ Auth is enabled when `server/auth.config.ts` exists. The validator receives all request headers and the channel ID. See `server/auth.config.example.ts`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | Server port |
| `MONGODB_URI` | Yes | — | MongoDB connection string |
| `MONGODB_DB` | No | chika | Database name |
| `API_KEY` | Yes | — | Shared secret for internal endpoints |

## Development

```bash
bun install                    # Install all workspace dependencies
bun run --cwd server dev       # Start server with hot reload
```

## Type Checking

```bash
bunx tsc --noEmit                           # Check packages (from root)
cd server && bunx tsc --noEmit              # Check server (has own tsconfig)
```

## MongoDB Collections

- `channels` — Indexed on `{ status: 1 }`
- `messages` — Indexed on `{ channel_id: 1, created_at: 1 }` and `{ created_at: 1 }`

## SSE Behavior

- Heartbeat events sent every 30s (no `id` field — avoids resetting `Last-Event-ID`)
- `Last-Event-ID` header triggers replay of missed messages on reconnect (ULID-based ordering)
- `stream.onAbort` handles client disconnect cleanup
- `idleTimeout: 0` on Bun.serve prevents premature connection termination
- SDK disables `pollingInterval` and manages reconnection manually with 3s delay

## SDK Architecture

The SDK provides two APIs:
- `useChat` hook (primary) — manages session lifecycle, AppState, reconnection, message accumulation, deduplication
- `createChatSession` (lower-level) — imperative callback-based API for non-React or custom integrations

### AppState Handling (React Native)
- **iOS:** Tears down SSE on `inactive`/`background`, reconnects on `active`
- **Android:** Only tears down on `background` (not `inactive` — keyboards, dialogs, overlays trigger `inactive`). 2-second grace period before teardown to handle brief transitions.
