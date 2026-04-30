import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageQueue } from '../message-queue';
import { HttpError, ChatDisconnectedError } from '../errors';
import { DEFAULT_RETRY_CONFIG } from '../retry';
import type { NetworkMonitor } from '../network-monitor';

const stubMonitor = (): NetworkMonitor => ({
  isConnected: () => true,
  subscribe: () => () => {},
  waitForOnline: () => Promise.resolve(),
  dispose: () => {},
});

const fastRetryConfig = { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };

describe('PCA-472 regression: queue invariants', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('keeps a failed entry visible after non-retryable error so consumers can render it', async () => {
    const onStatusChange = vi.fn();
    const queue = new MessageQueue({
      channelId: 'test-channel',
      maxSize: 50,
      retryConfig: fastRetryConfig,
      networkMonitor: stubMonitor(),
      onStatusChange,
    });

    const sendFn = vi.fn(async () => {
      throw new HttpError(400, 'bad request');
    });

    const promise = queue.enqueue(sendFn, 'optimistic_test_1');
    await expect(promise).rejects.toBeInstanceOf(HttpError);

    const all = queue.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.optimisticId).toBe('optimistic_test_1');
    expect(all[0]?.status).toBe('failed');
    expect(onStatusChange).toHaveBeenCalled();
  });

  it('reverts to queued (does NOT mark failed) on ChatDisconnectedError so flush can resume on reconnect', async () => {
    const onStatusChange = vi.fn();
    const queue = new MessageQueue({
      channelId: 'test-channel',
      maxSize: 50,
      retryConfig: fastRetryConfig,
      networkMonitor: stubMonitor(),
      onStatusChange,
    });

    const sendFn = vi.fn(async () => {
      throw new ChatDisconnectedError('disconnected');
    });

    queue.enqueue(sendFn, 'optimistic_test_2').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));

    const all = queue.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('queued');
  });

  it('dispose() calls onStatusChange so consumers clear stale pendingMessages', async () => {
    const onStatusChange = vi.fn();
    const queue = new MessageQueue({
      channelId: 'test-channel',
      maxSize: 50,
      retryConfig: fastRetryConfig,
      networkMonitor: stubMonitor(),
      onStatusChange,
    });

    const sendFn = vi.fn(() => new Promise<never>(() => {}));
    queue.enqueue(sendFn, 'optimistic_test_3').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5));

    onStatusChange.mockClear();

    queue.dispose();

    expect(queue.getAll()).toHaveLength(0);
    expect(onStatusChange).toHaveBeenCalled();
  });
});
