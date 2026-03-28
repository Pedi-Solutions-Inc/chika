import EventSource from 'react-native-sse';

const DEFAULT_RECONNECT_DELAY_MS = 3000;

export interface SSEConnectionConfig {
  url: string;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  lastEventId?: string;
  customEvents?: string[];
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
}

export function createSSEConnection(
  config: SSEConnectionConfig,
  callbacks: SSEConnectionCallbacks,
): SSEConnection {
  const reconnectDelay = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const customEvents = config.customEvents ?? [];

  let currentLastEventId = config.lastEventId;
  let es: EventSource<string> | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function cleanup(): void {
    if (es) {
      es.removeAllEventListeners();
      es.close();
      es = null;
    }
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return;
    callbacks.onReconnecting?.();
    cleanup();

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
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
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanup();
    },
  };
}
