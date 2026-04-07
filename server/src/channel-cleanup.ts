import { channels } from './db';
import { disconnectChannel } from './broadcaster';
import { disconnectUnreadChannel } from './unread-broadcaster';
import { createComponentLogger } from './logger';

const log = createComponentLogger('cleanup');
const STALE_CHANNEL_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function markStaleChannelsInactive(): Promise<string[]> {
  const threshold = new Date(Date.now() - STALE_CHANNEL_THRESHOLD_MS);

  const staleChannels = await channels()
    .find(
      { status: 'active', last_activity_at: { $lt: threshold } },
      { projection: { _id: 1 } },
    )
    .toArray();

  if (staleChannels.length === 0) return [];

  const ids = staleChannels.map((ch) => ch._id);

  await channels().updateMany(
    { _id: { $in: ids }, status: 'active' },
    {
      $set: {
        status: 'closed',
        closed_at: new Date(),
      },
    },
  );

  return ids;
}

export function startChannelCleanup(): void {
  log.info('channel cleanup started', { intervalMs: CLEANUP_INTERVAL_MS, thresholdMs: STALE_CHANNEL_THRESHOLD_MS });
  cleanupTimer = setInterval(async () => {
    try {
      const closedIds = await markStaleChannelsInactive();
      if (closedIds.length > 0) {
        log.info('stale channels closed', { count: closedIds.length });
        await Promise.allSettled(
          closedIds.flatMap((id) => [disconnectChannel(id), disconnectUnreadChannel(id)]),
        );
      }
    } catch (err) {
      log.error('channel cleanup failed', { error: err as Error });
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopChannelCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
