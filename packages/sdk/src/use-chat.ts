import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import type {
  ChatDomain,
  DefaultDomain,
  Message,
  Participant,
  MessageAttributes,
  SendMessageResponse,
} from '@pedi/chika-types';
import type { UseChatOptions, UseChatReturn, ChatStatus } from './types';
import { ChatDisconnectedError, ChannelClosedError } from './errors';
import { createChatSession, type ChatSession, type SessionCallbacks } from './session';

const DEFAULT_BACKGROUND_GRACE_MS = 2000;

/**
 * React hook for real-time chat over SSE.
 * Manages connection lifecycle, AppState transitions, message deduplication, and reconnection.
 *
 * @template D - Chat domain type for role/message type narrowing. Defaults to DefaultDomain.
 */
export function useChat<D extends ChatDomain = DefaultDomain>(
  { config, channelId, profile, onMessage }: UseChatOptions<D>,
): UseChatReturn<D> {
  const [messages, setMessages] = useState<Message<D>[]>([]);
  const [participants, setParticipants] = useState<Participant<D>[]>([]);
  const [status, setStatus] = useState<ChatStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);

  const sessionRef = useRef<ChatSession<D> | null>(null);
  const disposedRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const statusRef = useRef(status);
  statusRef.current = status;
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const configRef = useRef(config);
  configRef.current = config;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const startingRef = useRef(false);
  const pendingOptimisticIds = useRef(new Set<string>());

  const backgroundGraceMs =
    config.backgroundGraceMs ?? (Platform.OS === 'android' ? DEFAULT_BACKGROUND_GRACE_MS : 0);

  const callbacks: SessionCallbacks<D> = {
    onMessage: (message) => {
      if (disposedRef.current) return;
      setMessages((prev: Message<D>[]) => {
        // Check if this SSE message reconciles a pending optimistic message.
        const optimisticIdx = prev.findIndex(
          (m) =>
            pendingOptimisticIds.current.has(m.id) &&
            m.sender_id === message.sender_id &&
            m.body === message.body &&
            m.type === message.type,
        );
        if (optimisticIdx !== -1) {
          const optimisticId = prev[optimisticIdx]!.id;
          pendingOptimisticIds.current.delete(optimisticId);
          const next = [...prev];
          next[optimisticIdx] = message;
          return next;
        }
        return [...prev, message];
      });
      onMessageRef.current?.(message);
    },
    onStatusChange: (nextStatus) => {
      if (disposedRef.current) return;
      setStatus(nextStatus);
      if (nextStatus === 'connected') setError(null);
    },
    onError: (err) => {
      if (disposedRef.current) return;
      setError(err);
    },
    onResync: () => {
      if (disposedRef.current) return;
      startSession();
    },
  };

  async function startSession(): Promise<void> {
    if (startingRef.current) return;
    startingRef.current = true;

    const existing = sessionRef.current;
    if (existing) {
      existing.disconnect();
      sessionRef.current = null;
    }

    try {
      const session = await createChatSession<D>(configRef.current, channelId, profileRef.current, callbacks);

      if (disposedRef.current) {
        session.disconnect();
        return;
      }

      sessionRef.current = session;
      setParticipants(session.initialParticipants);
      setMessages(session.initialMessages);
    } catch (err) {
      if (disposedRef.current) return;

      if (err instanceof ChannelClosedError) {
        setStatus('closed');
        setError(err);
        return;
      }

      setStatus('error');
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      startingRef.current = false;
    }
  }

  useEffect(() => {
    disposedRef.current = false;
    startSession();

    return () => {
      disposedRef.current = true;
      if (statusRef.current === 'connected' && sessionRef.current) {
        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        if (lastMsg) {
          sessionRef.current.markAsRead(lastMsg.id).catch(() => {});
        }
      }
      if (backgroundTimerRef.current) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }
      sessionRef.current?.disconnect();
      sessionRef.current = null;
    };
  }, [channelId]);

  useEffect(() => {
    function teardownSession(): void {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      setStatus('disconnected');
    }

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextAppState;

      if (!sessionRef.current && nextAppState !== 'active') return;

      const shouldTeardown =
        nextAppState === 'background' ||
        (Platform.OS === 'ios' && nextAppState === 'inactive');

      if (nextAppState === 'active') {
        if (backgroundTimerRef.current) {
          clearTimeout(backgroundTimerRef.current);
          backgroundTimerRef.current = null;
          return;
        }

        if (prev.match(/inactive|background/) && !sessionRef.current) {
          startSession();
        }
      } else if (shouldTeardown) {
        if (backgroundTimerRef.current) return;

        if (backgroundGraceMs === 0) {
          teardownSession();
        } else {
          backgroundTimerRef.current = setTimeout(() => {
            backgroundTimerRef.current = null;
            teardownSession();
          }, backgroundGraceMs);
        }
      }
    });

    return () => {
      subscription.remove();
      if (backgroundTimerRef.current) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }
    };
  }, [channelId, backgroundGraceMs]);

  const sendMessage = useCallback(
    async (type: D['messageType'], body: string, attributes?: MessageAttributes<D>): Promise<SendMessageResponse> => {
      const session = sessionRef.current;
      if (!session) throw new ChatDisconnectedError(statusRef.current);

      const optimistic = configRef.current.optimisticSend !== false;
      let optimisticId: string | null = null;

      if (optimistic) {
        optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        pendingOptimisticIds.current.add(optimisticId);
        const provisionalMsg: Message<D> = {
          id: optimisticId,
          channel_id: channelId,
          sender_id: profileRef.current.id,
          sender_role: profileRef.current.role as D['role'],
          type,
          body,
          attributes: (attributes ?? {}) as MessageAttributes<D>,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, provisionalMsg]);
      }

      try {
        const response = await session.sendMessage(type, body, attributes);

        if (optimistic && optimisticId) {
          pendingOptimisticIds.current.delete(optimisticId);
          setMessages((prev) => {
            // If SSE already reconciled this message, the optimistic ID is gone.
            const stillPending = prev.some((m) => m.id === optimisticId);
            if (!stillPending) return prev;
            return prev.map((m) =>
              m.id === optimisticId
                ? { ...m, id: response.id, created_at: response.created_at }
                : m,
            );
          });
        }

        return response;
      } catch (err) {
        if (optimistic && optimisticId) {
          pendingOptimisticIds.current.delete(optimisticId);
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        }
        throw err;
      }
    },
    [channelId],
  );

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    setStatus('disconnected');
  }, []);

  return { messages, participants, status, error, sendMessage, disconnect };
}
