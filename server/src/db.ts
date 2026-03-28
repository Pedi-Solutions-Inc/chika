import { MongoClient, ObjectId, type Db, type Collection, type Filter } from 'mongodb';
import type { Message, MessageAttributes } from '@pedi/chika-types';
import type { Participant } from '@pedi/chika-types';
import { env } from './env';
import { createComponentLogger } from './logger';

const log = createComponentLogger('db');

export interface ChannelDocument {
  _id: string;
  status: 'active' | 'closed';
  participants: (Participant & { joined_at: Date; last_read_message_id?: ObjectId })[];
  created_at: Date;
  closed_at: Date | null;
  last_activity_at: Date;
}

export interface MessageDocument {
  _id: ObjectId;
  channel_id: string;
  sender_id: string | null;
  sender_role: string;
  type: string;
  body: string;
  attributes?: MessageAttributes;
  idempotency_key?: string;
  created_at: Date;
}

let client: MongoClient;
let db: Db;

export async function connectDb(): Promise<void> {
  client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 50,
    minPoolSize: 5,
    maxIdleTimeMS: 30_000,
    connectTimeoutMS: 10_000,
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 45_000,
  });
  await client.connect();
  db = client.db(env.MONGODB_DB);

  await Promise.all([
    channels().createIndex({ status: 1 }),
    channels().createIndex({ 'participants.id': 1, status: 1 }),
    messages().createIndex({ channel_id: 1, created_at: 1 }),
    messages().createIndex({ channel_id: 1, _id: 1 }),
    messages().createIndex(
      { channel_id: 1, idempotency_key: 1 },
      { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } },
    ),
  ]);
}

export async function disconnectDb(): Promise<void> {
  await client.close();
}

export function getDb(): Db {
  return db;
}

export function channels(): Collection<ChannelDocument> {
  return db.collection<ChannelDocument>('channels');
}

export function messages(): Collection<MessageDocument> {
  return db.collection<MessageDocument>('messages');
}

export function toMessage(doc: MessageDocument): Message {
  return {
    id: doc._id.toHexString(),
    channel_id: doc.channel_id,
    sender_id: doc.sender_id,
    sender_role: doc.sender_role,
    type: doc.type as Message['type'],
    body: doc.body,
    attributes: doc.attributes ?? {},
    created_at: doc.created_at.toISOString(),
  };
}

export type ApiParticipant = Participant & { joined_at: string };

export function toParticipant(p: ChannelDocument['participants'][number]): ApiParticipant {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    profile_image: p.profile_image,
    metadata: p.metadata ?? undefined,
    joined_at: p.joined_at.toISOString(),
  };
}

export async function findChannel(channelId: string): Promise<ChannelDocument | null> {
  return channels().findOne({ _id: channelId });
}

export async function findMessage(
  messageId: string,
  channelId: string,
): Promise<MessageDocument | null> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(messageId);
  } catch {
    return null;
  }
  return messages().findOne({ _id: oid, channel_id: channelId });
}

