/**
 * Example auth configuration for chika-server.
 *
 * Copy this file to `auth.config.ts` (gitignored) and customise
 * the `validate` function with your own token-verification logic.
 *
 * When `auth.config.ts` exists the server will require valid
 * authorisation on all `/channels/*` endpoints.  When it is absent
 * the endpoints are open (current default behaviour).
 *
 * The SDK already supports custom headers:
 *
 *   useChat({
 *     manifest,
 *     headers: { Authorization: 'Driver <token>' },
 *   });
 */
import type { AuthConfig } from '@pedi/chika-types';

export default {
  validate: async ({ headers, channelId }) => {
    const auth = headers['authorization'];
    if (!auth) return { valid: false };

    // Example: parse "Driver <token>" or "Rider <token>"
    // const [role, token] = auth.split(' ');

    // Call your own API to validate the token:
    // const res = await fetch('https://api.example.com/verify-token', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${process.env.MY_API_SECRET}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({ token, channel_id: channelId }),
    // });
    //
    // if (!res.ok) return { valid: false };
    //
    // const data = await res.json();
    // return { valid: true, userId: data.user_id };

    return { valid: false };
  },

  // Cache valid tokens for 5 minutes (default).
  cacheTtl: 300_000,

  // Cache invalid tokens for 2 seconds to avoid hammering your API.
  invalidCacheTtl: 2_000,

  // Optional: customise the cache key (defaults to the Authorization header).
  // cacheKey: ({ headers }) => headers['authorization'] ?? null,
} satisfies AuthConfig;
