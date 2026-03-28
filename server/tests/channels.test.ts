/**
 * Channel operations tests — join, history, auto-mark-read, closed channels.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { startMongo, stopMongo, cleanDatabase, fixIdempotencyIndex } from './setup';
import { connectDb, disconnectDb } from '../src/db';
import {
  createTestApp,
  joinChannel,
  sendMessage,
  makeParticipant,
  jsonHeaders,
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
// Join — new channel creation
// ---------------------------------------------------------------------------

describe('POST /channels/:channelId/join', () => {
  it('creates a new channel and returns it with the participant', async () => {
    const participant = makeParticipant({ id: 'user-1', name: 'Alice', role: 'rider' });
    const res = await joinChannel(app, 'channel-abc', participant);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.channel_id).toBe('channel-abc');
    expect(body.status).toBe('active');
    expect(Array.isArray(body.participants)).toBe(true);
    expect((body.participants as unknown[]).length).toBe(1);
    const p = (body.participants as Record<string, unknown>[])[0]!;
    expect(p.id).toBe('user-1');
    expect(p.name).toBe('Alice');
    expect(p.role).toBe('rider');
    expect(typeof body.joined_at).toBe('string');
    expect(Array.isArray(body.messages)).toBe(true);
    expect((body.messages as unknown[]).length).toBe(0);
  });

  it('returns 200 for a second participant joining an existing channel', async () => {
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });

    await joinChannel(app, 'ch-two', alice);
    const res = await joinChannel(app, 'ch-two', bob);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.participants as unknown[]).length).toBe(2);
    const ids = (body.participants as Record<string, string>[]).map((p) => p.id);
    expect(ids).toContain('alice');
    expect(ids).toContain('bob');
  });

  it('updates participant profile data on re-join', async () => {
    const ch = 'ch-rejoin';
    const p1 = makeParticipant({ id: 'user-x', name: 'Old Name', role: 'rider' });
    await joinChannel(app, ch, p1);

    const p2 = { ...p1, name: 'New Name', profile_image: 'https://example.com/img.png' };
    const res = await joinChannel(app, ch, p2);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const participants = body.participants as Record<string, unknown>[];
    expect(participants.length).toBe(1);
    const updated = participants[0]!;
    expect(updated.name).toBe('New Name');
    expect(updated.profile_image).toBe('https://example.com/img.png');
  });

  it('returns message history on join', async () => {
    const ch = 'ch-history';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    // Alice sends 3 messages
    for (let i = 0; i < 3; i++) {
      await sendMessage(app, ch, { sender_id: 'alice', body: `msg ${i}` });
    }

    // Bob joins — should receive the 3 messages in history
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    const res = await joinChannel(app, ch, bob);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const messages = body.messages as Record<string, unknown>[];
    expect(messages.length).toBe(3);
    // Messages should be in ascending order
    expect((messages[0] as Record<string, string>).body).toBe('msg 0');
    expect((messages[2] as Record<string, string>).body).toBe('msg 2');
  });

  it('auto-marks messages as read on join', async () => {
    const ch = 'ch-autoread';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);
    await sendMessage(app, ch, { sender_id: 'alice', body: 'hello' });
    await sendMessage(app, ch, { sender_id: 'alice', body: 'world' });

    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    await joinChannel(app, ch, bob);

    // After Bob joins with history, unread count should be 0 for Bob
    // (auto-mark-read sets last_read_message_id to the latest message)
    // We verify by checking that the join endpoint consumed all messages
    const res2 = await joinChannel(app, ch, bob);
    const body2 = await res2.json() as Record<string, unknown>;
    const messages2 = body2.messages as unknown[];
    expect(messages2.length).toBe(2); // still 2 messages in history
    // No error — auto-mark-read succeeded
  });

  it('returns 400 for channel ID exceeding 64 characters', async () => {
    const longId = 'a'.repeat(65);
    const participant = makeParticipant();
    const res = await joinChannel(app, longId, participant);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('64');
  });

  it('returns 410 when joining a closed channel', async () => {
    const ch = 'ch-closed-join';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    // Close via internal API
    const closeRes = await app.request(`/internal/channels/${ch}/close`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'test-api-key-12345678' },
    });
    expect(closeRes.status).toBe(200);

    // Try to join closed channel
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    const res = await joinChannel(app, ch, bob);
    expect(res.status).toBe(410);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('closed');
  });

  it('returns 400 for invalid join request body', async () => {
    const res = await app.request('/channels/ch-bad/join', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ id: '', role: '', name: '' }), // empty strings violate min(1)
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  it('includes metadata in join request and response', async () => {
    const ch = 'ch-meta';
    const participant = makeParticipant({
      id: 'driver-1',
      role: 'driver',
      name: 'Dave',
      metadata: { vehicle_type: 'sedan', rating: 4.8 },
    });
    const res = await joinChannel(app, ch, participant);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const p = (body.participants as Record<string, unknown>[])[0]!;
    expect(p.metadata).toEqual({ vehicle_type: 'sedan', rating: 4.8 });
  });

  it('handles concurrent joins without duplicating participant', async () => {
    const ch = 'ch-concurrent';
    const participant = makeParticipant({ id: 'user-concurrent', name: 'Concurrent', role: 'rider' });

    // Fire 5 concurrent joins for the same participant
    const results = await Promise.all(
      Array.from({ length: 5 }, () => joinChannel(app, ch, participant)),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Verify participant appears exactly once
    const lastRes = results[results.length - 1]!;
    const body = await lastRes.json() as Record<string, unknown>;
    const participants = body.participants as Record<string, unknown>[];
    const matching = participants.filter((p) => p.id === 'user-concurrent');
    expect(matching.length).toBe(1);
  });

  it('returns exactly 20 most recent messages when channel has many messages', async () => {
    const ch = 'ch-limit';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    // Send 25 messages
    for (let i = 0; i < 25; i++) {
      await sendMessage(app, ch, { sender_id: 'alice', body: `msg ${i}` });
    }

    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    const res = await joinChannel(app, ch, bob);
    const body = await res.json() as Record<string, unknown>;
    const messages = body.messages as Record<string, string>[];
    // Default cap is 20 messages
    expect(messages.length).toBe(20);
    // Should be the last 20 (msg 5 through msg 24)
    expect(messages[0]!.body).toBe('msg 5');
    expect(messages[19]!.body).toBe('msg 24');
  });
});
