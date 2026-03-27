import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { ulid } from 'ulid';
import {
  joinRequestSchema,
  sendMessageRequestSchema,
} from '@pedi/chika-types';
import {
  findOrCreateChannel,
  addParticipant,
  getChannelMessages,
  getMessagesSince,
  getMessagesSinceTime,
  insertMessage,
  findChannel,
  toMessage,
  type MessageDocument,
} from '../db';
import { subscribe, unsubscribe, broadcast } from '../broadcaster';

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
    const participant = c.req.valid('json');

    const channel = await findOrCreateChannel(channelId);

    if (channel.status === 'closed') {
      return c.json({ error: 'Channel is closed' }, 410);
    }

    await addParticipant(channelId, participant);

    const updatedChannel = (await findChannel(channelId))!;
    const messageDocs = await getChannelMessages(channelId);
    const msgs = messageDocs.map(toMessage);

    return c.json({
      channel_id: channelId,
      status: updatedChannel.status,
      participants: updatedChannel.participants,
      messages: msgs,
      joined_at: new Date().toISOString(),
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

    const senderParticipant = channel.participants.find((p) => p.id === body.sender_id);
    if (!senderParticipant) {
      return c.json({ error: 'Sender has not joined this channel' }, 403);
    }

    const doc: MessageDocument = {
      _id: messageId,
      channel_id: channelId,
      sender_id: body.sender_id,
      sender_role: senderParticipant.role,
      type: body.type,
      body: body.body,
      attributes: body.attributes ?? {},
      created_at: now,
    };

    await insertMessage(doc);

    const message = toMessage(doc);
    await broadcast(channelId, message);

    return c.json({ id: messageId, created_at: now }, 201);
  },
);

channels.get('/:channelId/stream', async (c) => {
  const channelId = c.req.param('channelId');

  const channel = await findChannel(channelId);
  if (!channel) {
    return c.json({ error: 'Channel not found' }, 404);
  }
  if (channel.status === 'closed') {
    return c.json({ error: 'Channel is closed' }, 410);
  }

  const lastEventId = c.req.header('Last-Event-ID');
  const sinceTime = c.req.query('since_time');

  return streamSSE(c, async (stream) => {
    const conn = subscribe(channelId, stream);

    stream.onAbort(() => {
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

export { channels };
