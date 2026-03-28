import {
  HttpError,
  RetryExhaustedError,
  ChannelClosedError,
  ChatDisconnectedError,
  QueueFullError,
} from './errors';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  jitterFactor: 0.3,
};

export function calculateBackoff(attempt: number, config: RetryConfig): number {
  const delay = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * config.jitterFactor;
  return Math.round(delay * jitter);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ChannelClosedError) return false;
  if (error instanceof ChatDisconnectedError) return false;
  if (error instanceof QueueFullError) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return false;

  if (error instanceof HttpError) {
    const { status } = error;
    if (status === 408 || status === 429) return true;
    if (status >= 500) return true;
    return false;
  }

  // TypeError from fetch = network failure
  if (error instanceof TypeError) return true;

  return false;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function resolveRetryConfig(
  resilience: { retry?: Partial<RetryConfig> | false } | false | undefined,
): RetryConfig | null {
  if (resilience === false) return null;
  if (!resilience || resilience.retry === undefined) return DEFAULT_RETRY_CONFIG;
  if (resilience.retry === false) return null;
  return { ...DEFAULT_RETRY_CONFIG, ...resilience.retry };
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryableError(err)) throw lastError;

      if (attempt < config.maxAttempts - 1) {
        // Respect Retry-After header for 429 responses
        const delayMs =
          err instanceof HttpError && err.retryAfter != null
            ? err.retryAfter * 1000
            : calculateBackoff(attempt, config);

        await sleep(delayMs, signal);
      }
    }
  }

  throw new RetryExhaustedError(
    'operation',
    config.maxAttempts,
    lastError!,
  );
}
