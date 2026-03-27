import type {
  ChatDomain,
  DefaultDomain,
  Message,
  Participant,
  MessageAttributes,
  SendMessageResponse,
  ChatManifest,
} from '@pedi/chika-types';

export type ChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed' | 'error';

/**
 * Configuration for the chat SDK.
 *
 * @property manifest - Bucket routing manifest for server URL resolution.
 * @property headers - Custom headers applied to all HTTP and SSE requests (e.g., auth tokens).
 * @property reconnectDelayMs - Delay before SSE reconnection attempt. Default: 3000ms.
 * @property backgroundGraceMs - Grace period before teardown on app background. Default: 2000ms on Android, 0ms on iOS.
 */
/**
 * Configuration for the chat SDK.
 *
 * @property manifest - Bucket routing manifest for server URL resolution.
 * @property headers - Custom headers applied to all HTTP and SSE requests (e.g., auth tokens).
 * @property reconnectDelayMs - Delay before SSE reconnection attempt. Default: 3000ms.
 * @property backgroundGraceMs - Grace period before teardown on app background. Default: 2000ms on Android, 0ms on iOS.
 * @property optimisticSend - Append messages to the local array immediately on send. Default: true.
 */
export interface ChatConfig {
  manifest: ChatManifest;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  backgroundGraceMs?: number;
  optimisticSend?: boolean;
}

export interface UseChatOptions<D extends ChatDomain = DefaultDomain> {
  config: ChatConfig;
  channelId: string;
  profile: Participant<D>;
  onMessage?: (message: Message<D>) => void;
}

export interface UseChatReturn<D extends ChatDomain = DefaultDomain> {
  messages: Message<D>[];
  participants: Participant<D>[];
  status: ChatStatus;
  error: Error | null;
  sendMessage: (type: D['messageType'], body: string, attributes?: MessageAttributes<D>) => Promise<SendMessageResponse>;
  disconnect: () => void;
}
