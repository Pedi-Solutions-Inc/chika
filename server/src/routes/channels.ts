import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { ulid } from 'ulid';
import {
  joinRequestSchema,
  sendMessageRequestSchema,
  markReadRequestSchema,
} from '@pedi/chika-types';
import {
  findOrCreateChannel,
  addParticipant,
  getChannelMessages,
  getMessagesSince,
  getMessagesSinceTime,
  insertMessage,
  findChannel,
  findMessage,
  toMessage,
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

    if (messageDocs.length > 0) {
      const lastMsgId = messageDocs[messageDocs.length - 1]!._id;
      await updateLastRead(channelId, participant.id, lastMsgId);
    }

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

    await broadcastToChannel(channelId, body.sender_id, 'unread_update', {
      channel_id: channelId,
      message_id: messageId,
      created_at: now,
    });

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

channels.get('/:channelId/unread', async (c) => {
  const channelId = c.req.param('channelId');
  const participantId = c.req.query('participant_id');

  if (!participantId) {
    return c.json({ error: 'participant_id query parameter is required' }, 400);
  }

  const channel = await findChannel(channelId);
  if (channel?.status === 'closed') {
    return c.json({ error: 'Channel is closed' }, 410);
  }

  return streamSSE(c, async (stream) => {
    const conn = subscribeUnread(channelId, participantId, stream);

    stream.onAbort(() => {
      unsubscribeUnread(channelId, participantId, conn);
    });

    let unread_count = 0;
    let last_message_at: string | null = null;

    if (channel) {
      const participant = channel.participants.find((p) => p.id === participantId);
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

    const channel = await findChannel(channelId);
    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    const participant = channel.participants.find((p) => p.id === participant_id);
    if (!participant) {
      return c.json({ error: 'Participant not found in channel' }, 403);
    }

    const msg = await findMessage(message_id, channelId);
    if (!msg) {
      return c.json({ error: 'Message not found in channel' }, 404);
    }

    await updateLastRead(channelId, participant_id, message_id);

    const { unread_count } = await getUnreadCount(channelId, participant_id);
    await broadcastToParticipant(channelId, participant_id, 'unread_clear', {
      channel_id: channelId,
      unread_count,
    });

    return c.json({ success: true });
  },
);

export { channels };
