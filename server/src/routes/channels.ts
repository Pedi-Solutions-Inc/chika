import { Hono } from 'hono';
import { ObjectId } from 'mongodb';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import {
  joinRequestSchema,
  sendMessageRequestSchema,
  markReadRequestSchema,
} from '@pedi/chika-types';
import { buildRequestInfo, runInterceptors, runAfterSend } from '../plugins';
import {
  findOrCreateChannel,
  addParticipant,
  getChannelMessages,
  getMessagesSince,
  getMessagesSinceTime,
  insertMessage,
  findChannel,
  findMessage,
  findMessageByIdempotencyKey,
  toMessage,
  toParticipant,
  updateLastRead,
  getUnreadCount,
  type MessageDocument,
} from '../db';
import { subscribe, unsubscribe, broadcast } from '../broadcaster';
import {
  subscribeUnread,
  unsubscribeUnread,
  broadcastToParticipant,
  broadcastToChannel,
} from '../unread-broadcaster';
import { getRequestLogger } from '../middleware/request-logger';

const MAX_CHANNEL_ID_LENGTH = 64;

const channels = new Hono();

channels.post(
  '/:channelId/join',
  zValidator('json', joinRequestSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'Invalid request', details: result.error.flatten() }, 400);
    }
  }),
  async (c) => {
    const channelId = c.req.param('channelId');
    if (channelId.length > MAX_CHANNEL_ID_LENGTH) {
      return c.json({ error: `Channel ID too long (max ${MAX_CHANNEL_ID_LENGTH} chars)` }, 400);
    }
    const participant = c.req.valid('json');
    const reqLog = getRequestLogger(c);

    reqLog.info('participant joining channel', {
      channelId,
      participant: participant.name || participant.id,
      role: participant.role,
    });

    const channel = await findOrCreateChannel(channelId);

    if (channel.status === 'closed') {
      reqLog.warn('join rejected — channel closed', { channelId });
      return c.json({ error: 'Channel is closed' }, 410);
    }

    const updatedChannel = await addParticipant(channelId, participant);

    const messageDocs = await getChannelMessages(channelId);
    const msgs = messageDocs.map(toMessage);

    if (messageDocs.length > 0) {
      const lastMsgId = messageDocs[messageDocs.length - 1]!._id;
      await updateLastRead(channelId, participant.id, lastMsgId);
    }

    reqLog.info('participant joined', {
      channelId,
      participant: participant.name || participant.id,
      totalParticipants: updatedChannel.participants.length,
      messages: msgs.length,
    });

    const joinedParticipant = updatedChannel.participants.find(p => p.id === participant.id);

    return c.json({
      channel_id: channelId,
      status: updatedChannel.status,
      participants: updatedChannel.participants.map(toParticipant),
      messages: msgs,
      joined_at: joinedParticipant?.joined_at.toISOString() ?? new Date().toISOString(),
    });
  },
);

