export { useChat } from './use-chat';
export { useUnread } from './use-unread';
export { createChatSession } from './session';
export { resolveServerUrl, createManifest } from './resolve-url';
export { createSSEConnection } from './sse-connection';
export { ChatDisconnectedError, ChannelClosedError } from './errors';

export type { ChatConfig, ChatStatus, UseChatOptions, UseChatReturn } from './types';
export type { ChatSession, SessionCallbacks } from './session';
export type { UseUnreadOptions, UseUnreadReturn } from './use-unread';
export type { SSEConnection, SSEConnectionConfig, SSEConnectionCallbacks } from './sse-connection';

export type {
  ChatDomain,
  DefaultDomain,
  Message,
  Participant,
  MessageAttributes,
  SendMessageResponse,
  ChatManifest,
  ChatBucket,
  UnreadCountResponse,
  MarkReadRequest,
  SSEUnreadUpdateEvent,
  SSEUnreadClearEvent,
  SSEUnreadEvent,
  PediChat,
  PediRole,
  PediVehicle,
  PediLocation,
  PediParticipantMeta,
  PediMessageType,
  PediMessageAttributes,
} from '@pedi/chika-types';
