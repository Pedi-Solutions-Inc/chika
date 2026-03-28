import { resolve, join } from 'path';
import type { ChikaPlugin } from './types';

const PLUGINS_DIR = resolve(import.meta.dir, '../../plugins');

/** Loaded plugins, pre-sorted by priority. */
let allPlugins: ChikaPlugin[] = [];
/** Pre-computed: only plugins with an `intercept` hook, sorted by priority. */
let interceptors: ChikaPlugin[] = [];
/** Pre-computed: only plugins with an `afterSend` hook. */
let afterSenders: ChikaPlugin[] = [];

export function getPlugins(): ChikaPlugin[] {
  return allPlugins;
}

export function getInterceptors(): ChikaPlugin[] {
  return interceptors;
}

export function getAfterSenders(): ChikaPlugin[] {
  return afterSenders;
}

/**
 * Discovers and loads all .ts/.js files in server/plugins/.
 * Files prefixed with `_` are skipped (reserved for templates).
 * Each file must default-export a ChikaPlugin object.
 */
export async function loadPlugins(): Promise<void> {
  const glob = new Bun.Glob('*.{ts,js}');

  let entries: string[];
  try {
    entries = [...glob.scanSync(PLUGINS_DIR)];
  } catch {
    console.log('[chika-plugins] No plugins/ directory found — running without plugins');
    return;
  }

  // Filter out _ prefixed files (templates/examples).
  entries = entries.filter((e) => !e.startsWith('_')).sort();

  if (entries.length === 0) {
    console.log('[chika-plugins] plugins/ directory is empty — running without plugins');
    return;
  }

  const loaded: ChikaPlugin[] = [];

  for (const entry of entries) {
    const fullPath = join(PLUGINS_DIR, entry);
    try {
      const mod = await import(fullPath);
      const plugin: ChikaPlugin = mod.default ?? mod;

      if (!plugin.name || typeof plugin.name !== 'string') {
        console.warn(`[chika-plugins] Skipping ${entry}: missing 'name' property`);
        continue;
      }

      if (loaded.some((p) => p.name === plugin.name)) {
        console.warn(`[chika-plugins] Skipping ${entry}: duplicate name "${plugin.name}"`);
        continue;
      }

      if (plugin.init) {
        await plugin.init();
      }

      loaded.push(plugin);
      console.log(`[chika-plugins] Loaded: ${plugin.name} (priority: ${plugin.priority ?? 100})`);
    } catch (err) {
      console.error(`[chika-plugins] Failed to load ${entry}:`, err);
    }
  }

  // Sort by priority (lower first).
  allPlugins = loaded.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  // Pre-compute filtered arrays so we don't filter on every request.
  interceptors = allPlugins.filter((p) => p.intercept);
  afterSenders = allPlugins.filter((p) => p.afterSend);

  console.log(`[chika-plugins] ${allPlugins.length} plugin(s) active`);
}
