# Server Configuration

## Environment Variables

The server validates all environment variables on startup using Zod. Invalid or missing required variables will prevent the server from starting.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | Yes | — | MongoDB connection string (e.g. `mongodb://localhost:27017`) |
| `API_KEY` | Yes | — | Secret key for authenticating internal API endpoints. Min 1 character. |
| `PORT` | No | `3000` | Port the HTTP server listens on |
| `NODE_ENV` | No | `development` | Environment mode: `development`, `production`, or `test` |
| `MONGODB_DB` | No | `chika` | MongoDB database name |
| `SENTRY_DSN` | No | — | Sentry DSN URL for error tracking. Omit to disable Sentry. |

## Authentication (Optional)

Client-facing endpoints (`/channels/*`) can optionally require token validation. To enable, create an `auth.config.ts` file in the `server/` directory:

```bash
cp auth.config.example.ts auth.config.ts
```

The file exports an `AuthConfig` object with a `validate` function. The validator receives all request headers and the channel ID, and returns `{ valid: boolean, userId?: string }`.

```typescript
import type { AuthConfig } from '@pedi/chika-types';

export default {
  validate: async ({ headers, channelId }) => {
    const auth = headers['authorization'];
    if (!auth) return { valid: false };
    // ... your validation logic
    return { valid: true, userId: 'abc' };
  },
  cacheTtl: 300_000,       // valid result TTL (default: 5 min)
  invalidCacheTtl: 2_000,  // invalid result TTL (default: 2s)
  cacheKey: ({ headers }) => headers['authorization'] ?? null,  // optional
} satisfies AuthConfig;
```

| Option | Default | Description |
|--------|---------|-------------|
| `validate` | (required) | Async function receiving `{ headers, channelId }` |
| `cacheTtl` | `300000` (5 min) | How long valid results are cached (ms). Set `0` to disable. |
| `invalidCacheTtl` | `2000` (2s) | How long invalid results are cached (ms) |
| `cacheKey` | `Authorization` header | Function to derive cache key. Return `null` to skip caching. |

The file is gitignored — it won't cause merge conflicts. For Docker, mount it as a volume:

```yaml
volumes:
  - ./my-auth.config.ts:/app/server/auth.config.ts
```

When `auth.config.ts` does not exist, auth is completely disabled (current default behaviour).

## Running the Server

### Development

```bash
bun run dev
```

Starts the server with Bun's hot-reload enabled. Changes to source files are picked up automatically.

### Production

```bash
bun run start
```

Runs the server without hot-reload.

### Type Checking

```bash
cd server && bunx tsc --noEmit
```

Runs TypeScript compiler in check-only mode. This is separate from the root workspace type check since the server has its own `tsconfig.json`.

## Sentry Integration

When `SENTRY_DSN` is provided, the server initializes Sentry on startup with:

- **Trace sample rate:** 100% in development, 20% in production
- **Error captures:** Unhandled exceptions and runtime errors caught by the global error handler

If `SENTRY_DSN` is not set, Sentry is completely disabled with no overhead.

## Database Setup

The server connects to MongoDB on startup and automatically creates the following indexes:

**Channels collection:**
- `{ status: 1 }` — For querying active/closed channels

**Messages collection:**
- `{ channel_id: 1, created_at: 1 }` — For fetching messages by channel with time ordering
- `{ created_at: 1 }` — For time-based queries across channels

No manual migration or index creation is required.

## Channel Cleanup

A background job runs every hour to automatically close stale channels:

- **Threshold:** 24 hours of inactivity (no messages sent)
- **Action:** Sets channel status to `closed`, sets `closed_at` timestamp
- **Recovery:** Failures are silently caught and retried on the next cycle

This prevents unbounded growth of active channels in the database.

## Bun Server Options

The server exports with `idleTimeout: 0` to prevent Bun from terminating idle SSE connections. This is critical for long-lived streaming connections that may not send data for extended periods.
