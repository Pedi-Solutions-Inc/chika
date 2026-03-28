import type { SendMessageResponse } from '@pedi/chika-types';
import { withRetry, type RetryConfig } from './retry';
import { QueueFullError, ChatDisconnectedError } from './errors';
import type { NetworkMonitor } from './network-monitor';

export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let resolvedStorage: { type: string; adapter: QueueStorage } | null | undefined;

function tryRequire(name: string): any {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function createMmkvAdapter(mod: any): QueueStorage {
  const MMKV = mod.MMKV ?? mod.default?.MMKV ?? mod;
  const instance = new MMKV({ id: 'chika-queue' });
  return {
    getItem: (key) => Promise.resolve(instance.getString(key) ?? null),
    setItem: (key, value) => { instance.set(key, value); return Promise.resolve(); },
    removeItem: (key) => { instance.delete(key); return Promise.resolve(); },
  };
}

function createAsyncStorageAdapterFrom(mod: any): QueueStorage {
  const storage = mod.default ?? mod;
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}

/**
 * Auto-detect the best available storage for queue persistence.
 * Priority: react-native-mmkv (fastest, sync) > AsyncStorage > null.
 * Returns `null` if neither is installed — no hard dependencies.
 *
 * Usage:
 * ```ts
 * import { createQueueStorage } from '@pedi/chika-sdk';
 *
 * const config: ChatConfig = {
 *   resilience: {
 *     queueStorage: createQueueStorage() ?? undefined,
 *   },
 * };
 * ```
 */
export function createQueueStorage(): QueueStorage | null {
  if (resolvedStorage !== undefined) return resolvedStorage?.adapter ?? null;

  // Priority 1: MMKV (synchronous, fastest)
  const mmkv = tryRequire('react-native-mmkv');
  if (mmkv) {
    try {
      const adapter = createMmkvAdapter(mmkv);
      resolvedStorage = { type: 'mmkv', adapter };
      return adapter;
    } catch {
      // MMKV instantiation can fail if native module isn't linked
    }
  }

  // Priority 2: AsyncStorage
  const asyncStorage = tryRequire('@react-native-async-storage/async-storage');
  if (asyncStorage) {
    const adapter = createAsyncStorageAdapterFrom(asyncStorage);
    resolvedStorage = { type: 'async-storage', adapter };
    return adapter;
  }

  resolvedStorage = null;
  return null;
}

/**
 * Creates a QueueStorage adapter backed by `@react-native-async-storage/async-storage`.
 * Returns `null` if the package is not installed.
 */
export function createAsyncStorageAdapter(): QueueStorage | null {
  const mod = tryRequire('@react-native-async-storage/async-storage');
  if (!mod) return null;
  return createAsyncStorageAdapterFrom(mod);
}

export type MessageSendStatus = 'sending' | 'queued' | 'failed';

export interface QueuedMessage {
  optimisticId: string;
  status: MessageSendStatus;
  error?: Error;
  retryCount: number;
}

type SendFn = () => Promise<SendMessageResponse>;

interface QueueEntry {
  optimisticId: string;
  sendFn: SendFn;
  status: MessageSendStatus;
  error?: Error;
  retryCount: number;
  abort: AbortController;
  resolve: (value: SendMessageResponse) => void;
  reject: (reason: Error) => void;
}

/** Serializable subset persisted to storage. */
interface PersistedEntry {
  optimisticId: string;
  retryCount: number;
}

export interface MessageQueueConfig {
  channelId: string;
  maxSize: number;
  retryConfig: RetryConfig;
  networkMonitor: NetworkMonitor;
  storage?: QueueStorage;
  onError?: (error: Error) => void;
  onStatusChange?: () => void;
}

export class MessageQueue {
  private entries: QueueEntry[] = [];
  private flushing = false;
  private unsubNetwork: (() => void) | null = null;
  private readonly storageKey: string;

  constructor(private readonly config: MessageQueueConfig) {
    this.storageKey = `chika_queue_${config.channelId}`;

    this.unsubNetwork = config.networkMonitor.subscribe((connected) => {
      if (connected) this.flush();
    });
  }

  /**
   * Restore queued messages from persistent storage on cold start.
   * Restored entries are fire-and-forget — there is no caller awaiting their
   * promise (the original enqueue() caller is gone after app restart).
   * Success/failure is reported via onStatusChange/onError callbacks.
   */
  async restore(
    rebuildSendFn: (optimisticId: string) => SendFn | null,
  ): Promise<void> {
    if (!this.config.storage) return;

    try {
      const raw = await this.config.storage.getItem(this.storageKey);
      if (!raw) return;

      const persisted: PersistedEntry[] = JSON.parse(raw);
      for (const entry of persisted) {
        const sendFn = rebuildSendFn(entry.optimisticId);
        if (!sendFn) continue;

        const abort = new AbortController();
        this.entries.push({
          optimisticId: entry.optimisticId,
          sendFn,
          status: 'queued',
          retryCount: entry.retryCount,
          abort,
          // No-op: restored entries have no caller awaiting the promise.
          resolve: () => {},
          reject: () => {},
        });
      }

      if (this.entries.length > 0) {
        this.config.onStatusChange?.();
        this.flush();
      }
    } catch {
      this.config.onError?.(new Error('Failed to restore message queue from storage'));
    }
  }

  get pendingCount(): number {
    return this.entries.length;
  }

  getAll(): QueuedMessage[] {
    return this.entries.map((e) => ({
      optimisticId: e.optimisticId,
      status: e.status,
      error: e.error,
      retryCount: e.retryCount,
    }));
  }

  getStatus(optimisticId: string): QueuedMessage | undefined {
    const entry = this.entries.find((e) => e.optimisticId === optimisticId);
    if (!entry) return undefined;
    return {
      optimisticId: entry.optimisticId,
      status: entry.status,
      error: entry.error,
      retryCount: entry.retryCount,
    };
  }

  enqueue(sendFn: SendFn, optimisticId: string): Promise<SendMessageResponse> {
    if (this.entries.length >= this.config.maxSize) {
      throw new QueueFullError(this.config.maxSize);
    }

    const abort = new AbortController();

    return new Promise<SendMessageResponse>((resolve, reject) => {
      const entry: QueueEntry = {
        optimisticId,
        sendFn,
        status: 'queued',
        retryCount: 0,
        abort,
        resolve,
        reject,
      };

      this.entries.push(entry);
      this.config.onStatusChange?.();
      this.persist();
      this.flush();
    });
  }

  cancel(optimisticId: string): void {
    const idx = this.entries.findIndex((e) => e.optimisticId === optimisticId);
    if (idx === -1) return;

    const entry = this.entries[idx]!;
    entry.abort.abort();
    entry.reject(new DOMException('Cancelled', 'AbortError'));
    this.entries.splice(idx, 1);
    this.config.onStatusChange?.();
    this.persist();
  }

  retry(optimisticId: string): void {
    const entry = this.entries.find((e) => e.optimisticId === optimisticId);
    if (!entry || entry.status !== 'failed') return;

    entry.status = 'queued';
    entry.error = undefined;
    entry.abort = new AbortController();
    this.config.onStatusChange?.();
    this.flush();
  }

  dispose(): void {
    this.unsubNetwork?.();
    this.unsubNetwork = null;

    for (const entry of this.entries) {
      entry.abort.abort();
      entry.reject(new DOMException('Queue disposed', 'AbortError'));
    }
    this.entries = [];
  }

  /**
   * Trigger a flush of queued messages. Returns immediately if a flush is
   * already in progress or the network is offline. The in-progress flush
   * will pick up any newly queued entries via its while loop.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (!this.config.networkMonitor.isConnected()) return;

    this.flushing = true;
    let awaitingSession = false;

    try {
      while (this.entries.length > 0) {
        // Only pick up 'queued' entries — 'sending' means a previous flush is
        // mid-request. Server-side idempotency key prevents duplicates if the
        // prior request actually succeeded but we never got the response.
        const entry = this.entries.find((e) => e.status === 'queued');
        if (!entry) break;
        if (!this.config.networkMonitor.isConnected()) break;

        entry.status = 'sending';
        this.config.onStatusChange?.();

        try {
          const result = await withRetry(
            entry.sendFn,
            this.config.retryConfig,
            entry.abort.signal,
          );

          entry.resolve(result);
          const idx = this.entries.indexOf(entry);
          if (idx !== -1) this.entries.splice(idx, 1);
          this.config.onStatusChange?.();
          this.persist();
        } catch (err) {
          if (entry.abort.signal.aborted) continue; // cancelled, already removed

          // Session not yet reconnected — revert to 'queued' and stop flushing.
          // flush() will be called again when the session is re-established
          // via the explicit flush() call in use-chat.ts startSession().
          if (err instanceof ChatDisconnectedError) {
            entry.status = 'queued';
            this.config.onStatusChange?.();
            awaitingSession = true;
            break;
          }

          entry.status = 'failed';
          entry.error = err instanceof Error ? err : new Error(String(err));
          entry.retryCount++;
          this.config.onStatusChange?.();
          this.persist();

          // Don't block the queue on a failed entry — skip to next
        }
      }
    } finally {
      this.flushing = false;
      // Re-check: entries may have been added while we were flushing.
      // Skip if we're waiting for session — startSession() will call flush().
      if (
        !awaitingSession &&
        this.entries.some((e) => e.status === 'queued') &&
        this.config.networkMonitor.isConnected()
      ) {
        queueMicrotask(() => this.flush());
      }
    }
  }

  private persist(): void {
    if (!this.config.storage) return;

    const data: PersistedEntry[] = this.entries.map((e) => ({
      optimisticId: e.optimisticId,
      retryCount: e.retryCount,
    }));

    const onErr = (err: unknown) => {
      this.config.onError?.(
        err instanceof Error ? err : new Error('Queue storage write failed'),
      );
    };

    if (data.length === 0) {
      this.config.storage.removeItem(this.storageKey).catch(onErr);
    } else {
      this.config.storage
        .setItem(this.storageKey, JSON.stringify(data))
        .catch(onErr);
    }
  }
}
