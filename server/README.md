# chika-server

Real-time chat server for rider-driver communications in the Pedi ecosystem.

## What It Does

Chika Server provides the backend infrastructure for real-time, persistent chat between riders and drivers during a booking. It manages the full lifecycle of a conversation — from the moment a channel is created through message exchange to channel closure.

## Problems It Solves

- **Real-time messaging without polling** — Uses Server-Sent Events (SSE) so clients receive messages instantly without repeatedly hitting the server
- **Message persistence** — All messages are stored in MongoDB, so participants who join late or reconnect see the full conversation history
- **Seamless reconnection** — Clients that disconnect (network switch, app backgrounded) automatically catch up on missed messages via `Last-Event-ID` gap-fill
- **Channel lifecycle management** — Channels are automatically created on first join and cleaned up after 24 hours of inactivity
- **System message injection** — Backend services can inject system messages (booking status changes, alerts) into any channel via authenticated internal endpoints

## Key Features

- SSE-based real-time streaming with heartbeat keep-alive
- MongoDB-backed message persistence with ULID-ordered IDs
- Automatic channel creation on first join
- Gap-fill and resync for disconnected clients
- IP-based rate limiting on public endpoints
- API key-authenticated internal endpoints for system integrations
- Zod-validated request/response contracts
- Sentry error tracking (optional)
- Stale channel auto-cleanup (24h inactivity)

## Quick Start

```bash
export MONGODB_URI="mongodb://localhost:27017"
export API_KEY="your-secret-key"

bun run dev    # Development (hot reload)
bun run start  # Production
```

## Tech Stack

- **Runtime:** Bun
- **Framework:** Hono.js
- **Database:** MongoDB
- **Streaming:** Server-Sent Events (SSE)
- **Validation:** Zod (via `@pedi/chika-types`)
- **Error Tracking:** Sentry (optional)

## Documentation

See the [docs](./docs/) for detailed documentation:

- [Configuration](./docs/configuration.md) — Environment variables and setup
- [API Reference](./docs/api-reference.md) — All endpoints with request/response examples
- [Architecture](./docs/architecture.md) — Data model, SSE broadcasting, middleware, and internals
