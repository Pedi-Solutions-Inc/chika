/**
 * Test helpers — shared utilities for creating test apps, making requests,
 * and parsing SSE responses.
 *
 * IMPORTANT: Always import setup.ts before importing any server modules so
 * that environment variables are set before Zod validation runs in env.ts.
 */

import './setup';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { channels as channelsRouter } from '../src/routes/channels';
import { internal as internalRouter } from '../src/routes/internal';
import { requestLogger } from '../src/middleware/request-logger';
import type { Participant } from '@pedi/chika-types';

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh Hono app wired identically to the real server, but WITHOUT
 * the startup side-effects (no connectDb, no initSentry, no loadPlugins, etc.).
 * The caller is responsible for having called connectDb() before using this app.
 */
export function createTestApp(): Hono {
  const app = new Hono();

  app.use('*', requestLogger);
  app.use('*', cors());
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }));

  app.onError((err, c) => {
    console.error('test app unhandled error', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Auth middleware skipped in tests — auth.config.ts exists in server/ and
  // would reject all requests without valid tokens.  Auth is tested separately
  // in middleware.test.ts.

  app.route('/channels', channelsRouter);
  app.route('/internal/channels', internalRouter);

  return app;
}

// ---------------------------------------------------------------------------
// Common request helpers
// ---------------------------------------------------------------------------

export const TEST_API_KEY = 'test-api-key-12345678';

export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Api-Key': TEST_API_KEY, 'Content-Type': 'application/json', ...extra };
}

export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', ...extra };
}

// ---------------------------------------------------------------------------
// Channel / participant helpers
// ---------------------------------------------------------------------------

export interface TestParticipant extends Participant {
  id: string;
  role: string;
  name: string;
}

export function makeParticipant(overrides: Partial<TestParticipant> = {}): TestParticipant {
  return {
    id: `user-${Math.random().toString(36).slice(2, 10)}`,
    role: 'rider',
    name: 'Test User',
    ...overrides,
  };
}

/**
 * Join a participant to a channel via POST /channels/:channelId/join.
 * Returns the parsed JSON response body.
 */
export async function joinChannel(
  app: Hono,
  channelId: string,
  participant: TestParticipant,
): Promise<Response> {
  return app.request(`/channels/${channelId}/join`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(participant),
  });
}

/**
 * Send a message to a channel via POST /channels/:channelId/messages.
 */
export async function sendMessage(
  app: Hono,
  channelId: string,
  payload: {
    sender_id: string;
    type?: string;
    body?: string;
    attributes?: Record<string, unknown>;
    idempotency_key?: string;
  },
): Promise<Response> {
  const { sender_id, type = 'text', body = 'Hello world', attributes, idempotency_key } = payload;
  return app.request(`/channels/${channelId}/messages`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ sender_id, type, body, attributes, idempotency_key }),
  });
}

/**
 * Create a channel with a default participant already joined.
 * Returns { channelId, participant, joinResponse }.
 */
export async function createTestChannel(
  app: Hono,
  channelId?: string,
  participantOverrides: Partial<TestParticipant> = {},
): Promise<{ channelId: string; participant: TestParticipant; joinData: Record<string, unknown> }> {
  const id = channelId ?? `channel-${Math.random().toString(36).slice(2, 10)}`;
  const participant = makeParticipant(participantOverrides);
  const res = await joinChannel(app, id, participant);
  const joinData = (await res.json()) as Record<string, unknown>;
  return { channelId: id, participant, joinData };
}

/**
 * Send a system message via the internal API.
 */
export async function sendSystemMessage(
  app: Hono,
  channelId: string,
  payload: { type?: string; body?: string; attributes?: Record<string, unknown> },
): Promise<Response> {
  const { type = 'system_notification', body = 'System message', attributes } = payload;
  return app.request(`/internal/channels/${channelId}/messages`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ type, body, attributes }),
  });
}

/**
 * Mark a message as read for a participant.
 */
export async function markRead(
  app: Hono,
  channelId: string,
  participant_id: string,
  message_id: string,
): Promise<Response> {
  return app.request(`/channels/${channelId}/read`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ participant_id, message_id }),
  });
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

export interface ParsedSSEEvent {
  event?: string;
  data?: string;
  id?: string;
}

/**
 * Parse raw SSE text into structured events.
 * Each event block is separated by a blank line.
 */
export function parseSSEText(text: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = [];
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const event: ParsedSSEEvent = {};
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event.event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        event.data = line.slice('data:'.length).trim();
      } else if (line.startsWith('id:')) {
        event.id = line.slice('id:'.length).trim();
      }
    }
    if (Object.keys(event).length > 0) {
      events.push(event);
    }
  }

  return events;
}

/**
 * Read SSE events from an open Response stream until the stream closes or
 * `maxEvents` have been collected.  Aborts the request after collecting.
 *
 * @param res        - The streaming Response object from app.request()
 * @param maxEvents  - Stop after this many events (default 10)
 * @param timeoutMs  - Abort after this many ms (default 2000)
 */
export async function readSSEEvents(
  res: Response,
  maxEvents = 10,
  timeoutMs = 2000,
): Promise<ParsedSSEEvent[]> {
  if (!res.body) return [];

  const events: ParsedSSEEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const timer = setTimeout(() => reader.cancel(), timeoutMs);

  try {
    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Extract complete SSE blocks (terminated by \n\n)
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const block of parts) {
        if (block.trim().length === 0) continue;
        const event: ParsedSSEEvent = {};
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            event.event = line.slice('event:'.length).trim();
          } else if (line.startsWith('data:')) {
            event.data = line.slice('data:'.length).trim();
          } else if (line.startsWith('id:')) {
            event.id = line.slice('id:'.length).trim();
          }
        }
        if (Object.keys(event).length > 0) {
          events.push(event);
          if (events.length >= maxEvents) break;
        }
      }
    }
  } catch {
    // Stream aborted or cancelled — that's expected
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch { /* ignore */ }
  }

  return events;
}

/**
 * Open an SSE stream and collect up to `maxEvents` events, then abort.
 * Returns the events collected.
 */
export async function collectSSEEvents(
  app: Hono,
  url: string,
  headers: Record<string, string> = {},
  maxEvents = 5,
  timeoutMs = 2000,
): Promise<ParsedSSEEvent[]> {
  const res = await app.request(url, { headers });
  return readSSEEvents(res, maxEvents, timeoutMs);
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
