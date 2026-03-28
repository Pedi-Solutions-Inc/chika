import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import type { UnreadCountResponse, SSEUnreadUpdateEvent } from '@pedi/chika-types';
import type { ChatConfig } from './types';
import { resolveServerUrl } from './resolve-url';
import { createSSEConnection, type SSEConnection } from './sse-connection';
import { createNetworkMonitor, type NetworkMonitor } from './network-monitor';

const DEFAULT_BACKGROUND_GRACE_MS = 2000;
const UNREAD_CUSTOM_EVENTS = ['unread_snapshot', 'unread_update', 'unread_clear'];

export interface UseUnreadOptions {
  config: ChatConfig;
  channelId: string;
  participantId: string;
  enabled?: boolean;
}

export interface UseUnreadReturn {
  unreadCount: number;
  hasUnread: boolean;
  lastMessageAt: string | null;
  error: Error | null;
}

export function useUnread(options: UseUnreadOptions): UseUnreadReturn {
  const { config, channelId, participantId, enabled = true } = options;

  const [unreadCount, setUnreadCount] = useState(0);
  const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const connRef = useRef<SSEConnection | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const backgroundGraceMs =
    config.backgroundGraceMs ?? (Platform.OS === 'android' ? DEFAULT_BACKGROUND_GRACE_MS : 0);

  const [monitor, setMonitor] = useState<NetworkMonitor | null>(null);
  const resilienceEnabled = config.resilience !== false;
  const injectedMonitor =
    typeof config.resilience === 'object' ? config.resilience.networkMonitor : undefined;

  useEffect(() => {
    if (!resilienceEnabled) {
      setMonitor(null);
      return;
    }
    if (injectedMonitor) {
      setMonitor(injectedMonitor);
      return;
    }
    const m = createNetworkMonitor();
    setMonitor(m);
    return () => {
      m.dispose();
      setMonitor(null);
    };
  }, [resilienceEnabled, injectedMonitor]);

  const connect = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;

    const serviceUrl = resolveServerUrl(configRef.current.manifest, channelId);
    const customHeaders = configRef.current.headers ?? {};
    const url = `${serviceUrl}/channels/${channelId}/unread?participant_id=${encodeURIComponent(participantId)}`;

    connRef.current = createSSEConnection(
      {
        url,
        headers: customHeaders,
        reconnectDelayMs: configRef.current.reconnectDelayMs,
        customEvents: UNREAD_CUSTOM_EVENTS,
        networkMonitor: monitor ?? undefined,
      },
      {
        onOpen: () => {
          setError(null);
        },
        onEvent: (eventType, data) => {
          try {
            if (eventType === 'unread_snapshot') {
              const snapshot: UnreadCountResponse = JSON.parse(data);
              setUnreadCount(snapshot.unread_count);
              setLastMessageAt(snapshot.last_message_at);
            } else if (eventType === 'unread_update') {
              const update: SSEUnreadUpdateEvent['data'] = JSON.parse(data);
              setUnreadCount((prev) => prev + 1);
              setLastMessageAt(update.created_at);
            } else if (eventType === 'unread_clear') {
              const clear: { channel_id: string; unread_count: number } = JSON.parse(data);
              setUnreadCount(clear.unread_count);
            }
          } catch {
            setError(new Error('Failed to parse unread SSE event'));
          }
        },
        onError: (err) => {
          setError(err);
        },
        onClosed: () => {
          connRef.current = null;
        },
      },
    );
  }, [channelId, participantId, monitor]);

  const disconnect = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
  }, []);

  useEffect(() => {
    setUnreadCount(0);
    setLastMessageAt(null);
    setError(null);

    if (!enabled) {
      disconnect();
      return;
    }

    // Wait for monitor before connecting (avoids double-connect on mount)
    if (resilienceEnabled && !monitor) return;

    connect();

    return () => {
      disconnect();
      if (backgroundTimerRef.current) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }
    };
  }, [channelId, participantId, enabled, connect, disconnect]);

  useEffect(() => {
    if (!enabled) return;

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextAppState;

      if (!connRef.current && nextAppState !== 'active') return;

      const shouldTeardown =
        nextAppState === 'background' ||
        (Platform.OS === 'ios' && nextAppState === 'inactive');

      if (nextAppState === 'active') {
        if (backgroundTimerRef.current) {
          clearTimeout(backgroundTimerRef.current);
          backgroundTimerRef.current = null;
          return;
        }

        if (prev.match(/inactive|background/) && !connRef.current) {
          connect();
        }
      } else if (shouldTeardown) {
        if (backgroundTimerRef.current) return;

        if (backgroundGraceMs === 0) {
          disconnect();
        } else {
          backgroundTimerRef.current = setTimeout(() => {
            backgroundTimerRef.current = null;
            disconnect();
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
  }, [enabled, backgroundGraceMs, connect, disconnect]);

  return { unreadCount, hasUnread: unreadCount > 0, lastMessageAt, error };
}
