export { useChat } from './use-chat';
export { useUnread } from './use-unread';
export { createChatSession } from './session';
export { resolveServerUrl, createManifest } from './resolve-url';
export { createSSEConnection } from './sse-connection';
export { ChatDisconnectedError, ChannelClosedError, HttpError, RetryExhaustedError, QueueFullError } from './errors';
export { withRetry, isRetryableError, calculateBackoff, resolveRetryConfig } from './retry';
export { createNetworkMonitor } from './network-monitor';
export { createQueueStorage, createAsyncStorageAdapter } from './message-queue';

export type { ChatConfig, ChatStatus, UseChatOptions, UseChatReturn, ResilienceConfig } from './types';
export type { ChatSession, SessionCallbacks } from './session';
export type { UseUnreadOptions, UseUnreadReturn } from './use-unread';
export type { SSEConnection, SSEConnectionConfig, SSEConnectionCallbacks } from './sse-connection';
export type { RetryConfig } from './retry';
export type { NetworkMonitor } from './network-monitor';
export type { MessageSendStatus, QueuedMessage, QueueStorage } from './message-queue';

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
