/**
 * Unread notification system tests — snapshot on connect, update on new message,
 * clear on mark-read, cursor invariants, multi-participant independence.
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
  collectSSEEvents,
  markRead,
  sleep,
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
// Helpers
// ---------------------------------------------------------------------------

function parseSSEData<T>(data: string | undefined): T {
  return JSON.parse(data ?? '{}') as T;
}

// ---------------------------------------------------------------------------
// Unread snapshot on connect
// ---------------------------------------------------------------------------

describe('GET /channels/:channelId/unread', () => {
  it('returns 400 when participant_id is missing', async () => {
    const { channelId } = await createTestChannel(app, 'ch-unread-nopid');
    const res = await app.request(`/channels/${channelId}/unread`);
    expect(res.status).toBe(400);
  });

  it('returns 410 for closed channel', async () => {
    const { channelId } = await createTestChannel(app, 'ch-unread-closed');
    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'test-api-key-12345678' },
    });
    const res = await app.request(`/channels/${channelId}/unread?participant_id=user-1`);
    expect(res.status).toBe(410);
  });

  it('returns 200 event-stream for non-existent channel (passive / count 0)', async () => {
    const res = await app.request('/channels/ch-never-existed/unread?participant_id=user-1');
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('sends unread_snapshot event as first event', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-snapshot');
    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/unread?participant_id=${participant.id}`,
      {},
      2,
      1000,
    );

    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    expect(snapshot).toBeDefined();
    const data = parseSSEData<{ channel_id: string; unread_count: number; last_message_at: string | null }>(snapshot!.data);
    expect(data.channel_id).toBe(channelId);
    expect(typeof data.unread_count).toBe('number');
  });

  it('snapshot unread_count is 0 for fresh channel with no messages', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-snap-zero');
    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/unread?participant_id=${participant.id}`,
      {},
      2,
      1000,
    );

    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    const data = parseSSEData<{ unread_count: number }>(snapshot!.data);
    expect(data.unread_count).toBe(0);
  });

  it('snapshot reflects unread messages for a participant who has not read them', async () => {
    const ch = 'ch-snap-unread';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });

    // Alice joins first, then Bob joins (Bob's join auto-marks any existing messages as read)
    await joinChannel(app, ch, alice);
    await joinChannel(app, ch, bob);

    // Alice sends 3 messages AFTER Bob joined — Bob has 3 unread from alice
    await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-1' });
    await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-2' });
    await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-3' });

    // Bob's unread snapshot should show 3
    const events = await collectSSEEvents(
      app,
      `/channels/${ch}/unread?participant_id=bob`,
      {},
      2,
      1000,
    );

    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    expect(snapshot).toBeDefined();
    const data = parseSSEData<{ unread_count: number }>(snapshot!.data);
    expect(data.unread_count).toBe(3);
  });

  it('snapshot unread_count excludes sender own messages', async () => {
    const ch = 'ch-snap-own';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    // Alice sends 5 messages to herself (own messages should not count as unread)
    for (let i = 0; i < 5; i++) {
      await sendMessage(app, ch, { sender_id: 'alice', body: `msg-${i}` });
    }

    const events = await collectSSEEvents(
      app,
      `/channels/${ch}/unread?participant_id=alice`,
      {},
      2,
      1000,
    );

    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    const data = parseSSEData<{ unread_count: number }>(snapshot!.data);
    // Alice's own messages should not be counted as unread for Alice
    expect(data.unread_count).toBe(0);
  });

  it('snapshot last_message_at is null for channel with no messages', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-snap-null-ts');
    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/unread?participant_id=${participant.id}`,
      {},
      2,
      1000,
    );
    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    const data = parseSSEData<{ last_message_at: string | null }>(snapshot!.data);
    expect(data.last_message_at).toBeNull();
  });

  it('snapshot last_message_at is set after a message is sent', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-snap-ts');
    await sendMessage(app, channelId, { sender_id: participant.id, body: 'hello' });

    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/unread?participant_id=${participant.id}`,
      {},
      2,
      1000,
    );
    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    const data = parseSSEData<{ last_message_at: string | null }>(snapshot!.data);
    expect(data.last_message_at).not.toBeNull();
    expect(typeof data.last_message_at).toBe('string');
  });

  it('sends heartbeat after snapshot event', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-unread-hb');
    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/unread?participant_id=${participant.id}`,
      {},
      3,
      1500,
    );
    const hb = events.find((e) => e.event === 'heartbeat');
    expect(hb).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Mark-read advances cursor
  // ---------------------------------------------------------------------------

  it('mark-read returns success and lowers unread count on next snapshot', async () => {
    const ch = 'ch-markread';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    await joinChannel(app, ch, alice);
    await joinChannel(app, ch, bob);

    // Alice sends messages
    await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-1' });
    const r2 = await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-2' });
    const b2 = await r2.json() as Record<string, string>;

    // Bob marks the second message as read
    const markRes = await markRead(app, ch, 'bob', b2.id);
    expect(markRes.status).toBe(200);
    const markBody = await markRes.json() as Record<string, unknown>;
    expect(markBody.success).toBe(true);

    // Bob's snapshot should now show 0 unread (he read everything up to msg-2)
    const events = await collectSSEEvents(
      app,
      `/channels/${ch}/unread?participant_id=bob`,
      {},
      2,
      1000,
    );
    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    const data = parseSSEData<{ unread_count: number }>(snapshot!.data);
    expect(data.unread_count).toBe(0);
  });

  it('read cursor never regresses — marking old message does not increase unread', async () => {
    const ch = 'ch-cursor-guard';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    await joinChannel(app, ch, alice);
    await joinChannel(app, ch, bob);

    const r1 = await sendMessage(app, ch, { sender_id: 'alice', body: 'first' });
    const b1 = await r1.json() as Record<string, string>;
    const r2 = await sendMessage(app, ch, { sender_id: 'alice', body: 'second' });
    const b2 = await r2.json() as Record<string, string>;

    // Bob reads the second (later) message first
    await markRead(app, ch, 'bob', b2.id);

    // Now Bob tries to "mark read" the first (earlier) message — cursor must not regress
    await markRead(app, ch, 'bob', b1.id);

    // Snapshot should still be 0 unread (cursor stayed at b2)
    const events = await collectSSEEvents(
      app,
      `/channels/${ch}/unread?participant_id=bob`,
      {},
      2,
      1000,
    );
    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    const data = parseSSEData<{ unread_count: number }>(snapshot!.data);
    expect(data.unread_count).toBe(0);
  });

  it('mark-read returns 404 for non-existent message', async () => {
    const { channelId, participant } = await createTestChannel(app, 'ch-markread-404');
    const res = await markRead(app, channelId, participant.id, '000000000000000000000001');
    expect(res.status).toBe(404);
  });

  it('mark-read returns 403 when participant not in channel', async () => {
    const { channelId } = await createTestChannel(app, 'ch-markread-403');

    // Create a message
    const alice = makeParticipant({ id: 'alice-403', name: 'Alice', role: 'rider' });
    await joinChannel(app, channelId, alice);
    const r = await sendMessage(app, channelId, { sender_id: 'alice-403', body: 'hello' });
    const b = await r.json() as Record<string, string>;

    const res = await markRead(app, channelId, 'stranger-not-in-channel', b.id);
    expect(res.status).toBe(403);
  });

  it('mark-read returns 404 for non-existent channel', async () => {
    const res = await markRead(app, 'no-such-channel', 'user-1', '000000000000000000000001');
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Independent unread counts per participant
  // ---------------------------------------------------------------------------

  it('multiple participants have independent unread counts', async () => {
    const ch = 'ch-multi-unread';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    const carol = makeParticipant({ id: 'carol', name: 'Carol', role: 'agent' });

    await joinChannel(app, ch, alice);
    await joinChannel(app, ch, bob);
    await joinChannel(app, ch, carol);

    // Alice sends 2 messages
    await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-1' });
    const r2 = await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-2' });
    const b2 = await r2.json() as Record<string, string>;

    // Bob reads both
    await markRead(app, ch, 'bob', b2.id);
    // Carol reads nothing

    // Check snapshots
    const [bobEvents, carolEvents] = await Promise.all([
      collectSSEEvents(app, `/channels/${ch}/unread?participant_id=bob`, {}, 2, 1000),
      collectSSEEvents(app, `/channels/${ch}/unread?participant_id=carol`, {}, 2, 1000),
    ]);

    const bobSnap = parseSSEData<{ unread_count: number }>(
      bobEvents.find((e) => e.event === 'unread_snapshot')!.data,
    );
    const carolSnap = parseSSEData<{ unread_count: number }>(
      carolEvents.find((e) => e.event === 'unread_snapshot')!.data,
    );

    expect(bobSnap.unread_count).toBe(0);
    expect(carolSnap.unread_count).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // unread_snapshot for non-participant on existing channel
  // ---------------------------------------------------------------------------

  it('returns unread_snapshot with count 0 for non-participant watching existing channel', async () => {
    const { channelId } = await createTestChannel(app, 'ch-nonpart-unread');

    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/unread?participant_id=watcher-not-in-channel`,
      {},
      2,
      1000,
    );

    const snapshot = events.find((e) => e.event === 'unread_snapshot');
    expect(snapshot).toBeDefined();
    const data = parseSSEData<{ unread_count: number }>(snapshot!.data);
    expect(data.unread_count).toBe(0);
  });
});
