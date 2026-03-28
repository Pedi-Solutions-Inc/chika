import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ulid } from 'ulid';
import {
  systemMessageRequestSchema,
  messageHistoryQuerySchema,
} from '@pedi/chika-types';
import { buildRequestInfo, runInterceptors, runAfterSend } from '../plugins';
import {
  findChannel,
  insertMessage,
  getMessageHistory,
  closeChannel,
  toMessage,
  type MessageDocument,
} from '../db';
import { broadcast, disconnectChannel } from '../broadcaster';
import { broadcastToChannel } from '../unread-broadcaster';
import { requireApiKey } from '../middleware/api-key';

const internal = new Hono();

internal.use('*', requireApiKey);

internal.post(
  '/:channelId/messages',
  zValidator('json', systemMessageRequestSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'Invalid request', details: result.error.flatten() }, 400);
    }
  }),
  async (c) => {
    const channelId = c.req.param('channelId');

    const channel = await findChannel(channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }
    if (channel.status === 'closed') {
      return c.json({ error: 'Channel is closed' }, 410);
    }

    const body = c.req.valid('json');
    const now = new Date().toISOString();
    const messageId = `msg_${ulid()}`;

    const doc: MessageDocument = {
      _id: messageId,
      channel_id: channelId,
      sender_id: null,
      sender_role: 'system',
      type: body.type,
      body: body.body,
      attributes: body.attributes ?? {},
      created_at: now,
    };

    const request = buildRequestInfo(c);
    const intercepted = await runInterceptors(doc, channel, request, 'system');
    if ('blocked' in intercepted) {
      return c.json({ error: intercepted.reason }, 403);
    }
    const finalDoc = { ...intercepted.message, _id: messageId, channel_id: channelId, created_at: now };

    await insertMessage(finalDoc);

    const message = toMessage(finalDoc);
    await broadcast(channelId, message);

    await broadcastToChannel(channelId, null, 'unread_update', {
      channel_id: channelId,
      message_id: finalDoc._id,
      created_at: now,
    });

    runAfterSend(message, channelId, channel.participants, request, 'system');

    return c.json({ id: finalDoc._id, created_at: now }, 201);
  },
);

internal.get(
  '/:channelId/messages',
  zValidator('query', messageHistoryQuerySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'Invalid query', details: result.error.flatten() }, 400);
    }
  }),
  async (c) => {
    const channelId = c.req.param('channelId');

    const channel = await findChannel(channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const query = c.req.valid('query');
    const { docs, hasMore } = await getMessageHistory(channelId, {
      limit: query.limit,
      before: query.before,
      after: query.after,
    });

    return c.json({
      channel_id: channelId,
      participants: channel.participants,
      messages: docs.map(toMessage),
      has_more: hasMore,
    });
  },
);

internal.post('/:channelId/close', async (c) => {
  const channelId = c.req.param('channelId');

  const closed = await closeChannel(channelId);
  if (!closed) {
    const channel = await findChannel(channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }
    return c.json({ error: 'Channel is already closed' }, 410);
  }

  await disconnectChannel(channelId);

  return c.json({ channel_id: channelId, status: 'closed' });
});

export { internal };
