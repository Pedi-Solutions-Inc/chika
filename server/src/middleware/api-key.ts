import { timingSafeEqual } from 'crypto';
import { createMiddleware } from 'hono/factory';
import { env } from '../env';

export const requireApiKey = createMiddleware(async (c, next) => {
  const key = c.req.header('X-Api-Key');

  if (
    !key ||
    Buffer.byteLength(key) !== Buffer.byteLength(env.API_KEY) ||
    !timingSafeEqual(Buffer.from(key), Buffer.from(env.API_KEY))
  ) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});
