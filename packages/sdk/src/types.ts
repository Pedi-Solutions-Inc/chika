import type {
  ChatDomain,
  DefaultDomain,
  Message,
  Participant,
  MessageAttributes,
  SendMessageResponse,
  ChatManifest,
} from '@pedi/chika-types';
import type { RetryConfig } from './retry';
import type { NetworkMonitor } from './network-monitor';
import type { QueueStorage, QueuedMessage } from './message-queue';

export type ChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'closed' | 'error';

export type ParticipantProfile<D extends ChatDomain = DefaultDomain> = Pick<
  Participant<D>,
  'name' | 'role' | 'profile_image'
>;

export interface ChatMessage<D extends ChatDomain = DefaultDomain> extends Message<D> {
  as_participant?: ParticipantProfile<D>;
}

export interface ResilienceConfig {
  /** Retry config overrides. Set false to disable retry entirely. */
  retry?: Partial<RetryConfig> | false;
  /** Enable offline message queuing. Default: true. */
  offlineQueue?: boolean;
  /** Max queued messages. Default: 50. */
  maxQueueSize?: number;
  /** Inject custom NetworkMonitor (bypasses built-in NetInfo detection). */
  networkMonitor?: NetworkMonitor;
  /** Persistent storage adapter for queue (AsyncStorage/MMKV/etc). */
  queueStorage?: QueueStorage;
}

/**
 * Configuration for the chat SDK.
 *
 * @property manifest - Bucket routing manifest for server URL resolution.
 * @property headers - Custom headers applied to all HTTP and SSE requests (e.g., auth tokens).
 * @property reconnectDelayMs - Base delay before SSE reconnection attempt. Default: 3000ms.
 * @property backgroundGraceMs - Grace period before teardown on app background. Default: 2000ms on Android, 0ms on iOS.
 * @property optimisticSend - Append messages to the local array immediately on send. Default: true.
 * @property resilience - Network resilience options. Enabled by default. Set false to disable all.
 */
export interface ChatConfig {
  manifest: ChatManifest;
  headers?: Record<string, string>;
  reconnectDelayMs?: number;
  backgroundGraceMs?: number;
  optimisticSend?: boolean;
  resilience?: ResilienceConfig | false;
}

export interface UseChatOptions<D extends ChatDomain = DefaultDomain> {
  config: ChatConfig;
  channelId: string;
  profile: Participant<D>;
  onMessage?: (message: ChatMessage<D>) => void;
  resolveSystemProfile?: (message: Message<D>, participants: Participant<D>[]) => ParticipantProfile<D> | undefined;
}

export interface UseChatReturn<D extends ChatDomain = DefaultDomain> {
  messages: ChatMessage<D>[];
  participants: Participant<D>[];
  status: ChatStatus;
  error: Error | null;
  sendMessage: (type: D['messageType'], body: string, attributes?: MessageAttributes<D>) => Promise<SendMessageResponse>;
  disconnect: () => void;
  /** Per-message send status for queued/retrying messages. Empty when resilience disabled. */
  pendingMessages: QueuedMessage[];
  /** Cancel a queued or failed message by its optimistic ID. */
  cancelMessage: (optimisticId: string) => void;
  /** Retry a failed message by its optimistic ID. */
  retryMessage: (optimisticId: string) => void;
}
