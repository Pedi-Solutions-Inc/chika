import type { Context } from 'hono';
import { ObjectId } from 'mongodb';
import type { Message, Participant } from '@pedi/chika-types';
import type { MessageDocument, ChannelDocument } from '../db';
import type { PluginRequestInfo, InterceptResult } from './types';
import { getInterceptors, getAfterSenders, getPlugins } from './loader';
import { captureException } from '../sentry';
import { createComponentLogger } from '../logger';

const log = createComponentLogger('plugins');

const DEFAULT_INTERCEPT_TIMEOUT = 5_000;
const DEFAULT_AFTER_SEND_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Request info builder
// ---------------------------------------------------------------------------

/** Build a lightweight request snapshot from the Hono context. */
export function buildRequestInfo(c: Context): PluginRequestInfo {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    headers,
    authorization: c.req.header('authorization'),
    apiKey: c.req.header('x-api-key'),
    ip:
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip'),
  };
}

// ---------------------------------------------------------------------------
// Interceptors (sequential, before storage)
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Plugin "${label}" timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Run all interceptors sequentially in priority order.
 * Returns the (possibly modified) message, or a blocked result.
 */
export async function runInterceptors(
  message: MessageDocument,
  channel: ChannelDocument,
  request: PluginRequestInfo,
  source: 'client' | 'system',
): Promise<{ message: MessageDocument } | { blocked: true; reason: string }> {
  const interceptors = getInterceptors();
  if (interceptors.length === 0) return { message };

  let current = message;

  for (const plugin of interceptors) {
    // JSON round-trip + reconstruct proper types for a plugin-safe deep copy.
    // structuredClone cannot handle MongoDB ObjectId class instances.
    const raw = JSON.parse(JSON.stringify(current));
    const isolated: MessageDocument = {
      ...raw,
      _id: new ObjectId(raw._id),
      created_at: new Date(raw.created_at),
    };
    const timeout = plugin.interceptTimeout ?? DEFAULT_INTERCEPT_TIMEOUT;

    try {
      const resultOrPromise = plugin.intercept!({ message: isolated, channel, request, source });
      const result: InterceptResult =
        resultOrPromise instanceof Promise
          ? await withTimeout(resultOrPromise, timeout, plugin.name)
          : resultOrPromise;

      if (result.action !== 'allow' && result.action !== 'block') {
        log.warn('plugin returned unexpected action', { plugin: plugin.name, action: String(result.action) });
      }

      if (result.action === 'block') {
        log.info('message blocked by plugin', { plugin: plugin.name, reason: result.reason ?? 'no reason' });
        return { blocked: true, reason: result.reason ?? 'Message rejected' };
      }

      if (result.message) {
        current = result.message;
      }
    } catch (err) {
      log.error('interceptor threw', { plugin: plugin.name, error: err as Error });
      captureException(err);

      if (plugin.critical) {
        return { blocked: true, reason: 'Service temporarily unavailable' };
      }
      // Non-critical: fail-open, continue with current message.
    }
  }

  return { message: current };
}

// ---------------------------------------------------------------------------
// AfterSend (parallel, fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Run all afterSend hooks in parallel. Fire-and-forget — not awaited by caller.
 * Errors are logged but never propagate.
 */
export function runAfterSend(
  message: Message,
  channelId: string,
  participants: (Participant & { joined_at: string })[],
  request: PluginRequestInfo,
  source: 'client' | 'system',
): void {
  const senders = getAfterSenders();
  if (senders.length === 0) return;

  void Promise.allSettled(
    senders.map(async (plugin) => {
      const timeout = plugin.afterSendTimeout ?? DEFAULT_AFTER_SEND_TIMEOUT;
      try {
        const resultOrPromise = plugin.afterSend!({ message, channelId, participants, request, source });
        if (resultOrPromise instanceof Promise) {
          await withTimeout(resultOrPromise, timeout, plugin.name);
        }
      } catch (err) {
        log.error('afterSend threw', { plugin: plugin.name, error: err as Error });
        captureException(err);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Call destroy on all plugins (during server shutdown). */
export async function destroyPlugins(): Promise<void> {
  await Promise.allSettled(
    getPlugins().map(async (plugin) => {
      if (!plugin.destroy) return;
      try {
        await plugin.destroy();
      } catch (err) {
        log.error('destroy threw', { plugin: plugin.name, error: err as Error });
      }
    }),
  );
}
