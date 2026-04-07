import { getDb } from './db';
import { createComponentLogger } from './logger';

const log = createComponentLogger('message-counter');

interface StatsDocument {
  _id: string;
  total: number;
}

let sessionCount = 0;

export function incrementMessageCount(): void {
  sessionCount++;
  getDb()
    .collection<StatsDocument>('stats')
    .updateOne(
      { _id: 'message_count' },
      { $inc: { total: 1 } },
      { upsert: true },
    )
    .catch((err) => {
      log.warn('failed to persist message count', { error: String(err) });
    });
}

export async function getMessageCounts(): Promise<{ session: number; total: number }> {
  const doc = await getDb()
    .collection<StatsDocument>('stats')
    .findOne({ _id: 'message_count' });
  return {
    session: sessionCount,
    total: doc?.total ?? 0,
  };
}