import type { ChatManifest } from '@pedi/chika-types';

/**
 * Creates a single-server manifest. Use this when all channels route to the same server.
 *
 * @example
 * ```ts
 * const config: ChatConfig = { manifest: createManifest('https://chat.example.com') };
 * ```
 */
export function createManifest(serverUrl: string): ChatManifest {
  return { buckets: [{ group: 'default', range: [0, 99], server_url: serverUrl }] };
}

export function resolveServerUrl(manifest: ChatManifest, channelId: string): string {
  const hash = [...channelId].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 100;
  const bucket = manifest.buckets.find(
    (b) => hash >= b.range[0] && hash <= b.range[1],
  );
  if (!bucket) throw new Error(`No chat bucket for hash ${hash}`);
  return bucket.server_url;
}
