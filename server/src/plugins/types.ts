import type { Message, Participant } from '@pedi/chika-types';
import type { MessageDocument, ChannelDocument } from '../db';

// ---------------------------------------------------------------------------
// Request info
// ---------------------------------------------------------------------------

/** Lightweight snapshot of the incoming HTTP request — decoupled from Hono. */
export interface PluginRequestInfo {
  /** All request headers (lowercased keys). */
  headers: Record<string, string>;
  /** The Authorization header value, if present. */
  authorization: string | undefined;
  /** The X-Api-Key header value, if present (internal routes). */
  apiKey: string | undefined;
  /** Client IP (from X-Forwarded-For / X-Real-IP). */
  ip: string | undefined;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** Context passed to before-send interceptors. */
export interface InterceptContext {
  /** Shallow-copied message document — safe to read. Return modified via result. */
  message: MessageDocument;
  /** The channel document (readonly reference). */
  channel: ChannelDocument;
  /** Snapshot of the HTTP request (headers, auth token, IP). */
  request: PluginRequestInfo;
  /** 'client' for user messages, 'system' for internal API messages. */
  source: 'client' | 'system';
}

/** Context passed to after-send hooks. */
export interface AfterSendContext {
  /** The finalized message (as broadcast to SSE). */
  message: Message;
  /** Channel ID. */
  channelId: string;
  /** The channel's participant list snapshot (serialized for API consumption). */
  participants: (Participant & { joined_at: string })[];
  /** Snapshot of the HTTP request (headers, auth token, IP). */
  request: PluginRequestInfo;
  /** 'client' for user messages, 'system' for internal API messages. */
  source: 'client' | 'system';
}

// ---------------------------------------------------------------------------
// Intercept result
// ---------------------------------------------------------------------------

/** Result returned by an interceptor. */
export interface InterceptResult {
  /** 'allow' to continue the pipeline, 'block' to reject the message. */
  action: 'allow' | 'block';
  /** When blocked, the reason returned to the caller. */
  reason?: string;
  /** Optional: return a modified message document (for transformations). */
  message?: MessageDocument;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export interface ChikaPlugin {
  /** Unique name for logging and debugging. */
  name: string;
  /** Execution priority. Lower runs first. Default: 100. */
  priority?: number;
  /** If true, interceptor errors reject the message (fail-closed). Default: false. */
  critical?: boolean;
  /** Interceptor timeout in ms. Default: 5000. */
  interceptTimeout?: number;
  /** AfterSend timeout in ms. Default: 30000. */
  afterSendTimeout?: number;

  /** Called once at startup. Throw to skip this plugin. */
  init?: () => Promise<void> | void;
  /** Before-send interceptor. Sequential, priority-ordered. */
  intercept?: (ctx: InterceptContext) => Promise<InterceptResult> | InterceptResult;
  /** After-send hook. Parallel, fire-and-forget. */
  afterSend?: (ctx: AfterSendContext) => Promise<void> | void;
  /** Called on server shutdown. */
  destroy?: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Identity helper for full autocomplete when defining plugins. */
export function definePlugin(plugin: ChikaPlugin): ChikaPlugin {
  return plugin;
}
