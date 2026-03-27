# syntax=docker/dockerfile:1.7
# Build from project root: docker build -f server/Dockerfile .
# =============================================================================
# Stage 1 — deps
# =============================================================================
FROM oven/bun:1-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/types/package.json ./packages/types/
COPY packages/sdk/package.json   ./packages/sdk/
COPY server/package.json         ./server/

RUN bun install --frozen-lockfile --production

# =============================================================================
# Stage 2 — runner
# =============================================================================
FROM oven/bun:1-alpine AS runner

USER bun
WORKDIR /app

# Workspace-resolved node_modules (includes symlink to packages/types)
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules

# Workspace dependency: @pedi/chika-types (Bun resolves TS directly)
COPY --chown=bun:bun packages/types/ ./packages/types/

# Server source
COPY --chown=bun:bun server/src/                       ./server/src/
COPY --chown=bun:bun server/auth.config.*              ./server/
COPY --chown=bun:bun server/package.json               ./server/

# Root package.json for Bun workspace resolution
COPY --chown=bun:bun package.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENV NODE_ENV=production

CMD ["bun", "run", "--smol", "server/src/index.ts"]
