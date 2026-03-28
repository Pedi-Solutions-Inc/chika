/**
 * Database operations tests — indexes, aggregation correctness, cursor guards,
 * idempotency constraint, race conditions, pagination.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { startMongo, stopMongo, cleanDatabase, getTestDb, fixIdempotencyIndex } from './setup';
import { connectDb, disconnectDb } from '../src/db';
import {
  findOrCreateChannel,
  addParticipant,
  getChannelMessages,
  getMessagesSince,
  getMessagesSinceTime,
  getMessageHistory,
  getUnreadCount,
  insertMessage,
  updateLastRead,
  closeChannel,
  findMessage,
  findMessageByIdempotencyKey,
  channels,
  messages,
  type MessageDocument,
} from '../src/db';
import {
  createTestApp,
  makeParticipant,
  createTestChannel,
  joinChannel,
  sendMessage,
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
// Helpers
// ---------------------------------------------------------------------------

function makeMessageDoc(channelId: string, senderId: string | null = 'user-1'): MessageDocument {
  return {
    _id: new ObjectId(),
    channel_id: channelId,
    sender_id: senderId,
    sender_role: senderId ? 'rider' : 'system',
    type: 'text',
    body: 'test body',
    created_at: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Index creation
// ---------------------------------------------------------------------------

describe('MongoDB indexes', () => {
  it('creates unique index on idempotency_key', async () => {
    const db = getTestDb();
    const indexes = await db.collection('messages').indexes();
    const idempotencyIndex = indexes.find(
      (idx) => idx.key && 'idempotency_key' in idx.key,
    );
    expect(idempotencyIndex).toBeDefined();
    expect(idempotencyIndex!.unique).toBe(true);
    // Index uses partialFilterExpression (in tests) or sparse (in prod)
    // to skip documents without idempotency_key
    expect(
      idempotencyIndex!.sparse === true ||
      idempotencyIndex!.partialFilterExpression != null,
    ).toBe(true);
  });

  it('creates compound index on channel_id and _id', async () => {
    const db = getTestDb();
    const indexes = await db.collection('messages').indexes();
    const compoundIndex = indexes.find(
      (idx) => idx.key && 'channel_id' in idx.key && '_id' in idx.key,
    );
    expect(compoundIndex).toBeDefined();
  });

  it('creates index on channel status', async () => {
    const db = getTestDb();
    const indexes = await db.collection('channels').indexes();
    const statusIndex = indexes.find((idx) => idx.key && 'status' in idx.key);
    expect(statusIndex).toBeDefined();
  });

  it('creates index on participants.id and status', async () => {
    const db = getTestDb();
    const indexes = await db.collection('channels').indexes();
    const pIdx = indexes.find(
      (idx) => idx.key && 'participants.id' in idx.key,
    );
    expect(pIdx).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// findOrCreateChannel
// ---------------------------------------------------------------------------

describe('findOrCreateChannel', () => {
  it('creates a new channel with active status', async () => {
    const ch = await findOrCreateChannel('db-ch-new');
    expect(ch._id).toBe('db-ch-new');
    expect(ch.status).toBe('active');
    expect(Array.isArray(ch.participants)).toBe(true);
    expect(ch.participants.length).toBe(0);
    expect(ch.closed_at).toBeNull();
  });

  it('returns the same channel on repeated calls', async () => {
    const ch1 = await findOrCreateChannel('db-ch-idempotent');
    const ch2 = await findOrCreateChannel('db-ch-idempotent');
    expect(ch1._id).toBe(ch2._id);
    expect(ch1.created_at.getTime()).toBe(ch2.created_at.getTime());
  });

  it('handles concurrent creation without duplicates', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => findOrCreateChannel('db-ch-concurrent')),
    );
    // All should return the same channel
    const ids = results.map((r) => r._id);
    expect(new Set(ids).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// addParticipant
// ---------------------------------------------------------------------------

describe('addParticipant', () => {
  it('adds a new participant to a channel', async () => {
    await findOrCreateChannel('db-add-p');
    const participant = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    const ch = await addParticipant('db-add-p', participant);
    expect(ch.participants.length).toBe(1);
    expect(ch.participants[0]!.id).toBe('alice');
  });

  it('updates existing participant profile on re-add', async () => {
    await findOrCreateChannel('db-update-p');
    const p1 = makeParticipant({ id: 'bob', name: 'Old Bob', role: 'driver' });
    await addParticipant('db-update-p', p1);

    const p2 = { ...p1, name: 'New Bob', profile_image: 'https://example.com/bob.jpg' };
    const ch = await addParticipant('db-update-p', p2);

    expect(ch.participants.length).toBe(1);
    expect(ch.participants[0]!.name).toBe('New Bob');
    expect(ch.participants[0]!.profile_image).toBe('https://example.com/bob.jpg');
  });

  it('handles concurrent addParticipant for same participant without duplication', async () => {
    await findOrCreateChannel('db-conc-p');
    const p = makeParticipant({ id: 'concurrent-user', name: 'C', role: 'rider' });

    await Promise.all(
      Array.from({ length: 5 }, () => addParticipant('db-conc-p', p)),
    );

    const ch = await channels().findOne({ _id: 'db-conc-p' });
    const matching = ch!.participants.filter((part) => part.id === 'concurrent-user');
    expect(matching.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// insertMessage and idempotency
// ---------------------------------------------------------------------------

describe('insertMessage', () => {
  it('inserts a message successfully', async () => {
    await findOrCreateChannel('db-ins-msg');
    const doc = makeMessageDoc('db-ins-msg');
    await insertMessage(doc);

    const found = await messages().findOne({ _id: doc._id });
    expect(found).not.toBeNull();
    expect(found!.body).toBe('test body');
  });

  it('updates last_activity_at on channel after insert', async () => {
    const before = new Date();
    await sleep(2);
    await findOrCreateChannel('db-activity-ts');
    const doc = makeMessageDoc('db-activity-ts');
    doc.created_at = new Date();
    await insertMessage(doc);

    const ch = await channels().findOne({ _id: 'db-activity-ts' });
    expect(ch!.last_activity_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('throws duplicate key error for duplicate idempotency key on same channel', async () => {
    await findOrCreateChannel('db-idem-dup');
    const doc1 = makeMessageDoc('db-idem-dup');
    doc1.idempotency_key = 'test-idem-key';
    await insertMessage(doc1);

    const doc2 = makeMessageDoc('db-idem-dup');
    doc2.idempotency_key = 'test-idem-key'; // same key, same channel

    let threw = false;
    try {
      await insertMessage(doc2);
    } catch (err: unknown) {
      threw = true;
      expect((err as { code?: number }).code).toBe(11000);
    }
    expect(threw).toBe(true);
  });

  it('allows same idempotency key on different channels', async () => {
    await findOrCreateChannel('db-idem-ch1');
    await findOrCreateChannel('db-idem-ch2');

    const doc1 = makeMessageDoc('db-idem-ch1');
    doc1.idempotency_key = 'cross-channel-key';
    const doc2 = makeMessageDoc('db-idem-ch2');
    doc2.idempotency_key = 'cross-channel-key';

    await insertMessage(doc1);
    await insertMessage(doc2);

    const count = await messages().countDocuments({ idempotency_key: 'cross-channel-key' });
    expect(count).toBe(2);
  });

  it('allows multiple messages without idempotency key (sparse index)', async () => {
    await findOrCreateChannel('db-no-idem');
    const doc1 = makeMessageDoc('db-no-idem');
    const doc2 = makeMessageDoc('db-no-idem');
    // No idempotency_key set

    await insertMessage(doc1);
    await insertMessage(doc2);

    const count = await messages().countDocuments({ channel_id: 'db-no-idem' });
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getMessagesSince
// ---------------------------------------------------------------------------

describe('getMessagesSince', () => {
  it('returns messages after the given message ID', async () => {
    await findOrCreateChannel('db-since-id');
    const d1 = makeMessageDoc('db-since-id');
    const d2 = makeMessageDoc('db-since-id');
    const d3 = makeMessageDoc('db-since-id');
    await insertMessage(d1);
    await insertMessage(d2);
    await insertMessage(d3);

    const { docs, resync } = await getMessagesSince('db-since-id', d1._id.toHexString());
    expect(resync).toBe(false);
    expect(docs.length).toBe(2);
    expect(docs[0]!._id.toHexString()).toBe(d2._id.toHexString());
    expect(docs[1]!._id.toHexString()).toBe(d3._id.toHexString());
  });

  it('returns resync: true for non-existent message ID', async () => {
    await findOrCreateChannel('db-since-404');
    const { docs, resync } = await getMessagesSince(
      'db-since-404',
      new ObjectId().toHexString(),
    );
    expect(resync).toBe(true);
    expect(docs.length).toBe(0);
  });

  it('returns resync: true for malformed ID', async () => {
    const { docs, resync } = await getMessagesSince('any-ch', 'not-an-objectid');
    expect(resync).toBe(true);
    expect(docs.length).toBe(0);
  });

  it('returns empty docs (not resync) when sinceId is the latest message', async () => {
    await findOrCreateChannel('db-since-latest');
    const d1 = makeMessageDoc('db-since-latest');
    await insertMessage(d1);

    const { docs, resync } = await getMessagesSince('db-since-latest', d1._id.toHexString());
    expect(resync).toBe(false);
    expect(docs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getMessagesSinceTime
// ---------------------------------------------------------------------------

describe('getMessagesSinceTime', () => {
  it('returns messages created after the given timestamp', async () => {
    await findOrCreateChannel('db-since-time');

    const d1 = makeMessageDoc('db-since-time');
    d1.created_at = new Date(Date.now() - 5000);
    await insertMessage(d1);

    const cutoff = new Date();
    await sleep(5);

    const d2 = makeMessageDoc('db-since-time');
    d2.created_at = new Date();
    await insertMessage(d2);

    const docs = await getMessagesSinceTime('db-since-time', cutoff.toISOString());
    expect(docs.length).toBe(1);
    expect(docs[0]!._id.toHexString()).toBe(d2._id.toHexString());
  });
});

// ---------------------------------------------------------------------------
// getMessageHistory (pagination)
// ---------------------------------------------------------------------------

describe('getMessageHistory', () => {
  it('returns messages with hasMore flag', async () => {
    await findOrCreateChannel('db-hist-page');
    for (let i = 0; i < 5; i++) {
      const d = makeMessageDoc('db-hist-page');
      d.created_at = new Date(Date.now() + i); // ensure distinct timestamps
      await insertMessage(d);
    }

    const { docs, hasMore } = await getMessageHistory('db-hist-page', { limit: 3 });
    expect(docs.length).toBe(3);
    expect(hasMore).toBe(true);
  });

  it('hasMore is false when all messages fit in limit', async () => {
    await findOrCreateChannel('db-hist-nomore');
    for (let i = 0; i < 3; i++) {
      await insertMessage(makeMessageDoc('db-hist-nomore'));
    }

    const { docs, hasMore } = await getMessageHistory('db-hist-nomore', { limit: 10 });
    expect(docs.length).toBe(3);
    expect(hasMore).toBe(false);
  });

  it('before filter excludes messages at or after the cutoff', async () => {
    await findOrCreateChannel('db-hist-before');
    const timestamps: Date[] = [];
    for (let i = 0; i < 4; i++) {
      const d = makeMessageDoc('db-hist-before');
      d.created_at = new Date(Date.now() + i * 10);
      timestamps.push(d.created_at);
      await insertMessage(d);
    }

    const cutoff = timestamps[2]!.toISOString();
    const { docs } = await getMessageHistory('db-hist-before', {
      limit: 10,
      before: cutoff,
    });
    // messages with created_at < cutoff
    expect(docs.length).toBe(2);
    for (const doc of docs) {
      expect(doc.created_at.getTime()).toBeLessThan(new Date(cutoff).getTime());
    }
  });

  it('after filter includes only messages after the cutoff', async () => {
    await findOrCreateChannel('db-hist-after');
    const timestamps: Date[] = [];
    for (let i = 0; i < 4; i++) {
      const d = makeMessageDoc('db-hist-after');
      d.created_at = new Date(Date.now() + i * 10);
      timestamps.push(d.created_at);
      await insertMessage(d);
    }

    const cutoff = timestamps[1]!.toISOString();
    const { docs } = await getMessageHistory('db-hist-after', {
      limit: 10,
      after: cutoff,
    });
    expect(docs.length).toBe(2);
    for (const doc of docs) {
      expect(doc.created_at.getTime()).toBeGreaterThan(new Date(cutoff).getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// updateLastRead / read cursor $lt guard
// ---------------------------------------------------------------------------

describe('updateLastRead — cursor $lt guard', () => {
  it('advances the cursor to a later message', async () => {
    await findOrCreateChannel('db-read-cursor');
    const p = makeParticipant({ id: 'user-cursor', name: 'U', role: 'rider' });
    await addParticipant('db-read-cursor', p);

    const d1 = makeMessageDoc('db-read-cursor');
    const d2 = makeMessageDoc('db-read-cursor');
    await insertMessage(d1);
    await insertMessage(d2);

    await updateLastRead('db-read-cursor', 'user-cursor', d1._id);
    await updateLastRead('db-read-cursor', 'user-cursor', d2._id);

    const ch = await channels().findOne({ _id: 'db-read-cursor' });
    const participant = ch!.participants.find((pp) => pp.id === 'user-cursor');
    expect(participant!.last_read_message_id?.toHexString()).toBe(d2._id.toHexString());
  });

  it('does not regress the cursor to an earlier message', async () => {
    await findOrCreateChannel('db-no-regress');
    const p = makeParticipant({ id: 'user-regress', name: 'U', role: 'rider' });
    await addParticipant('db-no-regress', p);

    const d1 = makeMessageDoc('db-no-regress');
    const d2 = makeMessageDoc('db-no-regress');
    await insertMessage(d1);
    await insertMessage(d2);

    // Set to d2 (later)
    await updateLastRead('db-no-regress', 'user-regress', d2._id);
    // Try to set to d1 (earlier) — should be a no-op
    await updateLastRead('db-no-regress', 'user-regress', d1._id);

    const ch = await channels().findOne({ _id: 'db-no-regress' });
    const participant = ch!.participants.find((pp) => pp.id === 'user-regress');
    // Cursor must still point to d2
    expect(participant!.last_read_message_id?.toHexString()).toBe(d2._id.toHexString());
  });
});

// ---------------------------------------------------------------------------
// getUnreadCount aggregation pipeline
// ---------------------------------------------------------------------------

describe('getUnreadCount', () => {
  it('returns 0 for channel with no messages', async () => {
    await findOrCreateChannel('db-unread-zero');
    const p = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await addParticipant('db-unread-zero', p);

    const result = await getUnreadCount('db-unread-zero', 'alice');
    expect(result.unread_count).toBe(0);
    expect(result.last_message_at).toBeNull();
  });

  it('returns 0 for non-existent channel', async () => {
    const result = await getUnreadCount('never-existed', 'user-1');
    expect(result.unread_count).toBe(0);
  });

  it('counts messages after last_read_message_id', async () => {
    await findOrCreateChannel('db-unread-count');
    const p = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await addParticipant('db-unread-count', p);

    const d1 = makeMessageDoc('db-unread-count', 'bob');
    const d2 = makeMessageDoc('db-unread-count', 'bob');
    const d3 = makeMessageDoc('db-unread-count', 'bob');
    await insertMessage(d1);
    await insertMessage(d2);
    await insertMessage(d3);

    // Alice read through d1
    await updateLastRead('db-unread-count', 'alice', d1._id);

    const result = await getUnreadCount('db-unread-count', 'alice');
    expect(result.unread_count).toBe(2); // d2 and d3
  });

  it('excludes sender own messages from unread count', async () => {
    await findOrCreateChannel('db-unread-own');
    const p = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await addParticipant('db-unread-own', p);

    // Alice sends 3 messages (own)
    for (let i = 0; i < 3; i++) {
      const d = makeMessageDoc('db-unread-own', 'alice');
      await insertMessage(d);
    }
    // Bob sends 2 messages
    for (let i = 0; i < 2; i++) {
      const d = makeMessageDoc('db-unread-own', 'bob');
      await insertMessage(d);
    }

    const result = await getUnreadCount('db-unread-own', 'alice');
    // Only the 2 messages from bob count as unread for alice
    expect(result.unread_count).toBe(2);
  });

  it('returns last_message_at as ISO string', async () => {
    await findOrCreateChannel('db-unread-ts');
    const p = makeParticipant({ id: 'alice', name: 'Alice', role: 'rider' });
    await addParticipant('db-unread-ts', p);

    const d = makeMessageDoc('db-unread-ts', 'bob');
    await insertMessage(d);

    const result = await getUnreadCount('db-unread-ts', 'alice');
    expect(typeof result.last_message_at).toBe('string');
    expect(new Date(result.last_message_at!).toISOString()).toBe(result.last_message_at);
  });
});

// ---------------------------------------------------------------------------
// closeChannel
// ---------------------------------------------------------------------------

describe('closeChannel', () => {
  it('closes an active channel and returns true', async () => {
    await findOrCreateChannel('db-close-ok');
    const closed = await closeChannel('db-close-ok');
    expect(closed).toBe(true);

    const ch = await channels().findOne({ _id: 'db-close-ok' });
    expect(ch!.status).toBe('closed');
    expect(ch!.closed_at).not.toBeNull();
  });

  it('returns false when channel does not exist', async () => {
    const closed = await closeChannel('nonexistent-ch');
    expect(closed).toBe(false);
  });

  it('returns false when channel is already closed', async () => {
    await findOrCreateChannel('db-close-twice');
    await closeChannel('db-close-twice');
    const closed2 = await closeChannel('db-close-twice');
    expect(closed2).toBe(false);
  });
});
