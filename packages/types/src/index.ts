export type { ChatDomain, DefaultDomain } from './domain';
export type { Participant } from './participant';
export type {
  MessageAttributes,
  Message,
  SendMessageRequest,
  SendMessageResponse,
  SystemMessageRequest,
  MessageHistoryQuery,
  MessageHistoryResponse,
} from './message';
export type { JoinRequest, JoinResponse } from './channel';
export type { SSEMessageEvent, SSEResyncEvent, SSEEvent } from './sse';
export type { ChatBucket, ChatManifest } from './manifest';
export type {
  AuthValidatorContext,
  AuthValidatorResult,
  AuthValidator,
  AuthConfig,
} from './auth';

export type {
  PediChat,
  PediRole,
  PediVehicle,
  PediLocation,
  PediParticipantMeta,
  PediMessageType,
  PediMessageAttributes,
} from './domains';

export type {
  UnreadCountResponse,
  MarkReadRequest,
  SSEUnreadSnapshotEvent,
  SSEUnreadUpdateEvent,
  SSEUnreadClearEvent,
  SSEUnreadEvent,
} from './unread';

export { participantSchema } from './participant';
export { joinRequestSchema } from './channel';
export {
  messageAttributesSchema,
  sendMessageRequestSchema,
  systemMessageRequestSchema,
  messageHistoryQuerySchema,
} from './message';
export { markReadRequestSchema } from './unread';
