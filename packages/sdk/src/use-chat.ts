import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import type {
  ChatDomain,
  DefaultDomain,
  Message,
  Participant,
  MessageAttributes,
  SendMessageResponse,
} from '@pedi/chika-types';
import type { UseChatOptions, UseChatReturn, ChatStatus, ChatMessage } from './types';
import { ChatDisconnectedError, ChannelClosedError, QueueFullError, RetryExhaustedError } from './errors';
import { isRetryableError, resolveRetryConfig } from './retry';
import { createChatSession, type ChatSession, type SessionCallbacks } from './session';
import { createNetworkMonitor, type NetworkMonitor } from './network-monitor';
import { MessageQueue, type QueuedMessage } from './message-queue';

const DEFAULT_BACKGROUND_GRACE_MS = 2000;
const DEFAULT_MAX_QUEUE_SIZE = 50;

// Module-scope queue registry, keyed by channelId. Survives component remounts.
const queueRegistry = new Map<string, { queue: MessageQueue; refCount: number }>();

/**
 * React hook for real-time chat over SSE.
 * Manages connection lifecycle, AppState transitions, message deduplication, reconnection,
 * and optional network resilience (retry, offline queue, network monitoring).
 *
 * @template D - Chat domain type for role/message type narrowing. Defaults to DefaultDomain.
 */
