export { useChat } from './use-chat';
export { createChatSession } from './session';
export { resolveServerUrl, createManifest } from './resolve-url';
export { ChatDisconnectedError, ChannelClosedError } from './errors';

export type { ChatConfig, ChatStatus, UseChatOptions, UseChatReturn } from './types';
export type { ChatSession, SessionCallbacks } from './session';

export type {
  ChatDomain,
  DefaultDomain,
  Message,
  Participant,
  MessageAttributes,
  SendMessageResponse,
  ChatManifest,
  ChatBucket,
  PediChat,
  PediRole,
  PediVehicle,
  PediLocation,
  PediParticipantMeta,
  PediMessageType,
  PediMessageAttributes,
} from '@pedi/chika-types';
