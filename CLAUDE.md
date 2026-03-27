# Pedi Chika

Self-hosted chat service for rider-driver communications. Bun monorepo with three packages.

See [AGENTS.md](./AGENTS.md) for architecture, conventions, module maps, and development guide.

Each sub-project has its own AGENTS.md:
- [server/AGENTS.md](./server/AGENTS.md) — chika-server (Hono.js + MongoDB + SSE)
- [packages/types/AGENTS.md](./packages/types/AGENTS.md) — @pedi/chika-types (shared types + Zod schemas)
- [packages/sdk/AGENTS.md](./packages/sdk/AGENTS.md) — @pedi/chika-sdk (React Native SDK)

## Quick Start

```bash
bun install                    # Install dependencies
bun run --cwd server dev       # Start server (requires MONGODB_URI and API_KEY env vars)
```

## Type Checking

```bash
bunx tsc --noEmit              # Check packages
cd server && bunx tsc --noEmit # Check server
```
