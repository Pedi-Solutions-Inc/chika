import { z } from 'zod';
import { participantSchema, type Participant } from './participant';
import type { Message } from './message';
import type { ChatDomain, DefaultDomain } from './domain';

export const joinRequestSchema = participantSchema;

export type JoinRequest = z.infer<typeof joinRequestSchema>;

export interface JoinResponse<D extends ChatDomain = DefaultDomain> {
  channel_id: string;
  status: 'active' | 'closed';
  participants: Participant<D>[];
  messages: Message<D>[];
  joined_at: string;
}