export async function findOrCreateChannel(channelId: string): Promise<ChannelDocument> {
  const now = new Date();
  const result = await channels().findOneAndUpdate(
    { _id: channelId },
    {
      $setOnInsert: {
        _id: channelId,
        status: 'active',
        participants: [],
        created_at: now,
        closed_at: null,
        last_activity_at: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  if (!result) throw new Error(`Failed to find/create channel ${channelId}`);
  return result;
}

export async function addParticipant(
  channelId: string,
  participant: Participant,
): Promise<ChannelDocument> {
  const now = new Date();

  // Try to update existing participant first.
  const updated = await channels().findOneAndUpdate(
    { _id: channelId, 'participants.id': participant.id },
    {
      $set: {
        'participants.$.name': participant.name,
        'participants.$.role': participant.role,
        'participants.$.profile_image': participant.profile_image,
        'participants.$.metadata': participant.metadata ?? null,
      },
    },
    { returnDocument: 'after' },
  );

  if (updated) return updated;

  // Participant not found — push new entry.
  const pushed = await channels().findOneAndUpdate(
    { _id: channelId, 'participants.id': { $ne: participant.id } },
    {
      $push: {
        participants: { ...participant, joined_at: now },
      },
    },
    { returnDocument: 'after' },
  );

  // If pushed is null, concurrent join already added this participant — fetch latest.
  return pushed ?? (await channels().findOne({ _id: channelId }))!;
}

const DEFAULT_JOIN_MESSAGE_LIMIT = 20;

export async function getChannelMessages(
  channelId: string,
  limit: number = DEFAULT_JOIN_MESSAGE_LIMIT,
): Promise<MessageDocument[]> {
  const docs = await messages()
    .find({ channel_id: channelId })
    .sort({ _id: -1 })
    .limit(limit)
    .toArray();
  docs.reverse();
  return docs;
}

export async function getMessagesSince(
  channelId: string,
  sinceMessageId: string,
): Promise<{ docs: MessageDocument[]; resync: boolean }> {
  let sinceOid: ObjectId;
  try {
    sinceOid = new ObjectId(sinceMessageId);
  } catch {
    return { docs: [], resync: true };
  }

  const sinceMsg = await messages().findOne({ _id: sinceOid, channel_id: channelId });
  if (!sinceMsg) return { docs: [], resync: true };

  const docs = await messages()
    .find({
      channel_id: channelId,
      _id: { $gt: sinceOid },
    })
    .sort({ _id: 1 })
    .toArray();

  return { docs, resync: false };
}

export async function getMessagesSinceTime(
  channelId: string,
  sinceTime: string,
): Promise<MessageDocument[]> {
  return messages()
    .find({
      channel_id: channelId,
      created_at: { $gt: new Date(sinceTime) },
    })
    .sort({ _id: 1 })
    .toArray();
}

export async function getMessageHistory(
  channelId: string,
  options: { limit: number; before?: string; after?: string },
): Promise<{ docs: MessageDocument[]; hasMore: boolean }> {
  const filter: Filter<MessageDocument> = { channel_id: channelId };

  if (options.before || options.after) {
    const createdAtFilter: Record<string, Date> = {};
    if (options.before) createdAtFilter.$lt = new Date(options.before);
    if (options.after) createdAtFilter.$gt = new Date(options.after);
    filter.created_at = createdAtFilter;
  }

  const docs = await messages()
    .find(filter)
    .sort({ _id: -1 })
    .limit(options.limit + 1)
    .toArray();

  const hasMore = docs.length > options.limit;
  if (hasMore) docs.pop();

  docs.reverse();
  return { docs, hasMore };
}

export async function closeChannel(channelId: string): Promise<boolean> {
  const result = await channels().updateOne(
    { _id: channelId, status: 'active' },
    { $set: { status: 'closed', closed_at: new Date() } },
  );
  return result.modifiedCount > 0;
}

export async function updateLastRead(
  channelId: string,
  participantId: string,
  messageId: ObjectId,
): Promise<void> {
  await channels().updateOne(
    {
      _id: channelId,
      participants: {
        $elemMatch: {
          id: participantId,
          $or: [
            { last_read_message_id: { $lt: messageId } },
            { last_read_message_id: { $exists: false } },
          ],
        },
      },
    },
    { $set: { 'participants.$.last_read_message_id': messageId } },
  );
}

export async function getUnreadCount(
  channelId: string,
  participantId: string,
): Promise<{ unread_count: number; last_message_at: string | null }> {
  const channel = await channels().findOne(
    { _id: channelId },
    { projection: { participants: { $elemMatch: { id: participantId } } } },
  );

  if (!channel) return { unread_count: 0, last_message_at: null };

  const participant = channel.participants[0];
  const lastReadId = participant?.last_read_message_id;

  const pipeline = [
    { $match: { channel_id: channelId } },
    {
      $facet: {
        unread: [
          ...(lastReadId ? [{ $match: { _id: { $gt: lastReadId } } }] : []),
          // Exclude the participant's own messages from the unread count
          { $match: { sender_id: { $ne: participantId } } },
          { $count: 'total' as const },
        ],
        latest: [
          { $sort: { _id: -1 as const } },
          { $limit: 1 },
          { $project: { created_at: 1 } },
        ],
      },
    },
  ];

  const [result] = await messages().aggregate(pipeline).toArray();

  const lastMessageAt = result?.latest?.[0]?.created_at;

  return {
    unread_count: result?.unread?.[0]?.total ?? 0,
    last_message_at: lastMessageAt instanceof Date ? lastMessageAt.toISOString() : (lastMessageAt ?? null),
  };
}

export async function insertMessage(doc: MessageDocument): Promise<void> {
  await messages().insertOne(doc);
  // Best-effort timestamp update — don't let this mask a successful insert
  await channels().updateOne(
    { _id: doc.channel_id },
    { $set: { last_activity_at: doc.created_at } },
  ).catch((err) => {
    log.warn('failed to update last_activity_at', { channelId: doc.channel_id, error: String(err) });
  });
}

export async function findMessageByIdempotencyKey(
  channelId: string,
  key: string,
): Promise<MessageDocument | null> {
  return messages().findOne({ channel_id: channelId, idempotency_key: key });
}
