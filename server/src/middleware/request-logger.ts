import { createMiddleware } from 'hono/factory';
import { log } from '../logger';
import type { Logger } from '../logger';

/** Hono context key for the request-scoped logger. */
const LOGGER_KEY = 'reqLog';
const REQUEST_ID_KEY = 'requestId';

/** Short random ID — 8 hex chars, no external deps. */
function generateRequestId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Middleware that:
 * 1. Generates a unique request ID (or uses the incoming X-Request-ID header)
 * 2. Creates a child logger with request context (method, path, requestId)
 * 3. Logs the incoming request and outgoing response with timing
 * 4. Adds X-Request-ID to the response headers
 */
export const requestLogger = createMiddleware(async (c, next) => {
  const requestId =
    c.req.header('x-request-id') ?? generateRequestId();

  const method = c.req.method;
  const path = c.req.path;
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown';

  const reqLog = log.child({ requestId, method, path });
  c.set(LOGGER_KEY, reqLog);
  c.set(REQUEST_ID_KEY, requestId);

  reqLog.info('request started', { ip });

  c.header('X-Request-ID', requestId);

  const start = performance.now();
  await next();
  const duration = Math.round(performance.now() - start);

  const status = c.res.status;
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  reqLog[level]('request completed', { status, duration: `${duration}ms` });
});

/** Get the request-scoped logger from Hono context. Falls back to root logger. */
export function getRequestLogger(c: { get: (key: string) => unknown }): Logger {
  return (c.get(LOGGER_KEY) as Logger | undefined) ?? log;
}

/** Get the request ID from Hono context. */
export function getRequestId(c: { get: (key: string) => unknown }): string | undefined {
  return c.get(REQUEST_ID_KEY) as string | undefined;
}