export function useChat<D extends ChatDomain = DefaultDomain>(
  { config, channelId, profile, onMessage, resolveSystemProfile }: UseChatOptions<D>,
): UseChatReturn<D> {
  const [messages, setMessages] = useState<Message<D>[]>([]);
  const [participants, setParticipants] = useState<Participant<D>[]>([]);
  const [status, setStatus] = useState<ChatStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const [pendingMessages, setPendingMessages] = useState<QueuedMessage[]>([]);

  const sessionRef = useRef<ChatSession<D> | null>(null);
  const disposedRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
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
  const resolveSystemProfileRef = useRef(resolveSystemProfile);
  resolveSystemProfileRef.current = resolveSystemProfile;
  const startingRef = useRef(false);
  const pendingOptimisticIds = useRef(new Set<string>());
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [monitor, setMonitor] = useState<NetworkMonitor | null>(null);
  const [monitorReady, setMonitorReady] = useState(false);
  const monitorRef = useRef<NetworkMonitor | null>(null);
  monitorRef.current = monitor;
  const queueRef = useRef<MessageQueue | null>(null);

  const resilienceEnabled = config.resilience !== false;
  const queueEnabled =
    resilienceEnabled &&
    (typeof config.resilience === 'object' ? config.resilience.offlineQueue !== false : true);
  const retryConfig = resolveRetryConfig(config.resilience);
  const maxQueueSize =
    (resilienceEnabled && config.resilience && typeof config.resilience === 'object'
      ? config.resilience.maxQueueSize
      : undefined) ?? DEFAULT_MAX_QUEUE_SIZE;

  const backgroundGraceMs =
    config.backgroundGraceMs ?? (Platform.OS === 'android' ? DEFAULT_BACKGROUND_GRACE_MS : 0);

  // Resolve user-injected monitor (stable reference, no side effect)
  const injectedMonitor =
    typeof config.resilience === 'object' ? config.resilience.networkMonitor : undefined;

  // Create monitor in useEffect to avoid side effects during render.
  // Uses state (not ref) so the queue effect re-runs when monitor is ready.
  useEffect(() => {
    if (!resilienceEnabled) {
      setMonitor(null);
      setMonitorReady(true);
      return;
    }
    if (injectedMonitor) {
      setMonitor(injectedMonitor);
      setMonitorReady(true);
      return; // user owns lifecycle
    }
    try {
      const m = createNetworkMonitor();
      setMonitor(m);
      setMonitorReady(true);
      return () => {
        m.dispose();
        setMonitor(null);
      };
    } catch {
      // NetInfo native module may be present but not linked — fall back to
      // no monitor so the session effect guard doesn't block forever.
      setMonitor(null);
      setMonitorReady(true);
    }
  }, [resilienceEnabled, injectedMonitor]);

  // Debounced markAsRead: batches rapid incoming messages into a single POST.
  // Keeps unread count in sync while the user is viewing the chat.
  function scheduleMarkAsRead(messageId: string): void {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => {
      markReadTimerRef.current = null;
      sessionRef.current?.markAsRead(messageId).catch(() => {});
    }, 500);
  }

  // Flush pending debounced markAsRead and send a final one with the latest message.
  // Used by all teardown paths (unmount, background, manual disconnect).
  function flushMarkReadAndDisconnect(): void {
    if (markReadTimerRef.current) {
      clearTimeout(markReadTimerRef.current);
      markReadTimerRef.current = null;
    }
    if (sessionRef.current) {
      const lastMsg = messagesRef.current[messagesRef.current.length - 1];
      if (lastMsg) {
        sessionRef.current.markAsRead(lastMsg.id).catch(() => {});
      }
    }
    sessionRef.current?.disconnect();
    sessionRef.current = null;
  }

  const callbacks: SessionCallbacks<D> = {
    onMessage: (message) => {
      if (disposedRef.current) return;
      let matchedOptimisticId: string | null = null;
      setMessages((prev: Message<D>[]) => {
        if (pendingOptimisticIds.current.size === 0) {
          return [...prev, message];
        }

        const optimisticIdx = prev.findIndex(
          (m) =>
            pendingOptimisticIds.current.has(m.id) &&
            m.sender_id === message.sender_id &&
            m.body === message.body &&
            m.type === message.type,
        );
        if (optimisticIdx !== -1) {
          matchedOptimisticId = prev[optimisticIdx]!.id;
          pendingOptimisticIds.current.delete(matchedOptimisticId);
          const next = [...prev];
          next[optimisticIdx] = message;
          return next;
        }
        return [...prev, message];
      });
      // Clean up any queued/failed queue entry — SSE confirmed delivery.
      // Done outside setMessages updater to avoid setState-in-setState.
      if (matchedOptimisticId) {
        const s = queueRef.current?.getStatus(matchedOptimisticId);
        if (s && s.status !== 'sending') {
          queueRef.current?.cancel(matchedOptimisticId);
        }
      }
      // Debounced markAsRead keeps unread count in sync while viewing chat.
      // Only mark for messages from others (not our own SSE echo).
      if (message.sender_id !== profileRef.current.id) {
        scheduleMarkAsRead(message.id);
      }
      const resolver = resolveSystemProfileRef.current;
      if (resolver && message.sender_role === 'system') {
        const resolvedProfile = resolver(message, participantsRef.current);
        onMessageRef.current?.(resolvedProfile ? { ...message, as_participant: resolvedProfile } : message);
      } else {
        onMessageRef.current?.(message);
      }
    },
    onStatusChange: (nextStatus) => {
      if (disposedRef.current) return;
      setStatus(nextStatus);
      if (nextStatus === 'connected') {
        setError(null);
      }
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
      const session = await createChatSession<D>(
        configRef.current,
        channelId,
        profileRef.current,
        callbacks,
        monitorRef.current ?? undefined,
      );

      if (disposedRef.current) {
        session.disconnect();
        return;
      }

      sessionRef.current = session;
      setParticipants(session.initialParticipants);

      // Flush any messages queued while session was unavailable
      queueRef.current?.flush();

      // Re-merge any pending optimistic messages after resync
      if (pendingOptimisticIds.current.size > 0) {
        const pendingIds = pendingOptimisticIds.current;
        setMessages((prev) => {
          const pendingMsgs = prev.filter((m) => pendingIds.has(m.id));
          return [...session.initialMessages, ...pendingMsgs];
        });
      } else {
        setMessages(session.initialMessages);
      }

      // Mark latest message as read so the server broadcasts unread_clear.
      // Uses scheduleMarkAsRead (debounced) so that if SSE delivers additional
      // messages right after join, they're covered by the same batched call.
      const lastInitMsg = session.initialMessages[session.initialMessages.length - 1];
      if (lastInitMsg) {
        scheduleMarkAsRead(lastInitMsg.id);
      }
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

  // Session lifecycle
  useEffect(() => {
    disposedRef.current = false;
    // Don't start until monitor initialization is complete
    if (!monitorReady) return;
    startSession();

    return () => {
      disposedRef.current = true;
      flushMarkReadAndDisconnect();
      if (backgroundTimerRef.current) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }
    };
  }, [channelId, monitorReady]);

  // Module-scope queue lifecycle (ref-counted, survives remounts)
  useEffect(() => {
    if (!queueEnabled || !monitor || !retryConfig) return;

    let entry = queueRegistry.get(channelId);
    if (!entry) {
      const queue = new MessageQueue({
        channelId,
        maxSize: maxQueueSize,
        retryConfig,
        networkMonitor: monitor,
        storage:
          typeof config.resilience === 'object'
            ? config.resilience.queueStorage
            : undefined,
        onError: (err) => {
          if (!disposedRef.current) setError(err);
        },
        onStatusChange: () => {
          if (!disposedRef.current) {
            setPendingMessages(queueRef.current?.getAll() ?? []);
          }
        },
      });
      entry = { queue, refCount: 0 };
      queueRegistry.set(channelId, entry);
    }
    entry.refCount++;
    queueRef.current = entry.queue;

    return () => {
      const e = queueRegistry.get(channelId);
      if (e) {
        e.refCount--;
        if (e.refCount <= 0) {
          e.queue.dispose();
          queueRegistry.delete(channelId);
        }
      }
      queueRef.current = null;
    };
  }, [channelId, queueEnabled, monitor]);

  // Network monitor: auto-rejoin on connectivity return when in error state
  useEffect(() => {
    if (!monitor || !resilienceEnabled) return;

    const unsub = monitor.subscribe((connected: boolean) => {
      if (connected && statusRef.current === 'error' && !startingRef.current) {
        startSession();
      }
    });

    return unsub;
  }, [channelId, resilienceEnabled, monitor]);

  // AppState lifecycle
  useEffect(() => {
    function teardownSession(): void {
      flushMarkReadAndDisconnect();
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
      // Serves as both the optimistic message ID and the server-side idempotency key
      const messageKey = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      if (optimistic) {
        pendingOptimisticIds.current.add(messageKey);
        const provisionalMsg: Message<D> = {
          id: messageKey,
          channel_id: channelId,
          sender_id: profileRef.current.id,
          sender_role: profileRef.current.role,
          type,
          body,
          attributes: (attributes ?? {}) as MessageAttributes<D>,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, provisionalMsg]);
      }

      const doSend = () => {
        const s = sessionRef.current;
        if (!s) throw new ChatDisconnectedError(statusRef.current);
        return s.sendMessage(type, body, attributes, messageKey);
      };

      const handleSuccess = (response: SendMessageResponse): void => {
        if (optimistic) {
          pendingOptimisticIds.current.delete(messageKey);
          setMessages((prev) => {
            const stillPending = prev.some((m) => m.id === messageKey);
            if (!stillPending) return prev;
            return prev.map((m) =>
              m.id === messageKey
                ? { ...m, id: response.id, created_at: response.created_at }
                : m,
            );
          });
        }
      };

      const handleError = (_err: unknown): void => {
        if (optimistic) {
          pendingOptimisticIds.current.delete(messageKey);
          setMessages((prev) => prev.filter((m) => m.id !== messageKey));
        }
      };

      // Queue path: enqueue and let queue handle retry + offline
      if (queueRef.current) {
        try {
          const response = await queueRef.current.enqueue(doSend, messageKey);
          handleSuccess(response);
          return response;
        } catch (err) {
          if (err instanceof QueueFullError) {
            handleError(err);
            throw err;
          }
          if (err instanceof RetryExhaustedError || !isRetryableError(err)) {
            // For failed messages: if optimistic, mark as failed (keep in UI)
            // The pendingMessages state shows the status
            if (optimistic && err instanceof RetryExhaustedError) {
              // Keep optimistic message visible — queue tracks status as 'failed'.
              // Keep messageKey in pendingOptimisticIds so SSE reconciliation can
              // still match if the server eventually received the message.
              // Removed on explicit cancelMessage() call.
            } else {
              handleError(err);
            }
            throw err;
          }
          handleError(err);
          throw err;
        }
      }

      // Non-queue path: direct send (session.ts handles retry if enabled)
      try {
        const response = await doSend();
        handleSuccess(response);
        return response;
      } catch (err) {
        handleError(err);
        throw err;
      }
    },
    [channelId],
  );

  const cancelMessage = useCallback(
    (optimisticId: string) => {
      queueRef.current?.cancel(optimisticId);
      pendingOptimisticIds.current.delete(optimisticId);
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    },
    [],
  );

  const retryMessage = useCallback(
    (optimisticId: string) => {
      queueRef.current?.retry(optimisticId);
    },
    [],
  );

  const disconnect = useCallback(() => {
    flushMarkReadAndDisconnect();
    setStatus('disconnected');
  }, []);

  const enrichedMessages: ChatMessage<D>[] = useMemo(() => {
    if (!resolveSystemProfile) return messages;
    return messages.map((msg) => {
      if (msg.sender_role !== 'system') return msg;
      const resolved = resolveSystemProfile(msg, participants);
      return resolved ? { ...msg, as_participant: resolved } : msg;
    });
  }, [messages, participants, resolveSystemProfile]);

  return {
    messages: enrichedMessages,
    participants,
    status,
    error,
    sendMessage,
    disconnect,
    pendingMessages,
    cancelMessage,
    retryMessage,
  };
}
