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
import { ChatDisconnectedError, ChannelClosedError, HttpError } from './errors';
import { resolveServerUrl } from './resolve-url';
import { createSSEConnection, type SSEConnection } from './sse-connection';
import { withRetry, resolveRetryConfig, type RetryConfig } from './retry';
import type { NetworkMonitor } from './network-monitor';

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const MAX_SEEN_IDS = 500;

const MARK_READ_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 2000,
  jitterFactor: 0.3,
};

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
  networkMonitor: NetworkMonitor | null;
  sendMessage: (
    type: D['messageType'],
    body: string,
    attributes?: MessageAttributes<D>,
    idempotencyKey?: string,
  ) => Promise<SendMessageResponse>;
  markAsRead: (messageId: string) => Promise<void>;
  disconnect: () => void;
}

function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

async function throwHttpError(res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  throw new HttpError(res.status, body, parseRetryAfter(res));
}

export async function createChatSession<D extends ChatDomain = DefaultDomain>(
  config: ChatConfig,
  channelId: string,
  profile: Participant<D>,
  callbacks: SessionCallbacks<D>,
  networkMonitor?: NetworkMonitor,
): Promise<ChatSession<D>> {
  const serviceUrl = resolveServerUrl(config.manifest, channelId);
  const customHeaders = config.headers ?? {};
  const reconnectDelay = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const retryConfig = resolveRetryConfig(config.resilience);

  const sessionAbort = new AbortController();

  callbacks.onStatusChange('connecting');

  const joinFn = async (): Promise<JoinResponse<D>> => {
    const joinRes = await fetch(`${serviceUrl}/channels/${channelId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...customHeaders },
      body: JSON.stringify(profile),
      signal: sessionAbort.signal,
    });

    if (joinRes.status === 410) {
      throw new ChannelClosedError(channelId);
    }

    if (!joinRes.ok) {
      await throwHttpError(joinRes);
    }

    return joinRes.json();
  };

  const joinData = retryConfig
    ? await withRetry(joinFn, retryConfig, sessionAbort.signal)
    : await joinFn();

  const { messages, participants, joined_at }: JoinResponse<D> = joinData;

  let lastEventId =
    messages.length > 0 ? messages[messages.length - 1]!.id : undefined;

  const joinedAt = joined_at;

  const seenMessageIds = new Set<string>(messages.map((m) => m.id));

  let sseConn: SSEConnection | null = null;
  let disposed = false;

  const TRIM_THRESHOLD = MAX_SEEN_IDS * 1.5;

  function trimSeenIds(): void {
    if (seenMessageIds.size <= TRIM_THRESHOLD) return;
    const ids = [...seenMessageIds];
    seenMessageIds.clear();
    for (const id of ids.slice(-MAX_SEEN_IDS)) {
      seenMessageIds.add(id);
    }
  }

  function connect(): void {
    if (disposed) return;

    let hasConnected = false;

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
        networkMonitor,
      },
      {
        onOpen: () => {
          if (disposed) return;
          if (hasConnected) {
            // SSE layer reconnected (server restart, network recovery, etc.)
            // Trigger full session recreation so we re-join and get fresh state.
            callbacks.onResync();
            return;
          }
          hasConnected = true;
          callbacks.onStatusChange('connected');
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
            // Let onResync → startSession handle full session recreation.
            // Don't call reconnectImmediate() — startSession disconnects this
            // session anyway, so the reconnect would be immediately thrown away.
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
    networkMonitor: networkMonitor ?? null,

    sendMessage: async (type, body, attributes, idempotencyKey) => {
      if (disposed) throw new ChatDisconnectedError('disconnected');

      const payload: SendMessageRequest<D> = {
        sender_id: profile.id,
        type,
        body,
        attributes,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      };

      const sendFn = async (): Promise<SendMessageResponse> => {
        const res = await fetch(
          `${serviceUrl}/channels/${channelId}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...customHeaders },
            body: JSON.stringify(payload),
            signal: sessionAbort.signal,
          },
        );

        if (!res.ok) {
          await throwHttpError(res);
        }

        return res.json();
      };

      const response = retryConfig
        ? await withRetry(sendFn, retryConfig, sessionAbort.signal)
        : await sendFn();

      seenMessageIds.add(response.id);
      return response;
    },

    markAsRead: async (messageId: string) => {
      // markAsRead intentionally does NOT use sessionAbort.signal — it must
      // survive disconnect() since it's called on unmount right before disconnect.
      const readFn = async (): Promise<void> => {
        const res = await fetch(`${serviceUrl}/channels/${channelId}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...customHeaders },
          body: JSON.stringify({
            participant_id: profile.id,
            message_id: messageId,
          }),
        });
        if (!res.ok) {
          await throwHttpError(res);
        }
      };

      if (retryConfig) {
        try {
          await withRetry(readFn, MARK_READ_RETRY_CONFIG);
        } catch (err) {
          // Surface non-retryable errors (403, 404) for dev diagnostics
          if (err instanceof HttpError) {
            callbacks.onError(err);
          }
          // Swallow RetryExhaustedError — markAsRead is best-effort
        }
      } else {
        await readFn();
      }
    },

    disconnect: () => {
      disposed = true;
      sessionAbort.abort();
      sseConn?.close();
      sseConn = null;
      callbacks.onStatusChange('disconnected');
    },
  };
}
