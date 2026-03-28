import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { channels } from './routes/channels';
import { internal } from './routes/internal';
import { connectDb, disconnectDb, getDb } from './db';
import { getAllChannelIds, disconnectChannel } from './broadcaster';
import { rateLimiter } from 'hono-rate-limiter';
import { startChannelCleanup, stopChannelCleanup } from './channel-cleanup';
import { initSentry, captureException } from './sentry';
import { initAuth, requireAuth } from './middleware/auth';
import { loadPlugins, destroyPlugins } from './plugins';
import { env } from './env';
import { log } from './logger';
import { requestLogger, getRequestLogger } from './middleware/request-logger';

const app = new Hono();

app.use('*', requestLogger);
app.use('*', cors());
app.use('*', bodyLimit({ maxSize: 64 * 1024 }));

app.onError((err, c) => {
  const reqLog = getRequestLogger(c);
  reqLog.error('unhandled error', { error: err });
  captureException(err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.get('/health', async (c) => {
  try {
    await getDb().command({ ping: 1 });
    return c.json({ status: 'ok' });
  } catch {
    return c.json({ status: 'unhealthy' }, 503);
  }
});

const channelRateLimit = rateLimiter({
  windowMs: 60_000,
  limit: 120,
  keyGenerator: (c) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown',
});

const streamRateLimit = rateLimiter({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: (c) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown',
});

app.use('/channels/:channelId/messages', channelRateLimit);
app.use('/channels/:channelId/stream', streamRateLimit);
app.use('/channels/:channelId/join', channelRateLimit);
app.use('/channels/:channelId/unread', streamRateLimit);
app.use('/channels/:channelId/read', channelRateLimit);

// Auth middleware — active only when auth.config.ts exists.
app.use('/channels/:channelId/*', requireAuth);

app.route('/channels', channels);
app.route('/internal/channels', internal);

initSentry();
await connectDb();
await initAuth();
await loadPlugins();
startChannelCleanup();

log.info('server started', { port: env.PORT, env: env.NODE_ENV });

async function shutdown() {
  log.info('shutting down');
  stopChannelCleanup();
  await destroyPlugins();

  const channelIds = [...getAllChannelIds()];
  await Promise.allSettled(channelIds.map((id) => disconnectChannel(id)));

  await disconnectDb();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default {
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 0,
};
