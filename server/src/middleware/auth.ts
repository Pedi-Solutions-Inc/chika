import { createMiddleware } from 'hono/factory';
import type { AuthConfig, AuthValidatorContext } from '@pedi/chika-types';
import { createComponentLogger } from '../logger';

const log = createComponentLogger('auth');

// ---------------------------------------------------------------------------
// Dynamic config loader
// ---------------------------------------------------------------------------

let authConfig: AuthConfig | null | undefined; // undefined = not yet loaded

async function loadAuthConfig(): Promise<AuthConfig | null> {
  if (authConfig !== undefined) return authConfig;

  try {
    const mod = await import('../../auth.config');
    const cfg: AuthConfig = mod.default ?? mod;

    if (typeof cfg.validate !== 'function') {
      log.warn('auth.config found but validate is not a function — auth disabled');
      authConfig = null;
      return null;
    }

    log.info('auth.config loaded — token validation enabled');
    authConfig = cfg;
    return cfg;
  } catch (err: unknown) {
    // Module not found is expected when no auth is configured.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      log.info('no auth.config found — auth disabled');
    } else if (err instanceof Error && err.message?.includes('Cannot find module')) {
      log.info('no auth.config found — auth disabled');
    } else {
      log.error('failed to load auth.config', { error: err as Error });
    }
    authConfig = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  valid: boolean;
  userId?: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry;
}

const MAX_CACHE_SIZE = 10_000;

function setCache(key: string, valid: boolean, ttl: number, userId?: string) {
  if (ttl <= 0) return;
  if (cache.size >= MAX_CACHE_SIZE && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { valid, userId, expiresAt: Date.now() + ttl });
}

// Periodic cleanup to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Pre-load the config at startup so the first request isn't delayed. */
export async function initAuth() {
  await loadAuthConfig();
}

export const requireAuth = createMiddleware(async (c, next) => {
  const cfg = await loadAuthConfig();

  // No config → auth disabled, allow everything.
  if (!cfg) {
    await next();
    return;
  }

  const channelId = c.req.param('channelId') ?? '';

  // Build headers record (lowercased keys).
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const ctx: AuthValidatorContext = { headers, channelId };

  // Cache key
  const validTtl = cfg.cacheTtl ?? 300_000;
  const invalidTtl = cfg.invalidCacheTtl ?? 2_000;
  const cacheKeyFn = cfg.cacheKey ?? ((c: AuthValidatorContext) => c.headers['authorization'] ?? null);
  const cacheKey = cacheKeyFn(ctx);

  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) {
      if (cached.valid) {
        await next();
        return;
      }
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  // Call the user-provided validator.
  try {
    const result = await cfg.validate(ctx);

    if (cacheKey) {
      setCache(
        cacheKey,
        result.valid,
        result.valid ? validTtl : invalidTtl,
        result.userId,
      );
    }

    if (!result.valid) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  } catch (err) {
    log.error('auth validator threw', { error: err as Error });
    return c.json({ error: 'Authentication error' }, 500);
  }
});
