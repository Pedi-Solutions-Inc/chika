# Plugins

The plugin system lets you hook into the message lifecycle without modifying server source code. Plugins are loaded from `server/plugins/` at startup and run on every message sent through the server.

## Quick Start

1. Copy the example template:

```bash
cp server/plugins/_example.ts server/plugins/my-plugin.ts
```

2. Edit `server/plugins/my-plugin.ts`:

```typescript
import { definePlugin } from '../src/plugins';

export default definePlugin({
  name: 'my-plugin',
  async afterSend({ message, channelId, participants, request }) {
    await fetch('https://api.example.com/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': request.authorization!,
      },
      body: JSON.stringify({ message, channelId, participants }),
    });
  },
});
```

3. Restart the server. The plugin is loaded automatically.

## How It Works

Plugins have two hook points in the message-send pipeline:

```
Client/Internal POST → Validation → [Interceptors] → DB Insert → SSE Broadcast → [AfterSend] → Response
                                      ↑ sequential      ↑ already sent              ↑ parallel
                                      can block/modify   point of no return          fire-and-forget
```

### Interceptors (Before Send)

Interceptors run **sequentially** in priority order before the message is stored. They can:

- **Allow** the message through unchanged
- **Modify** the message (transform body, add attributes)
- **Block** the message entirely (returns 403 to the caller)

```typescript
export default definePlugin({
  name: 'content-filter',
  priority: 10, // Runs early

  intercept({ message, channel, request, source }) {
    if (source === 'system') return { action: 'allow' };

    if (containsProfanity(message.body)) {
      return { action: 'block', reason: 'Message contains inappropriate content' };
    }

    return { action: 'allow' };
  },
});
```

To modify a message, return the modified document in the result:

```typescript
intercept({ message }) {
  return {
    action: 'allow',
    message: {
      ...message,
      attributes: { ...message.attributes, scanned: true },
    },
  };
},
```

### AfterSend (Post Send)

AfterSend hooks run **in parallel** after the message is stored and broadcast. They are fire-and-forget — errors are logged but never affect the HTTP response.

```typescript
export default definePlugin({
  name: 'fcm-forwarder',

  async afterSend({ message, channelId, participants, request }) {
    await fetch(`${process.env.MAIN_API_URL}/chat/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': request.authorization!,
      },
      body: JSON.stringify({ message, channelId, participants }),
    });
  },
});
```

## Plugin Interface

```typescript
interface ChikaPlugin {
  name: string;               // Unique name for logging
  priority?: number;          // Execution order for interceptors (lower = first). Default: 100
  critical?: boolean;         // Fail-closed on interceptor errors. Default: false
  interceptTimeout?: number;  // Interceptor timeout in ms. Default: 5000
  afterSendTimeout?: number;  // AfterSend timeout in ms. Default: 30000

