import { z } from 'zod';

export interface UnreadCountResponse {
  channel_id: string;
  unread_count: number;
  last_message_at: string | null;
}

export interface MarkReadRequest {
  participant_id: string;
  message_id: string;
}

export interface SSEUnreadSnapshotEvent {
  event: 'unread_snapshot';
  data: UnreadCountResponse;
}

export interface SSEUnreadUpdateEvent {
  event: 'unread_update';
  data: {
    channel_id: string;
    message_id: string;
    created_at: string;
  };
}

export interface SSEUnreadClearEvent {
  event: 'unread_clear';
  data: { channel_id: string; unread_count: number };
}

export type SSEUnreadEvent =
  | SSEUnreadSnapshotEvent
  | SSEUnreadUpdateEvent
  | SSEUnreadClearEvent;

export const markReadRequestSchema = z.object({
  participant_id: z.string().min(1),
  message_id: z.string().min(1),
});
