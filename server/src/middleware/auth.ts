import { createMiddleware } from 'hono/factory';
import type { AuthConfig, AuthValidatorContext } from '@pedi/chika-types';

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
      console.warn('[chika-auth] auth.config found but `validate` is not a function — auth disabled');
      authConfig = null;
      return null;
    }

    console.log('[chika-auth] auth.config loaded — token validation enabled');
    authConfig = cfg;
    return cfg;
  } catch (err: unknown) {
    // Module not found is expected when no auth is configured.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      console.log('[chika-auth] No auth.config found — auth disabled');
    } else if (err instanceof Error && err.message?.includes('Cannot find module')) {
      console.log('[chika-auth] No auth.config found — auth disabled');
    } else {
      console.error('[chika-auth] Failed to load auth.config:', err);
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

function setCache(key: string, valid: boolean, ttl: number, userId?: string) {
  if (ttl <= 0) return;
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
    console.error('[chika-auth] Validator threw:', err);
    return c.json({ error: 'Authentication error' }, 500);
  }
});
