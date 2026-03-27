import type { Message } from './message';
import type { ChatDomain, DefaultDomain } from './domain';

export interface SSEMessageEvent<D extends ChatDomain = DefaultDomain> {
  id: string;
  event: 'message';
  data: Message<D>;
}

export interface SSEResyncEvent {
  event: 'resync';
  data: { reason: string; missed_count: number };
}

export type SSEEvent<D extends ChatDomain = DefaultDomain> = SSEMessageEvent<D> | SSEResyncEvent;
