import { MongoClient, type Db, type Collection, type Filter } from 'mongodb';
import type { Message, MessageAttributes } from '@pedi/chika-types';
import type { Participant } from '@pedi/chika-types';
import { env } from './env';

export interface ChannelDocument {
  _id: string;
  status: 'active' | 'closed';
  participants: (Participant & { joined_at: string })[];
  created_at: string;
  closed_at: string | null;
  last_activity_at: string;
}

export interface MessageDocument {
  _id: string;
  channel_id: string;
  sender_id: string | null;
  sender_role: string;
  type: string;
  body: string;
  attributes: MessageAttributes;
  created_at: string;
}

let client: MongoClient;
let db: Db;

export async function connectDb(): Promise<void> {
  client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  db = client.db(env.MONGODB_DB);

  await Promise.all([
    channels().createIndex({ status: 1 }),
    messages().createIndex({ channel_id: 1, created_at: 1 }),
    messages().createIndex({ created_at: 1 }),
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
    id: doc._id,
    channel_id: doc.channel_id,
    sender_id: doc.sender_id,
    sender_role: doc.sender_role,
    type: doc.type as Message['type'],
    body: doc.body,
    attributes: doc.attributes,
    created_at: doc.created_at,
  };
}

export async function findChannel(channelId: string): Promise<ChannelDocument | null> {
  return channels().findOne({ _id: channelId });
}

export async function findOrCreateChannel(channelId: string): Promise<ChannelDocument> {
  const now = new Date().toISOString();
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
): Promise<void> {
  const now = new Date().toISOString();

  await channels().bulkWrite([
    {
      updateOne: {
        filter: { _id: channelId, 'participants.id': participant.id },
        update: {
          $set: {
            'participants.$.name': participant.name,
            'participants.$.role': participant.role,
            'participants.$.profile_image': participant.profile_image,
            'participants.$.metadata': participant.metadata ?? null,
          },
        },
      },
    },
    {
      updateOne: {
        filter: { _id: channelId, 'participants.id': { $ne: participant.id } },
        update: {
          $push: {
            participants: { ...participant, joined_at: now },
          },
        },
      },
    },
  ]);
}

export async function insertMessage(doc: MessageDocument): Promise<void> {
  await Promise.all([
    messages().insertOne(doc),
    channels().updateOne(
      { _id: doc.channel_id },
      { $set: { last_activity_at: doc.created_at } },
    ),
  ]);
}

const DEFAULT_JOIN_MESSAGE_LIMIT = 50;

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
  const sinceMsg = await messages().findOne({ _id: sinceMessageId });
  if (!sinceMsg) return { docs: [], resync: true };

  const docs = await messages()
    .find({
      channel_id: channelId,
      _id: { $gt: sinceMessageId },
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
      created_at: { $gt: sinceTime },
    })
    .sort({ _id: 1 })
    .toArray();
}

export async function getMessageHistory(
  channelId: string,
  options: { limit: number; before?: string; after?: string },
): Promise<{ docs: MessageDocument[]; hasMore: boolean }> {
  const filter: Filter<MessageDocument> = { channel_id: channelId };

  if (options.before) {
    filter.created_at = { ...((filter.created_at as object) ?? {}), $lt: options.before };
  }
  if (options.after) {
    filter.created_at = { ...((filter.created_at as object) ?? {}), $gt: options.after };
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
    { $set: { status: 'closed', closed_at: new Date().toISOString() } },
  );
  return result.modifiedCount > 0;
}
