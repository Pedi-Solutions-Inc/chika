import { z } from 'zod';
import type { ChatDomain, DefaultDomain } from './domain';
import type { Participant } from './participant';

export const messageAttributesSchema = z
  .object({})
  .catchall(z.unknown());

export type MessageAttributes<D extends ChatDomain = DefaultDomain> = D['attributes'];

export interface Message<D extends ChatDomain = DefaultDomain> {
  id: string;
  channel_id: string;
  sender_id: string | null;
  sender_role: D['role'] | 'system';
  type: D['messageType'];
  body: string;
  attributes: MessageAttributes<D>;
  created_at: string;
}

export const sendMessageRequestSchema = z.object({
  sender_id: z.string().min(1),
  type: z.string().min(1),
  body: z.string().min(1).max(10_000),
  attributes: messageAttributesSchema.optional(),
});

export interface SendMessageRequest<D extends ChatDomain = DefaultDomain> {
  sender_id: string;
  type: D['messageType'];
  body: string;
  attributes?: MessageAttributes<D>;
}

export interface SendMessageResponse {
  id: string;
  created_at: string;
}

export const systemMessageRequestSchema = z.object({
  type: z.string().min(1),
  body: z.string().min(1).max(10_000),
  attributes: messageAttributesSchema.optional(),
});

export interface SystemMessageRequest<D extends ChatDomain = DefaultDomain> {
  type: D['messageType'];
  body: string;
  attributes?: MessageAttributes<D>;
}

export const messageHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
});

export interface MessageHistoryQuery {
  limit?: number;
  before?: string;
  after?: string;
}

export interface MessageHistoryResponse<D extends ChatDomain = DefaultDomain> {
  channel_id: string;
  participants: Participant<D>[];
  messages: Message<D>[];
  has_more: boolean;
}
