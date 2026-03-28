import type {
  ChatDomain,
  DefaultDomain,
  Participant,
  Message,
  JoinResponse,
  SendMessageRequest,
  SendMessageResponse,
  MessageAttributes,
} from '@pedi/chika-types';
import type { ChatConfig, ChatStatus } from './types';
import { ChatDisconnectedError, ChannelClosedError } from './errors';
import { resolveServerUrl } from './resolve-url';
import { createSSEConnection, type SSEConnection } from './sse-connection';

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const MAX_SEEN_IDS = 500;

export interface SessionCallbacks<D extends ChatDomain = DefaultDomain> {
  onMessage: (message: Message<D>) => void;
  onStatusChange: (status: ChatStatus) => void;
  onError: (error: Error) => void;
  onResync: () => void;
}

export interface ChatSession<D extends ChatDomain = DefaultDomain> {
  serviceUrl: string;
  channelId: string;
  initialParticipants: Participant<D>[];
  initialMessages: Message<D>[];
  sendMessage: (type: D['messageType'], body: string, attributes?: MessageAttributes<D>) => Promise<SendMessageResponse>;
  markAsRead: (messageId: string) => Promise<void>;
  disconnect: () => void;
}

export async function createChatSession<D extends ChatDomain = DefaultDomain>(
  config: ChatConfig,
  channelId: string,
  profile: Participant<D>,
  callbacks: SessionCallbacks<D>,
): Promise<ChatSession<D>> {
  const serviceUrl = resolveServerUrl(config.manifest, channelId);
  const customHeaders = config.headers ?? {};
  const reconnectDelay = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  callbacks.onStatusChange('connecting');

  const joinRes = await fetch(`${serviceUrl}/channels/${channelId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...customHeaders },
    body: JSON.stringify(profile),
  });

  if (joinRes.status === 410) {
    throw new ChannelClosedError(channelId);
  }

  if (!joinRes.ok) {
    throw new Error(`Join failed: ${joinRes.status} ${await joinRes.text()}`);
  }

  const { messages, participants, joined_at }: JoinResponse<D> = await joinRes.json();

  let lastEventId =
    messages.length > 0 ? messages[messages.length - 1]!.id : undefined;

  const joinedAt = joined_at;

  const seenMessageIds = new Set<string>(messages.map((m) => m.id));

  let sseConn: SSEConnection | null = null;
  let disposed = false;

  function trimSeenIds(): void {
    if (seenMessageIds.size <= MAX_SEEN_IDS) return;
    const ids = [...seenMessageIds];
    seenMessageIds.clear();
    for (const id of ids.slice(-MAX_SEEN_IDS)) {
      seenMessageIds.add(id);
    }
  }

  function connect(): void {
    if (disposed) return;

    const streamUrl = lastEventId
      ? `${serviceUrl}/channels/${channelId}/stream`
      : `${serviceUrl}/channels/${channelId}/stream?since_time=${encodeURIComponent(joinedAt)}`;

    sseConn = createSSEConnection(
      {
        url: streamUrl,
        headers: customHeaders,
        reconnectDelayMs: reconnectDelay,
        lastEventId,
        customEvents: ['resync'],
      },
      {
        onOpen: () => {
          if (!disposed) callbacks.onStatusChange('connected');
        },
        onEvent: (eventType, data, eventId) => {
          if (disposed) return;

          if (eventType === 'message') {
            let message: Message<D>;
            try {
              message = JSON.parse(data);
            } catch {
              callbacks.onError(new Error('Failed to parse SSE message'));
              return;
            }

            if (eventId) {
              lastEventId = eventId;
            }

            if (seenMessageIds.has(message.id)) return;
            seenMessageIds.add(message.id);
            trimSeenIds();

            callbacks.onMessage(message);
          } else if (eventType === 'resync') {
            sseConn?.close();
            sseConn = null;
            callbacks.onResync();
          }
        },
        onError: (err) => {
          if (!disposed) callbacks.onError(err);
        },
        onClosed: () => {
          callbacks.onStatusChange('closed');
          disposed = true;
        },
        onReconnecting: () => {
          if (!disposed) callbacks.onStatusChange('reconnecting');
        },
      },
    );
  }

  connect();

  return {
    serviceUrl,
    channelId,
    initialParticipants: participants,
    initialMessages: messages,

    sendMessage: async (type, body, attributes) => {
      if (disposed) throw new ChatDisconnectedError('disconnected');

      const payload: SendMessageRequest<D> = {
        sender_id: profile.id,
        type,
        body,
        attributes,
      };

      const res = await fetch(
        `${serviceUrl}/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...customHeaders },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        throw new Error(`Send failed: ${res.status} ${await res.text()}`);
      }

      const response: SendMessageResponse = await res.json();
      seenMessageIds.add(response.id);
      return response;
    },

    markAsRead: async (messageId: string) => {
      const res = await fetch(`${serviceUrl}/channels/${channelId}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...customHeaders },
        body: JSON.stringify({
          participant_id: profile.id,
          message_id: messageId,
        }),
      });
      if (!res.ok) {
        throw new Error(`markAsRead failed: ${res.status}`);
      }
    },

    disconnect: () => {
      disposed = true;
      sseConn?.close();
      sseConn = null;
      callbacks.onStatusChange('disconnected');
    },
  };
}
