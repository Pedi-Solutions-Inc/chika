export interface NetworkMonitor {
  isConnected(): boolean;
  subscribe(cb: (connected: boolean) => void): () => void;
  waitForOnline(signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

function createStubMonitor(): NetworkMonitor {
  return {
    isConnected: () => true,
    subscribe: () => () => {},
    waitForOnline: () => Promise.resolve(),
    dispose: () => {},
  };
}

let resolvedNetInfo: any = undefined;
let netInfoResolved = false;

function getNetInfo(): any {
  if (netInfoResolved) return resolvedNetInfo;
  netInfoResolved = true;
  try {
    resolvedNetInfo = require('@react-native-community/netinfo');
  } catch {
    resolvedNetInfo = null;
  }
  return resolvedNetInfo;
}

export function createNetworkMonitor(): NetworkMonitor {
  const NetInfo = getNetInfo();
  if (!NetInfo) return createStubMonitor();

  const netInfoModule = NetInfo.default ?? NetInfo;

  let connected = true;
  const listeners = new Set<(connected: boolean) => void>();
  let unsubscribeNetInfo: (() => void) | null = null;

  unsubscribeNetInfo = netInfoModule.addEventListener(
    (state: { isConnected: boolean | null }) => {
      const next = state.isConnected !== false;
      if (next === connected) return;
      connected = next;
      for (const cb of listeners) {
        cb(connected);
      }
    },
  );

  return {
    isConnected: () => connected,

    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    waitForOnline: (signal?) => {
      if (connected) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }

        const unsub = (): void => {
          listeners.delete(handler);
          signal?.removeEventListener('abort', onAbort);
        };

        const handler = (isOnline: boolean): void => {
          if (isOnline) {
            unsub();
            resolve();
          }
        };

        const onAbort = (): void => {
          unsub();
          reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
        };

        listeners.add(handler);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },

    dispose: () => {
      listeners.clear();
      unsubscribeNetInfo?.();
      unsubscribeNetInfo = null;
    },
  };
}