  init?(): Promise<void> | void;
  destroy?(): Promise<void> | void;
  intercept?(ctx: InterceptContext): Promise<InterceptResult> | InterceptResult;
  afterSend?(ctx: AfterSendContext): Promise<void> | void;
}
```

### InterceptContext

Passed to `intercept()`. Contains the message before it's stored.

| Field | Type | Description |
|-------|------|-------------|
| `message` | `MessageDocument` | Shallow copy of the message document. Safe to read. |
| `channel` | `ChannelDocument` | The channel (readonly reference). Includes participants. |
| `request` | `PluginRequestInfo` | HTTP request snapshot (headers, auth token, IP). |
| `source` | `'client' \| 'system'` | Whether the message came from a client or internal API. |

### AfterSendContext

Passed to `afterSend()`. Contains the finalized message after broadcast.

| Field | Type | Description |
|-------|------|-------------|
| `message` | `Message` | The finalized message as broadcast to SSE subscribers. |
| `channelId` | `string` | The channel ID. |
| `participants` | `Participant[]` | Snapshot of the channel's participant list. |
| `request` | `PluginRequestInfo` | HTTP request snapshot (headers, auth token, IP). |
| `source` | `'client' \| 'system'` | Whether the message came from a client or internal API. |

### PluginRequestInfo

A lightweight snapshot of the HTTP request, decoupled from the web framework. Plugins receive the full set of request headers, including `Authorization` tokens and cookies. This is by design — the primary use case is forwarding credentials to external APIs. Since plugins are first-party code loaded from local files, this is an acceptable trust boundary for a self-hosted system.

| Field | Type | Description |
|-------|------|-------------|
| `headers` | `Record<string, string>` | All request headers (lowercased keys). |
| `authorization` | `string \| undefined` | The `Authorization` header value. |
| `apiKey` | `string \| undefined` | The `X-Api-Key` header value (internal routes). |
| `ip` | `string \| undefined` | Client IP from `X-Forwarded-For` or `X-Real-IP`. |

### InterceptResult

Returned by `intercept()`.

| Field | Type | Description |
|-------|------|-------------|
| `action` | `'allow' \| 'block'` | Whether to allow or reject the message. |
| `reason` | `string?` | When blocked, the reason returned in the 403 response. |
| `message` | `MessageDocument?` | Optional modified message for subsequent interceptors and storage. |

## Lifecycle

### Startup

1. Server scans `server/plugins/` for `.ts` and `.js` files
2. Files prefixed with `_` are skipped (reserved for templates)
3. Each file is dynamically imported; must default-export a `ChikaPlugin`
4. `init()` is called on each plugin — throw to prevent loading (other plugins continue)
5. Plugins are sorted by `priority` (lower first)
6. Interceptor and afterSend lists are pre-computed for zero per-request overhead

### Per Message

1. `buildRequestInfo()` snapshots the HTTP headers into a plain object
2. **Interceptors** run sequentially. Each receives a shallow copy of the message. If any returns `{ action: 'block' }`, the message is rejected with 403.
3. Message is stored in MongoDB and broadcast via SSE
4. **AfterSend** hooks run in parallel, fire-and-forget

### Shutdown

`destroy()` is called on all plugins (via `Promise.allSettled`). Errors are logged but don't prevent shutdown.

## Priority

Priority controls interceptor execution order. Lower values run first.

| Range | Suggested Use |
|-------|---------------|
| 1–20 | Content filters, rate limiters |
| 21–50 | Message transformers |
| 51–100 | Logging, analytics tagging |
| 100+ | Default — general purpose |

AfterSend hooks are not affected by priority — they all run in parallel.

## Error Handling

### Non-Critical Plugins (default)

| Scenario | Behavior |
|----------|----------|
| Interceptor throws | Message **allowed** through (fail-open) |
| Interceptor times out | Same as throw |
| AfterSend throws | Logged, no effect on response |
| AfterSend times out | Logged |

### Critical Plugins (`critical: true`)

| Scenario | Behavior |
|----------|----------|
| Interceptor throws | Message **rejected** with 503 (fail-closed) |
| Interceptor times out | Same as throw |

Use `critical: true` for safety-critical plugins like content filters where a failure should not allow unfiltered content through.

```typescript
export default definePlugin({
  name: 'content-filter',
  priority: 10,
  critical: true,
  interceptTimeout: 3000,

  async intercept({ message }) {
    const result = await callFilterService(message.body);
    if (!result.safe) {
      return { action: 'block', reason: 'Content policy violation' };
    }
    return { action: 'allow' };
  },
});
```

## File Structure

```
server/
  src/plugins/              ← Framework (committed to git)
    types.ts                  Interfaces, definePlugin()
    loader.ts                 Plugin discovery and loading
    runner.ts                 Interceptor and afterSend execution
    index.ts                  Re-exports
  plugins/                  ← Implementations (gitignored)
    _example.ts               Template (committed, skipped by loader)
    my-plugin.ts              Your plugins go here
```

Plugin implementation files are **gitignored** — they won't cause merge conflicts when pulling updates. Only the framework in `src/plugins/` is committed.

## Docker

Mount your plugins directory as a volume:

```yaml
volumes:
  - ./my-plugins:/app/server/plugins
```

## Examples

### Forward Messages to Main API

```typescript
import { definePlugin } from '../src/plugins';

const API_URL = process.env.MAIN_API_URL!;

export default definePlugin({
  name: 'api-forwarder',

  init() {
    if (!API_URL) throw new Error('MAIN_API_URL is required');
  },

  async afterSend({ message, channelId, participants, request }) {
    await fetch(`${API_URL}/chat/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': request.authorization!,
      },
      body: JSON.stringify({ message, channelId, participants }),
    });
  },
});
```

### Block Messages by Pattern

```typescript
import { definePlugin } from '../src/plugins';

const BLOCKED_PATTERNS = [/spam-link\.com/i, /buy-now\.xyz/i];

export default definePlugin({
  name: 'spam-filter',
  priority: 10,
  critical: true,

  intercept({ message, source }) {
    if (source === 'system') return { action: 'allow' };

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(message.body)) {
        return { action: 'block', reason: 'Message flagged as spam' };
      }
    }

    return { action: 'allow' };
  },
});
```

### Tag Messages with Metadata

```typescript
import { definePlugin } from '../src/plugins';

export default definePlugin({
  name: 'url-detector',
  priority: 50,

  intercept({ message }) {
    const urls = message.body.match(/https?:\/\/[^\s]+/g);
    if (urls) {
      return {
        action: 'allow',
        message: {
          ...message,
          attributes: { ...message.attributes, detected_urls: urls },
        },
      };
    }
    return { action: 'allow' };
  },
});
```
