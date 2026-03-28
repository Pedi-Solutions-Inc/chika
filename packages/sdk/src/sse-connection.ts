import EventSource from 'react-native-sse';
import { calculateBackoff, type RetryConfig } from './retry';
import type { NetworkMonitor } from './network-monitor';

const DEFAULT_RECONNECT_DELAY_MS = 3000;

export interface SSEConnectionConfig {
  url: string;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  lastEventId?: string;
  customEvents?: string[];
  networkMonitor?: NetworkMonitor;
}

export interface SSEConnectionCallbacks {
  onOpen?: () => void;
  onEvent: (eventType: string, data: string, lastEventId?: string) => void;
  onError?: (error: Error) => void;
  onClosed?: () => void;
  onReconnecting?: () => void;
}

export interface SSEConnection {
  close: () => void;
  reconnectImmediate: () => void;
}

export function createSSEConnection(
  config: SSEConnectionConfig,
  callbacks: SSEConnectionCallbacks,
): SSEConnection {
  const baseDelay = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const customEvents = config.customEvents ?? [];
  const monitor = config.networkMonitor;

  const backoffConfig: RetryConfig = {
    maxAttempts: Infinity,
    baseDelayMs: baseDelay,
    maxDelayMs: 30000,
    jitterFactor: 0.3,
  };

  let currentLastEventId = config.lastEventId;
  let es: EventSource<string> | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let waitAbort: AbortController | null = null;

  function cleanup(): void {
    if (es) {
      es.removeAllEventListeners();
      es.close();
      es = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (waitAbort) {
      waitAbort.abort();
      waitAbort = null;
    }
  }

  async function scheduleReconnect(): Promise<void> {
    if (disposed || reconnectTimer || waitAbort) return;
    callbacks.onReconnecting?.();
    cleanup();

    // Wait for network if monitor available
    if (monitor && !monitor.isConnected()) {
      waitAbort = new AbortController();
      try {
        await monitor.waitForOnline(waitAbort.signal);
      } catch {
        return; // aborted via dispose
      }
      waitAbort = null;
      if (disposed) return;
    }

    const delay = calculateBackoff(attempt++, backoffConfig);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (disposed) return;

    es = new EventSource<string>(config.url, {
      headers: {
        ...config.headers,
        ...(currentLastEventId && { 'Last-Event-ID': currentLastEventId }),
      },
      pollingInterval: 0,
    });

    es.addEventListener('open', () => {
      if (disposed) return;
      attempt = 0;
      callbacks.onOpen?.();
    });

    es.addEventListener('message', (event) => {
      if (disposed || !event.data) return;
      if (event.lastEventId) {
        currentLastEventId = event.lastEventId;
      }
      callbacks.onEvent('message', event.data, event.lastEventId ?? undefined);
    });

    for (const eventName of customEvents) {
      es.addEventListener(eventName, (event) => {
        if (disposed) return;
        callbacks.onEvent(eventName, event.data ?? '', undefined);
      });
    }

    es.addEventListener('error', (event) => {
      if (disposed) return;

      const msg = 'message' in event ? String(event.message) : '';

      if (msg.includes('Channel is closed') || msg.includes('410')) {
        callbacks.onClosed?.();
        cleanup();
        disposed = true;
        return;
      }

      if (msg) callbacks.onError?.(new Error(msg));

      scheduleReconnect();
    });

    es.addEventListener('close', () => {
      if (disposed) return;
      scheduleReconnect();
    });
  }

  connect();

  return {
    close: () => {
      disposed = true;
      cleanup();
    },

    reconnectImmediate: () => {
      if (disposed) return;
      cleanup(); // does NOT set disposed
      attempt = 0;
      connect();
    },
  };
}
