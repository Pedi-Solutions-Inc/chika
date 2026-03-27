import { channels } from './db';

const STALE_CHANNEL_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function markStaleChannelsInactive(): Promise<number> {
  const threshold = new Date(Date.now() - STALE_CHANNEL_THRESHOLD_MS).toISOString();

  const result = await channels().updateMany(
    {
      status: 'active',
      last_activity_at: { $lt: threshold },
    },
    {
      $set: {
        status: 'closed',
        closed_at: new Date().toISOString(),
      },
    },
  );

  return result.modifiedCount;
}

export function startChannelCleanup(): void {
  cleanupTimer = setInterval(async () => {
    try {
      await markStaleChannelsInactive();
    } catch {
      // Cleanup is best-effort; next interval will retry
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopChannelCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
