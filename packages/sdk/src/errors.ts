import type { ChatStatus } from './types';

export class ChatDisconnectedError extends Error {
  constructor(public readonly status: ChatStatus) {
    super(`Cannot send message while ${status}`);
    this.name = 'ChatDisconnectedError';
  }
}

export class ChannelClosedError extends Error {
  constructor(public readonly channelId: string) {
    super(`Channel ${channelId} is closed`);
    this.name = 'ChannelClosedError';
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfter?: number,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'HttpError';
  }
}

export class RetryExhaustedError extends Error {
  constructor(
    public readonly operation: string,
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(`${operation} failed after ${attempts} attempts: ${lastError.message}`);
    this.name = 'RetryExhaustedError';
  }
}

export class QueueFullError extends Error {
  constructor(public readonly maxSize: number) {
    super(`Message queue full (max ${maxSize})`);
    this.name = 'QueueFullError';
  }
}

export class SendTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Send timed out after ${timeoutMs}ms`);
    this.name = 'SendTimeoutError';
  }
}
