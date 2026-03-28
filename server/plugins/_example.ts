/**
 * Example Chika Plugin
 *
 * Copy this file and remove the `_` prefix to create your own plugin.
 * Files prefixed with `_` are skipped by the plugin loader.
 *
 * Each plugin file must default-export a ChikaPlugin object.
 * Use `definePlugin()` for full autocomplete in your editor.
 */
import { definePlugin } from '../src/plugins';

export default definePlugin({
  name: 'example',
  priority: 100,           // Lower runs first. Content filters: ~10, transforms: ~50.
  critical: false,         // If true, interceptor errors reject the message (fail-closed).
  interceptTimeout: 5000,  // Interceptor timeout in ms.
  afterSendTimeout: 30000, // AfterSend timeout in ms.

  init() {
    // Called once at startup. Throw to prevent this plugin from loading.
    // e.g. validate env vars, warm caches, open connections.
  },

  destroy() {
    // Called on server shutdown. Close connections, flush buffers, etc.
  },

  intercept({ message, channel, request, source }) {
    // Before-send interceptor. Runs sequentially in priority order.
    // Return { action: 'allow' } to pass through.
    // Return { action: 'allow', message: { ...message, body: 'modified' } } to transform.
    // Return { action: 'block', reason: 'why' } to reject the message.

    return { action: 'allow' };
  },

  async afterSend({ message, channelId, participants, request, source }) {
    // After-send hook. Runs in parallel, fire-and-forget.
    // The message is already stored and broadcast at this point.
    // Errors are logged but never affect the response.
    //
    // Common use: forward to external API using the client's auth token.
    // await fetch('https://api.example.com/chat/events', {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Authorization': request.authorization!,
    //   },
    //   body: JSON.stringify({ message, channelId, participants }),
    // });
  },
});
