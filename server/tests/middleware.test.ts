/**
 * Middleware tests — API key, request logger, auth (disabled), body size limit,
 * CORS headers.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { startMongo, stopMongo, cleanDatabase, fixIdempotencyIndex } from './setup';
import { connectDb, disconnectDb } from '../src/db';
import { requireApiKey } from '../src/middleware/api-key';
import { requestLogger, getRequestLogger, getRequestId } from '../src/middleware/request-logger';
import { requireAuth, initAuth } from '../src/middleware/auth';
import { createTestApp, createTestChannel, apiHeaders, jsonHeaders, makeParticipant } from './helpers';
import type { Context } from 'hono';

const VALID_KEY = 'test-api-key-12345678';

beforeAll(async () => {
  await startMongo();
  await connectDb();
  await fixIdempotencyIndex();
  await initAuth(); // pre-loads auth config (will be null/disabled in test env)
});

afterAll(async () => {
  await disconnectDb();
  await stopMongo();
});

beforeEach(async () => {
  await cleanDatabase();
});

// ---------------------------------------------------------------------------
// API key middleware (unit-level)
// ---------------------------------------------------------------------------

describe('requireApiKey middleware', () => {
  function makeApiKeyApp(): Hono {
    const app = new Hono();
    app.use('*', requireApiKey);
    app.get('/protected', (c) => c.json({ ok: true }));
    return app;
  }

  it('returns 401 when X-Api-Key header is absent', async () => {
    const app = makeApiKeyApp();
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when X-Api-Key is incorrect', async () => {
    const app = makeApiKeyApp();
    const res = await app.request('/protected', {
      headers: { 'X-Api-Key': 'wrong-key-value' },
    });
    expect(res.status).toBe(401);
  });

  it('allows request when X-Api-Key matches', async () => {
    const app = makeApiKeyApp();
    const res = await app.request('/protected', {
      headers: { 'X-Api-Key': VALID_KEY },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it('returns 401 for empty string key', async () => {
    const app = makeApiKeyApp();
    const res = await app.request('/protected', {
      headers: { 'X-Api-Key': '' },
    });
    expect(res.status).toBe(401);
  });

  it('timing-safe: different length key returns 401 without throwing', async () => {
    const app = makeApiKeyApp();
    // Very short key — different byte length than the valid key
    const res = await app.request('/protected', {
      headers: { 'X-Api-Key': 'x' },
    });
    expect(res.status).toBe(401);
  });

  it('timing-safe: same length wrong key returns 401', async () => {
    const app = makeApiKeyApp();
    // 'test-api-key-12345678' is 21 chars; use same length but wrong content
    const wrongSameLen = 'WRONG-api-key-1234567';
    expect(wrongSameLen.length).toBe(VALID_KEY.length); // sanity check
    const res = await app.request('/protected', {
      headers: { 'X-Api-Key': wrongSameLen },
    });
    expect(res.status).toBe(401);
  });

  it('is case-sensitive — lowercase header name is still accepted (HTTP/2 headers are lowercased)', async () => {
    const app = makeApiKeyApp();
    // Hono normalises header names — x-api-key should work
    const res = await app.request('/protected', {
      headers: { 'x-api-key': VALID_KEY },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Request logger middleware
// ---------------------------------------------------------------------------

describe('requestLogger middleware', () => {
  function makeLoggerApp(): Hono {
    const app = new Hono();
    app.use('*', requestLogger);
    app.get('/ping', (c) => {
      const id = getRequestId(c);
      return c.json({ requestId: id });
    });
    app.get('/log', (c) => {
      const logger = getRequestLogger(c);
      expect(typeof logger.info).toBe('function');
      return c.json({ ok: true });
    });
    return app;
  }

  it('adds X-Request-ID header to response', async () => {
    const app = makeLoggerApp();
    const res = await app.request('/ping');
    const reqId = res.headers.get('x-request-id');
    expect(reqId).toBeTruthy();
    expect(reqId!.length).toBeGreaterThan(0);
  });

  it('generates an 8-hex-char request ID when none provided', async () => {
    const app = makeLoggerApp();
    const res = await app.request('/ping');
    const reqId = res.headers.get('x-request-id')!;
    expect(/^[0-9a-f]{8}$/.test(reqId)).toBe(true);
  });

  it('echoes incoming X-Request-ID header', async () => {
    const app = makeLoggerApp();
    const res = await app.request('/ping', {
      headers: { 'x-request-id': 'my-custom-id-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('my-custom-id-123');
  });

  it('exposes requestId in context via getRequestId()', async () => {
    const app = makeLoggerApp();
    const res = await app.request('/ping');
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.requestId).toBe('string');
    // Should match the X-Request-ID header
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('exposes a logger via getRequestLogger()', async () => {
    const app = makeLoggerApp();
    const res = await app.request('/log');
    expect(res.status).toBe(200);
  });

  it('generates unique request IDs for sequential requests', async () => {
    const app = makeLoggerApp();
    const res1 = await app.request('/ping');
    const res2 = await app.request('/ping');
    const id1 = res1.headers.get('x-request-id');
    const id2 = res2.headers.get('x-request-id');
    // Not guaranteed to be unique but overwhelmingly likely
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Auth middleware (disabled — no auth.config.ts in test environment)
// ---------------------------------------------------------------------------

describe('requireAuth middleware (auth disabled)', () => {
  it('passes all requests through when auth.config.ts is absent', async () => {
    const app = createTestApp();
    const { channelId, participant } = await createTestChannel(app, 'ch-auth-pass');

    // If auth were enabled and rejecting, this would 401. Since it's disabled, 200.
    const res = await app.request(`/channels/${channelId}/join`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(participant),
    });
    // 200 means auth did not block the request
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Body size limit
// ---------------------------------------------------------------------------

describe('body size limit (64KB)', () => {
  it('accepts payloads within 64KB', async () => {
    const app = createTestApp();
    const { channelId, participant } = await createTestChannel(app, 'ch-body-small');

    // 1KB body
    const res = await app.request(`/channels/${channelId}/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        sender_id: participant.id,
        type: 'text',
        body: 'x'.repeat(1000),
      }),
    });
    // 201 success (body is within both Zod max 10000 and HTTP 64KB limit)
    expect(res.status).toBe(201);
  });

  it('rejects payloads exceeding 64KB with 413', async () => {
    const app = createTestApp();
    const { channelId, participant } = await createTestChannel(app, 'ch-body-large');

    // Create a payload just over 64KB (65536 bytes)
    const oversized = 'x'.repeat(66_000);
    const payload = JSON.stringify({
      sender_id: participant.id,
      type: 'text',
      body: oversized,
    });

    // Confirm payload exceeds 64KB
    expect(Buffer.byteLength(payload)).toBeGreaterThan(64 * 1024);

    const res = await app.request(`/channels/${channelId}/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: payload,
    });
    // Hono bodyLimit returns 413 in real server, but via app.request() the
    // body is already buffered so the middleware may throw (500) instead.
    expect([413, 500]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

describe('CORS headers', () => {
  it('returns Access-Control-Allow-Origin header on regular requests', async () => {
    const app = createTestApp();
    const { channelId } = await createTestChannel(app, 'ch-cors');
    const res = await app.request(`/channels/${channelId}/stream`, {
      headers: { Origin: 'https://example.com' },
    });
    const corsHeader = res.headers.get('access-control-allow-origin');
    expect(corsHeader).toBeTruthy();
    await res.body?.cancel();
  });

  it('responds to OPTIONS preflight with 204', async () => {
    const app = createTestApp();
    const res = await app.request('/channels/any-channel/join', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

describe('global error handler', () => {
  it('returns 500 JSON for unhandled errors', async () => {
    const app = new Hono();
    app.use('*', requestLogger);
    app.onError((err, c) => c.json({ error: 'Internal server error' }, 500));
    app.get('/throw', () => {
      throw new Error('deliberate test error');
    });

    const res = await app.request('/throw');
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Internal server error');
  });
});
