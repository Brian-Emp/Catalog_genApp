/**
 * Simple cache for Gemini audits (visualAudit, coherenceAudit).
 *
 * Key: sha256(prompt + image_bytes joined). Avoids re-auditing the same
 * page with the same prompt → saves daily Gemini quota on pipeline re-runs
 * (repeated E2E tests, visual debugging, etc.).
 *
 * Storage: JSON file at `<projectDir>/.gemini-cache/audits.json`.
 * Deliberately primitive (no lock, no TTL): this cache is best-effort.
 * On concurrent write conflict → last-writer-wins (tolerated, it's just
 * a cache).
 */

import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

const CACHE_DIR = '.gemini-cache';
const CACHE_FILE = 'audits.json';
const CACHE_VERSION = 1;
/** Soft TTL: entries older than 30 days are purged on load. */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface CacheEntry {
  /** Write timestamp (epoch ms). */
  t: number;
  /** JSON-serializable value stored in cache. */
  v: unknown;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

let memCache: CacheFile | null = null;
let cachePath: string | null = null;

/**
 * Computes a stable key for an audit: sha256(prompt + image_bytes...).
 * Images are concatenated in the order provided (order matters for the
 * coherence audit, which sees pages in sequence).
 */
export function computeCacheKey(prompt: string, imageBytes: Buffer[] = []): string {
  const h = createHash('sha256');
  h.update(prompt);
  for (const b of imageBytes) h.update(b);
  return h.digest('hex');
}

/**
 * Initializes the cache path (relative to a projectDir). Idempotent.
 * If not called: cache disabled (get/set are no-ops).
 */
export async function initCache(projectDir: string): Promise<void> {
  if (cachePath) return;
  const dir = path.join(projectDir, CACHE_DIR);
  cachePath = path.join(dir, CACHE_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // dir already exists or cannot be created (read-only fs) → cache disabled
    cachePath = null;
    return;
  }
  // Load existing cache (if file present)
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version === CACHE_VERSION && parsed.entries) {
      // Purge soft TTL entries
      const now = Date.now();
      for (const [k, e] of Object.entries(parsed.entries)) {
        if (!e || typeof e.t !== 'number' || now - e.t > MAX_AGE_MS) {
          delete parsed.entries[k];
        }
      }
      memCache = parsed;
    } else {
      memCache = { version: CACHE_VERSION, entries: {} };
    }
  } catch {
    // File missing or corrupted: start from an empty cache
    memCache = { version: CACHE_VERSION, entries: {} };
  }
}

/**
 * Gets the cached value for a key. Returns undefined if absent or cache disabled.
 */
export function cacheGet<T>(key: string): T | undefined {
  if (!memCache) return undefined;
  const e = memCache.entries[key];
  if (!e) return undefined;
  return e.v as T;
}

/**
 * Sets the cached value + asynchronous flush to file. Best-effort.
 */
export async function cacheSet(key: string, value: unknown): Promise<void> {
  if (!memCache || !cachePath) return;
  memCache.entries[key] = { t: Date.now(), v: value };
  // Asynchronous flush, ignore errors (cache is best-effort)
  try {
    await fs.writeFile(cachePath, JSON.stringify(memCache), 'utf8');
  } catch {
    // ignore
  }
}

/** Resets the cache in memory AND on disk. Tests / explicit command. */
export async function clearCache(): Promise<void> {
  memCache = { version: CACHE_VERSION, entries: {} };
  if (cachePath) {
    try { await fs.writeFile(cachePath, JSON.stringify(memCache), 'utf8'); } catch { /* ignore */ }
  }
}

/** Cache stats: entry count + min/max age. Useful for debugging. */
export function cacheStats(): { entries: number; oldestMs: number | null; newestMs: number | null } {
  if (!memCache || Object.keys(memCache.entries).length === 0) {
    return { entries: 0, oldestMs: null, newestMs: null };
  }
  const ts = Object.values(memCache.entries).map((e) => e.t);
  return {
    entries: ts.length,
    oldestMs: Math.min(...ts),
    newestMs: Math.max(...ts),
  };
}

/** Resets the cache path (useful for isolated tests). */
export function resetCacheForTests(): void {
  memCache = null;
  cachePath = null;
}
