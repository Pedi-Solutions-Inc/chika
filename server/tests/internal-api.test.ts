/**
 * Internal API tests — system messages, message history pagination, channel
 * close, API key validation, timing-safe comparison.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { startMongo, stopMongo, cleanDatabase, fixIdempotencyIndex } from './setup';
import { connectDb, disconnectDb } from '../src/db';
import {
  createTestApp,
  joinChannel,
  sendMessage,
  makeParticipant,
  createTestChannel,
  apiHeaders,
  jsonHeaders,
  sleep,
} from './helpers';
import type { Hono } from 'hono';

let app: Hono;

const VALID_API_KEY = 'test-api-key-12345678';

beforeAll(async () => {
  await startMongo();
  await connectDb();
  await fixIdempotencyIndex();
  app = createTestApp();
});

afterAll(async () => {
  await disconnectDb();
  await stopMongo();
});

beforeEach(async () => {
  await cleanDatabase();
});

// ---------------------------------------------------------------------------
// API key middleware
// ---------------------------------------------------------------------------

describe('API key middleware', () => {
  it('returns 401 when X-Api-Key header is missing', async () => {
    const res = await app.request('/internal/channels/ch-any/messages', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ type: 'text', body: 'hello' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when X-Api-Key is wrong', async () => {
    const res = await app.request('/internal/channels/ch-any/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'wrong-key' },
      body: JSON.stringify({ type: 'text', body: 'hello' }),
    });
    expect(res.status).toBe(401);
  });

  it('allows request with correct X-Api-Key', async () => {
    const { channelId } = await createTestChannel(app, 'ch-key-valid');
    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ type: 'text', body: 'hello' }),
    });
    // 201 (message sent) — not 401
    expect(res.status).toBe(201);
  });

  it('uses timing-safe comparison — different length key returns 401 not timing error', async () => {
    // A key with different byte length should fail safely
    const res = await app.request('/internal/channels/ch-any/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'short' },
      body: JSON.stringify({ type: 'text', body: 'hello' }),
    });
    expect(res.status).toBe(401);
  });

  it('timing-safe comparison — same length wrong key returns 401', async () => {
    // Same byte length as 'test-api-key-12345678' (20 chars) but different content
    const sameLen = 'test-api-key-XXXXXXXX';
    const res = await app.request('/internal/channels/ch-any/close', {
      method: 'POST',
      headers: { 'X-Api-Key': sameLen },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /internal/channels/:channelId/messages — system messages
// ---------------------------------------------------------------------------

describe('POST /internal/channels/:channelId/messages', () => {
  it('sends a system message with sender_id null and sender_role system', async () => {
    const { channelId } = await createTestChannel(app, 'ch-sys-msg');
    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ type: 'system_notification', body: 'Ride started' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, string>;
    expect(typeof body.id).toBe('string');
    expect(typeof body.created_at).toBe('string');
  });

  it('system message appears in history with correct fields', async () => {
    const { channelId } = await createTestChannel(app, 'ch-sys-hist');
    const sendRes = await app.request(`/internal/channels/${channelId}/messages`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ type: 'driver_arrived', body: 'Driver is here' }),
    });
    expect(sendRes.status).toBe(201);

    const histRes = await app.request(`/internal/channels/${channelId}/messages`, {
      headers: apiHeaders(),
    });
    const hist = await histRes.json() as Record<string, unknown>;
    const messages = hist.messages as Record<string, unknown>[];
    expect(messages.length).toBeGreaterThan(0);
    const sysMsg = messages.find((m) => m.sender_id === null);
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.sender_role).toBe('system');
    expect(sysMsg!.type).toBe('driver_arrived');
    expect(sysMsg!.body).toBe('Driver is here');
  });

  it('returns 404 for non-existent channel', async () => {
    const res = await app.request('/internal/channels/no-such-channel/messages', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ type: 'text', body: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 410 for closed channel', async () => {
    const { channelId } = await createTestChannel(app, 'ch-sys-closed');
    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ type: 'text', body: 'hello' }),
    });
    expect(res.status).toBe(410);
  });

  it('returns 400 for invalid request body', async () => {
    const { channelId } = await createTestChannel(app, 'ch-sys-invalid');
    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ body: 'no type field' }), // missing required type
    });
    expect(res.status).toBe(400);
  });

  it('sends system message with attributes', async () => {
    const { channelId } = await createTestChannel(app, 'ch-sys-attrs');
    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        type: 'location_update',
        body: 'Driver location updated',
        attributes: { lat: 51.5074, lng: -0.1278 },
      }),
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /internal/channels/:channelId/messages — history
// ---------------------------------------------------------------------------

describe('GET /internal/channels/:channelId/messages', () => {
  it('returns message history for a channel', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-hist-get');
    await sendMessage(app, channelId, { sender_id: participant.id, body: 'msg-1' });
    await sendMessage(app, channelId, { sender_id: participant.id, body: 'msg-2' });

    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      headers: apiHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.channel_id).toBe(channelId);
    const messages = body.messages as unknown[];
    expect(messages.length).toBe(2);
    expect(body.has_more).toBe(false);
    expect(Array.isArray(body.participants)).toBe(true);
  });

  it('returns 404 for non-existent channel', async () => {
    const res = await app.request('/internal/channels/missing-ch/messages', {
      headers: apiHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('respects limit parameter', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-hist-limit');
    for (let i = 0; i < 10; i++) {
      await sendMessage(app, channelId, { sender_id: participant.id, body: `msg-${i}` });
    }

    const res = await app.request(
      `/internal/channels/${channelId}/messages?limit=3`,
      { headers: apiHeaders() },
    );
    const body = await res.json() as Record<string, unknown>;
    const messages = body.messages as unknown[];
    expect(messages.length).toBe(3);
    expect(body.has_more).toBe(true);
  });

  it('default limit is 50', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-hist-default');
    // Only 5 messages — all fit in default limit
    for (let i = 0; i < 5; i++) {
      await sendMessage(app, channelId, { sender_id: participant.id, body: `msg-${i}` });
    }

    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      headers: apiHeaders(),
    });
    const body = await res.json() as Record<string, unknown>;
    const messages = body.messages as unknown[];
    expect(messages.length).toBe(5);
    expect(body.has_more).toBe(false);
  });

  it('supports before cursor for pagination', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-hist-before');
    for (let i = 0; i < 5; i++) {
      await sendMessage(app, channelId, { sender_id: participant.id, body: `msg-${i}` });
      await sleep(2);
    }

    // Get all messages first to find the created_at of msg-2
    const allRes = await app.request(`/internal/channels/${channelId}/messages`, {
      headers: apiHeaders(),
    });
    const allBody = await allRes.json() as Record<string, unknown>;
    const allMsgs = allBody.messages as Record<string, string>[];
    const cutoff = allMsgs[2]!.created_at; // created_at of msg-2 (0-indexed)

    // Fetch messages before the cutoff
    const res = await app.request(
      `/internal/channels/${channelId}/messages?before=${encodeURIComponent(cutoff)}`,
      { headers: apiHeaders() },
    );
    const body = await res.json() as Record<string, unknown>;
    const messages = body.messages as Record<string, string>[];
    // All messages should have created_at < cutoff
    for (const msg of messages) {
      expect(new Date(msg.created_at).getTime()).toBeLessThan(new Date(cutoff).getTime());
    }
  });

  it('supports after cursor for pagination', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-hist-after');
    for (let i = 0; i < 5; i++) {
      await sendMessage(app, channelId, { sender_id: participant.id, body: `msg-${i}` });
      await sleep(2);
    }

    const allRes = await app.request(`/internal/channels/${channelId}/messages`, {
      headers: apiHeaders(),
    });
    const allBody = await allRes.json() as Record<string, unknown>;
    const allMsgs = allBody.messages as Record<string, string>[];
    const cutoff = allMsgs[2]!.created_at;

    const res = await app.request(
      `/internal/channels/${channelId}/messages?after=${encodeURIComponent(cutoff)}`,
      { headers: apiHeaders() },
    );
    const body = await res.json() as Record<string, unknown>;
    const messages = body.messages as Record<string, string>[];
    for (const msg of messages) {
      expect(new Date(msg.created_at).getTime()).toBeGreaterThan(new Date(cutoff).getTime());
    }
  });

  it('max limit is 200', async () => {
    const { channelId } = await createTestChannel(app, 'ch-hist-maxlimit');
    const res = await app.request(
      `/internal/channels/${channelId}/messages?limit=201`,
      { headers: apiHeaders() },
    );
    expect(res.status).toBe(400);
  });

  it('has_more is true when there are more messages than limit', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-hist-more');
    for (let i = 0; i < 5; i++) {
      await sendMessage(app, channelId, { sender_id: participant.id, body: `msg-${i}` });
    }
    const res = await app.request(
      `/internal/channels/${channelId}/messages?limit=2`,
      { headers: apiHeaders() },
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body.has_more).toBe(true);
    const messages = body.messages as unknown[];
    expect(messages.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// POST /internal/channels/:channelId/close
// ---------------------------------------------------------------------------

describe('POST /internal/channels/:channelId/close', () => {
  it('closes an active channel and returns closed status', async () => {
    const { channelId } = await createTestChannel(app, 'ch-close-ok');
    const res = await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.channel_id).toBe(channelId);
    expect(body.status).toBe('closed');
  });

  it('returns 410 when channel is already closed', async () => {
    const { channelId } = await createTestChannel(app, 'ch-close-twice');
    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: apiHeaders(),
    });

    const res2 = await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    expect(res2.status).toBe(410);
    const body = await res2.json() as Record<string, unknown>;
    expect(body.error).toContain('closed');
  });

  it('returns 404 for non-existent channel', async () => {
    const res = await app.request('/internal/channels/never-created/close', {
      method: 'POST',
      headers: apiHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it('after close, sending a message returns 410', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-close-msg');
    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const res = await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'should fail',
    });
    expect(res.status).toBe(410);
  });

  it('after close, joining returns 410', async () => {
    const { channelId } = await createTestChannel(app, 'ch-close-join');
    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    const res = await joinChannel(app, channelId, bob);
    expect(res.status).toBe(410);
  });

  it('after close, SSE stream returns 410', async () => {
    const { channelId } = await createTestChannel(app, 'ch-close-stream');
    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const res = await app.request(`/channels/${channelId}/stream`);
    expect(res.status).toBe(410);
  });

  it('returns 401 without API key', async () => {
    const { channelId } = await createTestChannel(app, 'ch-close-nokey');
    const res = await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });
});
