import { z } from 'zod';
import type { ChatDomain, DefaultDomain } from './domain';

export const participantSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  name: z.string().min(1),
  profile_image: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export interface Participant<D extends ChatDomain = DefaultDomain> {
  id: string;
  role: D['role'];
  name: string;
  profile_image?: string;
  metadata?: D['metadata'];
}