channels.post(
  '/:channelId/messages',
  zValidator('json', sendMessageRequestSchema, (result, c) => {
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

    const participantMap = new Map(channel.participants.map(p => [p.id, p]));
    const senderParticipant = participantMap.get(body.sender_id);
    if (!senderParticipant) {
      reqLog.warn('sender not in channel', { channelId, senderId: body.sender_id });
      return c.json({ error: 'Sender has not joined this channel' }, 403);
    }

    reqLog.info('sending message', {
      channelId,
      messageId: messageId.toHexString(),
      sender: senderParticipant.name || body.sender_id,
      senderRole: senderParticipant.role,
      type: body.type,
    });

    const hasAttributes = body.attributes && Object.keys(body.attributes).length > 0;

    const doc: MessageDocument = {
      _id: messageId,
      channel_id: channelId,
      sender_id: body.sender_id,
      sender_role: senderParticipant.role,
      type: body.type,
      body: body.body,
      ...(hasAttributes ? { attributes: body.attributes } : {}),
      created_at: now,
    };

    const request = buildRequestInfo(c);
    const intercepted = await runInterceptors(doc, channel, request, 'client');
    if ('blocked' in intercepted) {
      reqLog.warn('message blocked by plugin', { channelId, messageId: messageId.toHexString(), reason: intercepted.reason });
      return c.json({ error: intercepted.reason }, 403);
    }
    const finalDoc: MessageDocument = {
      ...intercepted.message,
      _id: messageId,
      channel_id: channelId,
      created_at: now,
      ...(body.idempotency_key ? { idempotency_key: body.idempotency_key } : {}),
    };

    // Idempotent insert: catch duplicate key from sparse unique index
    if (body.idempotency_key) {
      try {
        await insertMessage(finalDoc);
      } catch (err: any) {
        if (err?.code === 11000) {
          const existing = await findMessageByIdempotencyKey(channelId, body.idempotency_key);
          if (existing) {
            reqLog.info('idempotent duplicate', { channelId, idempotencyKey: body.idempotency_key });
            return c.json({ id: existing._id.toHexString(), created_at: existing.created_at.toISOString() }, 201);
          }
        }
        throw err;
      }
    } else {
      await insertMessage(finalDoc);
    }

    const message = toMessage(finalDoc);
    await broadcast(channelId, message);

    await broadcastToChannel(channelId, body.sender_id, 'unread_update', {
      channel_id: channelId,
      message_id: finalDoc._id.toHexString(),
      created_at: now.toISOString(),
    });

    runAfterSend(message, channelId, channel.participants.map(toParticipant), request, 'client');

    reqLog.info('message sent', { channelId, messageId: messageId.toHexString() });

    return c.json({ id: finalDoc._id.toHexString(), created_at: now.toISOString() }, 201);
  },
);

channels.get('/:channelId/stream', async (c) => {
  const channelId = c.req.param('channelId');
  const reqLog = getRequestLogger(c);

  const channel = await findChannel(channelId);
  if (!channel) {
    return c.json({ error: 'Channel not found' }, 404);
  }
  if (channel.status === 'closed') {
    return c.json({ error: 'Channel is closed' }, 410);
  }

  const lastEventId = c.req.header('Last-Event-ID');
  const sinceTime = c.req.query('since_time');

  reqLog.info('SSE stream opened', { channelId, lastEventId, sinceTime });

  return streamSSE(c, async (stream) => {
    const conn = subscribe(channelId, stream);

    stream.onAbort(() => {
      reqLog.info('SSE stream closed', { channelId });
      unsubscribe(channelId, conn);
    });

    if (lastEventId) {
      const { docs: missed, resync } = await getMessagesSince(channelId, lastEventId);
      if (resync) {
        await stream.writeSSE({ event: 'resync', data: '' });
      } else {
        for (const doc of missed) {
          const msg = toMessage(doc);
          await stream.writeSSE({
            id: msg.id,
            event: 'message',
            data: JSON.stringify(msg),
          });
        }
      }
    } else if (sinceTime) {
      const missed = await getMessagesSinceTime(channelId, sinceTime);
      for (const doc of missed) {
        const msg = toMessage(doc);
        await stream.writeSSE({
          id: msg.id,
          event: 'message',
          data: JSON.stringify(msg),
        });
      }
    }

    while (true) {
      try {
        await stream.writeSSE({
          event: 'heartbeat',
          data: '',
        });
        await stream.sleep(30_000);
      } catch {
        break;
      }
    }
  });
});

channels.get('/:channelId/unread', async (c) => {
  const channelId = c.req.param('channelId');
  const participantId = c.req.query('participant_id');
  const reqLog = getRequestLogger(c);

  if (!participantId) {
    return c.json({ error: 'participant_id query parameter is required' }, 400);
  }

  const channel = await findChannel(channelId);
  if (channel?.status === 'closed') {
    return c.json({ error: 'Channel is closed' }, 410);
  }

  const participantMap = new Map(channel?.participants.map(p => [p.id, p]));
  const participantName = participantMap.get(participantId)?.name ?? participantId;

  reqLog.info('unread stream opened', { channelId, participant: participantName });

  return streamSSE(c, async (stream) => {
    const conn = subscribeUnread(channelId, participantId, stream);

    stream.onAbort(() => {
      reqLog.info('unread stream closed', { channelId, participant: participantName });
      unsubscribeUnread(channelId, participantId, conn);
    });

    let unread_count = 0;
    let last_message_at: string | null = null;

    if (channel) {
      const participant = participantMap.get(participantId);
      if (participant) {
        const counts = await getUnreadCount(channelId, participantId);
        unread_count = counts.unread_count;
        last_message_at = counts.last_message_at;
      }
    }

    await stream.writeSSE({
      event: 'unread_snapshot',
      data: JSON.stringify({
        channel_id: channelId,
        unread_count,
        last_message_at,
      }),
    });

    while (true) {
      try {
        await stream.writeSSE({
          event: 'heartbeat',
          data: '',
        });
        await stream.sleep(30_000);
      } catch {
        break;
      }
    }
  });
});

channels.post(
  '/:channelId/read',
  zValidator('json', markReadRequestSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: 'Invalid request', details: result.error.flatten() }, 400);
    }
  }),
  async (c) => {
    const channelId = c.req.param('channelId');
    const { participant_id, message_id } = c.req.valid('json');
    const reqLog = getRequestLogger(c);

    const channel = await findChannel(channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const participant = channel.participants.find(p => p.id === participant_id);
    if (!participant) {
      return c.json({ error: 'Participant not found in channel' }, 403);
    }

    const msg = await findMessage(message_id, channelId);
    if (!msg) {
      return c.json({ error: 'Message not found in channel' }, 404);
    }

    await updateLastRead(channelId, participant_id, msg._id);

    // Fire-and-forget: compute and broadcast unread asynchronously
    getUnreadCount(channelId, participant_id).then(({ unread_count }) => {
      broadcastToParticipant(channelId, participant_id, 'unread_clear', {
        channel_id: channelId,
        unread_count,
      }).catch((err) => { reqLog.error('unread broadcast failed', { channelId, error: err }); });
    }).catch((err) => { reqLog.error('unread count failed', { channelId, error: err }); });

    reqLog.info('marked read', { channelId, participant: participant.name || participant_id, messageId: message_id });

    return c.json({ success: true });
  },
);

export { channels };
