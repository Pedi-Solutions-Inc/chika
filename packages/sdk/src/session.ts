import EventSource from 'react-native-sse';
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

// Custom SSE event types beyond built-in message/open/error/close.
// 'heartbeat' is server keep-alive (no handler needed).
type ChatEvents = 'heartbeat' | 'resync';

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
  disconnect: () => void;
}

/**
 * Creates an imperative chat session with SSE streaming and managed reconnection.
 * Lower-level API — prefer `useChat` hook for React Native components.
 *
 * @template D - Chat domain type. Defaults to DefaultDomain.
 */
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

  let es: EventSource<ChatEvents> | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

    es = new EventSource<ChatEvents>(streamUrl, {
      headers: {
        ...customHeaders,
        ...(lastEventId && { 'Last-Event-ID': lastEventId }),
      },
      pollingInterval: 0,
    });

    es.addEventListener('open', () => {
      if (disposed) return;
      callbacks.onStatusChange('connected');
    });

    es.addEventListener('message', (event) => {
      if (disposed || !event.data) return;

      let message: Message<D>;
      try {
        message = JSON.parse(event.data);
      } catch {
        callbacks.onError(new Error('Failed to parse SSE message'));
        return;
      }

      if (event.lastEventId) {
        lastEventId = event.lastEventId;
      }

      if (seenMessageIds.has(message.id)) return;
      seenMessageIds.add(message.id);
      trimSeenIds();

      callbacks.onMessage(message);
    });

    es.addEventListener('resync', () => {
      if (disposed) return;
      cleanupEventSource();
      callbacks.onResync();
    });

    es.addEventListener('error', (event) => {
      if (disposed) return;

      const msg = 'message' in event ? String(event.message) : '';

      if (msg.includes('Channel is closed') || msg.includes('410')) {
        callbacks.onStatusChange('closed');
        cleanupEventSource();
        disposed = true;
        return;
      }

      if (msg) callbacks.onError(new Error(msg));

      scheduleReconnect();
    });

    es.addEventListener('close', () => {
      if (disposed) return;
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return;
    callbacks.onStatusChange('reconnecting');

    cleanupEventSource();

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
  }

  function cleanupEventSource(): void {
    if (es) {
      es.removeAllEventListeners();
      es.close();
      es = null;
    }
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

    disconnect: () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanupEventSource();
      callbacks.onStatusChange('disconnected');
    },
  };
}
