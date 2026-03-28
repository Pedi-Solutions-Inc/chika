/**
 * Message sending tests — happy path, idempotency, auth, ordering, validation.
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
  jsonHeaders,
  apiHeaders,
} from './helpers';
import type { Hono } from 'hono';

let app: Hono;

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
// Send message — happy path
// ---------------------------------------------------------------------------

describe('POST /channels/:channelId/messages', () => {
  it('sends a message and returns 201 with id and created_at', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-send');
    const res = await sendMessage(app, channelId, {
      sender_id: participant.id,
      type: 'text',
      body: 'Hello world',
    });

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.id).toBe('string');
    expect((body.id as string).length).toBeGreaterThan(0);
    expect(typeof body.created_at).toBe('string');
  });

  it('returns 404 when channel does not exist', async () => {
    const res = await sendMessage(app, 'nonexistent-channel', {
      sender_id: 'user-1',
      body: 'hello',
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('not found');
  });

  it('returns 410 when channel is closed', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-closed-msg');

    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'test-api-key-12345678' },
    });

    const res = await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'hello',
    });
    expect(res.status).toBe(410);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('closed');
  });

  it('returns 403 when sender has not joined the channel', async () => {
    // Create channel with alice
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, 'ch-nonjoin', alice);

    // Bob tries to send without joining
    const res = await sendMessage(app, 'ch-nonjoin', {
      sender_id: 'bob-not-joined',
      body: 'sneaky message',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('joined');
  });

  it('returns 400 for empty body', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-empty-body');
    const res = await app.request(`/channels/${channelId}/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sender_id: participant.id, type: 'text', body: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for body exceeding 10,000 characters', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-long-body');
    const res = await app.request(`/channels/${channelId}/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        sender_id: participant.id,
        type: 'text',
        body: 'x'.repeat(10_001),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('sends a message with attributes', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-attrs');
    const res = await sendMessage(app, channelId, {
      sender_id: participant.id,
      type: 'location',
      body: 'I am here',
      attributes: { lat: 40.7128, lng: -74.006 },
    });
    expect(res.status).toBe(201);
  });

  it('messages are ordered by ULID-based _id (creation order)', async () => {
    const ch = 'ch-order';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    const bodies = ['first', 'second', 'third'];
    for (const b of bodies) {
      await sendMessage(app, ch, { sender_id: 'alice', body: b });
    }

    // Re-join to get history
    const res = await joinChannel(app, ch, alice);
    const data = await res.json() as Record<string, unknown>;
    const messages = data.messages as Record<string, string>[];

    expect(messages.length).toBe(3);
    expect(messages[0]!.body).toBe('first');
    expect(messages[1]!.body).toBe('second');
    expect(messages[2]!.body).toBe('third');
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  it('deduplicates messages with the same idempotency key', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-idempotent');

    const res1 = await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'first send',
      idempotency_key: 'idem-key-abc',
    });
    expect(res1.status).toBe(201);
    const body1 = await res1.json() as Record<string, string>;

    // Send again with the same key
    const res2 = await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'second send (duplicate)',
      idempotency_key: 'idem-key-abc',
    });
    expect(res2.status).toBe(201);
    const body2 = await res2.json() as Record<string, string>;

    // Both must return the same id and created_at
    expect(body2.id).toBe(body1.id);
    expect(body2.created_at).toBe(body1.created_at);
  });

  it('stores only one message in DB for duplicate idempotency key', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-idem-db');

    await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'msg',
      idempotency_key: 'unique-key-xyz',
    });
    await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'msg again',
      idempotency_key: 'unique-key-xyz',
    });

    // Get history via internal API
    const histRes = await app.request(`/internal/channels/${channelId}/messages`, {
      headers: { 'X-Api-Key': 'test-api-key-12345678' },
    });
    const hist = await histRes.json() as Record<string, unknown>;
    const messages = hist.messages as unknown[];
    expect(messages.length).toBe(1);
  });

  it('allows same idempotency key on different channels', async () => {
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, 'ch-idem-1', alice);
    await joinChannel(app, 'ch-idem-2', alice);

    const r1 = await sendMessage(app, 'ch-idem-1', {
      sender_id: 'alice',
      body: 'msg',
      idempotency_key: 'shared-key',
    });
    const r2 = await sendMessage(app, 'ch-idem-2', {
      sender_id: 'alice',
      body: 'msg',
      idempotency_key: 'shared-key',
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    const b1 = await r1.json() as Record<string, string>;
    const b2 = await r2.json() as Record<string, string>;
    // Different message IDs since they're on different channels
    expect(b1.id).not.toBe(b2.id);
  });

  it('different idempotency keys produce different messages', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-diff-keys');

    const r1 = await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'msg 1',
      idempotency_key: 'key-1',
    });
    const r2 = await sendMessage(app, channelId, {
      sender_id: participant.id,
      body: 'msg 2',
      idempotency_key: 'key-2',
    });

    const b1 = await r1.json() as Record<string, string>;
    const b2 = await r2.json() as Record<string, string>;
    expect(b1.id).not.toBe(b2.id);
  });

  it('validates idempotency_key max length of 64 characters', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-idem-len');
    const res = await app.request(`/channels/${channelId}/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        sender_id: participant.id,
        type: 'text',
        body: 'test',
        idempotency_key: 'k'.repeat(65),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing required fields', async () => {
    const { channelId } = await createTestChannel(app, 'ch-missing-fields');
    const res = await app.request(`/channels/${channelId}/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ body: 'hello' }), // missing sender_id and type
    });
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // System messages via internal API
  // ---------------------------------------------------------------------------

  it('sends system message via internal API with sender_id null and sender_role system', async () => {
    const { channelId } = await createTestChannel(app, 'ch-system-msg');

    const res = await app.request(`/internal/channels/${channelId}/messages`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ type: 'system_notification', body: 'Ride started' }),
    });
    expect(res.status).toBe(201);
    const msgRes = await res.json() as Record<string, string>;
    expect(typeof msgRes.id).toBe('string');

    // Verify message via history
    const histRes = await app.request(`/internal/channels/${channelId}/messages`, {
      headers: { 'X-Api-Key': 'test-api-key-12345678' },
    });
    const hist = await histRes.json() as Record<string, unknown>;
    const messages = hist.messages as Record<string, unknown>[];
    const systemMsg = messages.find((m) => m.sender_id === null);
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.sender_role).toBe('system');
    expect(systemMsg!.type).toBe('system_notification');
  });
});
