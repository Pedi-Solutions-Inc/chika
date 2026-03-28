import { channels } from './db';
import { createComponentLogger } from './logger';

const log = createComponentLogger('cleanup');
const STALE_CHANNEL_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function markStaleChannelsInactive(): Promise<number> {
  const threshold = new Date(Date.now() - STALE_CHANNEL_THRESHOLD_MS);

  const result = await channels().updateMany(
    {
      status: 'active',
      last_activity_at: { $lt: threshold },
    },
    {
      $set: {
        status: 'closed',
        closed_at: new Date(),
      },
    },
  );

  return result.modifiedCount;
}

export function startChannelCleanup(): void {
  log.info('channel cleanup started', { intervalMs: CLEANUP_INTERVAL_MS, thresholdMs: STALE_CHANNEL_THRESHOLD_MS });
  cleanupTimer = setInterval(async () => {
    try {
      const closed = await markStaleChannelsInactive();
      if (closed > 0) {
        log.info('stale channels closed', { count: closed });
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
