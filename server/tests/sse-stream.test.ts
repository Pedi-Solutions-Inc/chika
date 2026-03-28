/**
 * SSE stream tests — connect, message delivery, heartbeat, gap-fill, resync,
 * since_time, closed-channel rejection, and cleanup.
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
  readSSEEvents,
  sleep,
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
// Basic stream connection
// ---------------------------------------------------------------------------

describe('GET /channels/:channelId/stream', () => {
  it('returns 200 with text/event-stream content type', async () => {
    const { channelId } = await createTestChannel(app, 'ch-stream-ct');
    const res = await app.request(`/channels/${channelId}/stream`);
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/event-stream');
  });

  it('returns 404 when channel does not exist', async () => {
    const res = await app.request('/channels/nonexistent-stream/stream');
    expect(res.status).toBe(404);
  });

  it('returns 410 for closed channel', async () => {
    const { channelId } = await createTestChannel(app, 'ch-stream-closed');

    await app.request(`/internal/channels/${channelId}/close`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'test-api-key-12345678' },
    });

    const res = await app.request(`/channels/${channelId}/stream`);
    expect(res.status).toBe(410);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('closed');
  });

  it('sends heartbeat event as first SSE event', async () => {
    const { channelId } = await createTestChannel(app, 'ch-heartbeat');
    const events = await collectSSEEvents(app, `/channels/${channelId}/stream`, {}, 1, 1000);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const hb = events.find((e) => e.event === 'heartbeat');
    expect(hb).toBeDefined();
  });

  it('heartbeat event has no id field (prevents Last-Event-ID contamination)', async () => {
    const { channelId } = await createTestChannel(app, 'ch-hb-no-id');
    const events = await collectSSEEvents(app, `/channels/${channelId}/stream`, {}, 1, 1000);

    const hb = events.find((e) => e.event === 'heartbeat');
    expect(hb).toBeDefined();
    expect(hb!.id).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Last-Event-ID reconnect gap-fill
  // ---------------------------------------------------------------------------

  it('replays missed messages when Last-Event-ID is provided on reconnect', async () => {
    const ch = 'ch-gapfill';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    // Send first message and capture its id
    const r1 = await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-1' });
    const b1 = await r1.json() as Record<string, string>;
    const firstId = b1.id;

    // Send two more messages while "disconnected"
    await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-2' });
    await sendMessage(app, ch, { sender_id: 'alice', body: 'msg-3' });

    // Reconnect with Last-Event-ID = firstId — should receive msg-2 and msg-3
    const events = await collectSSEEvents(
      app,
      `/channels/${ch}/stream`,
      { 'Last-Event-ID': firstId },
      5,
      1500,
    );

    const messageEvents = events.filter((e) => e.event === 'message');
    expect(messageEvents.length).toBe(2);
    const bodies = messageEvents.map((e) => JSON.parse(e.data!).body);
    expect(bodies).toContain('msg-2');
    expect(bodies).toContain('msg-3');
  });

  it('emits resync event when Last-Event-ID is not found in DB', async () => {
    const { channelId } = await createTestChannel(app, 'ch-resync');

    // Use a fake / non-existent ObjectId
    const fakeId = '000000000000000000000001';
    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/stream`,
      { 'Last-Event-ID': fakeId },
      3,
      1500,
    );

    const resync = events.find((e) => e.event === 'resync');
    expect(resync).toBeDefined();
  });

  it('emits resync event when Last-Event-ID is malformed', async () => {
    const { channelId } = await createTestChannel(app, 'ch-resync-bad-id');

    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/stream`,
      { 'Last-Event-ID': 'not-a-valid-object-id!!!' },
      3,
      1500,
    );

    const resync = events.find((e) => e.event === 'resync');
    expect(resync).toBeDefined();
  });

  it('message events include an id field matching the message id', async () => {
    const ch = 'ch-msg-id';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    // Send two messages — use the first message's ID as Last-Event-ID to replay the second
    const res1 = await sendMessage(app, ch, { sender_id: 'alice', body: 'first' });
    const body1 = await res1.json() as Record<string, string>;
    const firstId = body1.id;

    const res2 = await sendMessage(app, ch, { sender_id: 'alice', body: 'id-test' });
    const body2 = await res2.json() as Record<string, string>;
    const msgId = body2.id;

    // Reconnect with first message's ID — second message should be replayed
    const events = await collectSSEEvents(
      app,
      `/channels/${ch}/stream`,
      { 'Last-Event-ID': firstId },
      5,
      1500,
    );

    const msgEvent = events.find(
      (e) => e.event === 'message' && JSON.parse(e.data ?? '{}').id === msgId,
    );
    expect(msgEvent).toBeDefined();
    expect(msgEvent!.id).toBe(msgId);
  });

  // ---------------------------------------------------------------------------
  // since_time query parameter
  // ---------------------------------------------------------------------------

  it('replays messages sent after since_time on fresh connect', async () => {
    const ch = 'ch-since-time';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await joinChannel(app, ch, alice);

    // Record time before sending messages
    const since = new Date().toISOString();

    await sleep(5); // ensure created_at > since
    await sendMessage(app, ch, { sender_id: 'alice', body: 'after-since' });

    const events = await collectSSEEvents(
      app,
      `/channels/${ch}/stream?since_time=${encodeURIComponent(since)}`,
      {},
      5,
      1500,
    );

    const msgEvents = events.filter((e) => e.event === 'message');
    expect(msgEvents.length).toBe(1);
    expect(JSON.parse(msgEvents[0]!.data!).body).toBe('after-since');
  });

  it('since_time with no matching messages delivers only heartbeat', async () => {
    const { channelId } = await createTestChannel(app, 'ch-since-empty');
    const future = new Date(Date.now() + 60_000).toISOString();

    const events = await collectSSEEvents(
      app,
      `/channels/${channelId}/stream?since_time=${encodeURIComponent(future)}`,
      {},
      2,
      1000,
    );

    const msgEvents = events.filter((e) => e.event === 'message');
    expect(msgEvents.length).toBe(0);
    const hbEvents = events.filter((e) => e.event === 'heartbeat');
    expect(hbEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Multiple concurrent streams
  // ---------------------------------------------------------------------------

  it('supports multiple concurrent streams on the same channel', async () => {
    const ch = 'ch-multi-stream';
    const alice = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    const bob = makeParticipant({ id: 'bob', name: 'Bob', role: 'driver' });
    await joinChannel(app, ch, alice);
    await joinChannel(app, ch, bob);

    // Open two streams concurrently — both should return 200 event-stream
    const [res1, res2] = await Promise.all([
      app.request(`/channels/${ch}/stream`),
      app.request(`/channels/${ch}/stream`),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.headers.get('content-type')).toContain('text/event-stream');
    expect(res2.headers.get('content-type')).toContain('text/event-stream');

    // Cancel both streams
    await Promise.all([
      res1.body?.cancel(),
      res2.body?.cancel(),
    ]);
  });

  // ---------------------------------------------------------------------------
  // X-Request-ID header
  // ---------------------------------------------------------------------------

  it('returns X-Request-ID header on stream response', async () => {
    const { channelId } = await createTestChannel(app, 'ch-req-id');
    const res = await app.request(`/channels/${channelId}/stream`);
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    await res.body?.cancel();
  });

  it('echoes X-Request-ID from request header', async () => {
    const { channelId } = await createTestChannel(app, 'ch-req-id-echo');
    const res = await app.request(`/channels/${channelId}/stream`, {
      headers: { 'x-request-id': 'my-trace-id-123' },
    });
    expect(res.headers.get('x-request-id')).toBe('my-trace-id-123');
    await res.body?.cancel();
  });
});
