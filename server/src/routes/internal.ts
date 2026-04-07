import { Hono } from 'hono';
import { ObjectId } from 'mongodb';
import { zValidator } from '@hono/zod-validator';
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
  toParticipant,
  type MessageDocument,
} from '../db';
import { broadcast, disconnectChannel } from '../broadcaster';
import { broadcastToChannel } from '../unread-broadcaster';
import { requireApiKey } from '../middleware/api-key';
import { getRequestLogger } from '../middleware/request-logger';
import { incrementMessageCount } from '../message-counter';

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
    const reqLog = getRequestLogger(c);

    const channel = await findChannel(channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }
    if (channel.status === 'closed') {
      return c.json({ error: 'Channel is closed' }, 410);
    }

    const body = c.req.valid('json');
    const now = new Date();
    const messageId = new ObjectId();

    reqLog.info('sending system message', { channelId, messageId: messageId.toHexString(), type: body.type });

    const hasAttributes = body.attributes && Object.keys(body.attributes).length > 0;

    const doc: MessageDocument = {
      _id: messageId,
      channel_id: channelId,
      sender_id: null,
      sender_role: 'system',
      type: body.type,
      body: body.body,
      ...(hasAttributes ? { attributes: body.attributes } : {}),
      created_at: now,
    };

    const request = buildRequestInfo(c);
    const intercepted = await runInterceptors(doc, channel, request, 'system');
    if ('blocked' in intercepted) {
      reqLog.warn('system message blocked by plugin', { channelId, messageId: messageId.toHexString(), reason: intercepted.reason });
      return c.json({ error: intercepted.reason }, 403);
    }
    const finalDoc: MessageDocument = { ...intercepted.message, _id: messageId, channel_id: channelId, created_at: now };

    await insertMessage(finalDoc);

    const message = toMessage(finalDoc);
    await broadcast(channelId, message);

    await broadcastToChannel(channelId, null, 'unread_update', {
      channel_id: channelId,
      message_id: finalDoc._id.toHexString(),
      created_at: now.toISOString(),
    });

    incrementMessageCount();
    runAfterSend(message, channelId, channel.participants.map(toParticipant), request, 'system');

    reqLog.info('system message sent', { channelId, messageId: messageId.toHexString() });

    return c.json({ id: finalDoc._id.toHexString(), created_at: now.toISOString() }, 201);
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
    const reqLog = getRequestLogger(c);

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

    reqLog.debug('message history fetched', { channelId, count: docs.length, hasMore });

    return c.json({
      channel_id: channelId,
      participants: channel.participants.map(toParticipant),
      messages: docs.map(toMessage),
      has_more: hasMore,
    });
  },
);

internal.post('/:channelId/close', async (c) => {
  const channelId = c.req.param('channelId');
  const reqLog = getRequestLogger(c);

  reqLog.info('closing channel', { channelId });

  const closed = await closeChannel(channelId);
  if (!closed) {
    const channel = await findChannel(channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }
    reqLog.warn('channel already closed', { channelId });
    return c.json({ error: 'Channel is already closed' }, 410);
  }

  await disconnectChannel(channelId);

  reqLog.info('channel closed', { channelId });

  return c.json({ channel_id: channelId, status: 'closed' });
});

export { internal };
