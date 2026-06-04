/**
 * Cache simple pour les audits Gemini (visualAudit, coherenceAudit).
 *
 * Clé : sha256(prompt + image_bytes joined). Évite de ré-auditer la même
 * page avec le même prompt → économise quota daily Gemini sur les re-runs
 * de pipeline (tests E2E répétés, debug visuel, etc.).
 *
 * Storage : fichier JSON dans `<projectDir>/.gemini-cache/audits.json`.
 * Volontairement primitif (pas de lock, pas de TTL) : ce cache est best-effort.
 * Sur conflit d'écriture concurrent → last-writer-wins (toléré, c'est juste
 * un cache).
 */

import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

const CACHE_DIR = '.gemini-cache';
const CACHE_FILE = 'audits.json';
const CACHE_VERSION = 1;
/** TTL soft : entries plus vieilles que 30 jours sont purgées au load. */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface CacheEntry {
  /** Timestamp d'ecriture (epoch ms). */
  t: number;
  /** Valeur JSON-serialisable mise en cache. */
  v: unknown;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

let memCache: CacheFile | null = null;
let cachePath: string | null = null;

/**
 * Compute une clé stable pour un audit : sha256(prompt + image_bytes...).
 * Les images sont concatenees dans l'ordre fourni (l'ordre compte pour la
 * coherence audit qui voit les pages en sequence).
 */
export function computeCacheKey(prompt: string, imageBytes: Buffer[] = []): string {
  const h = createHash('sha256');
  h.update(prompt);
  for (const b of imageBytes) h.update(b);
  return h.digest('hex');
}

/**
 * Initialise le chemin du cache (relatif a un projectDir). Idempotent.
 * Si pas appele : cache desactive (get/set sont no-op).
 */
export async function initCache(projectDir: string): Promise<void> {
  if (cachePath) return;
  const dir = path.join(projectDir, CACHE_DIR);
  cachePath = path.join(dir, CACHE_FILE);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // dir existe deja ou impossible a creer (read-only fs) → cache disabled
    cachePath = null;
    return;
  }
  // Load existing cache (si fichier present)
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version === CACHE_VERSION && parsed.entries) {
      // Purge soft TTL
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
    // Fichier absent ou corrompu : on repart d'un cache vide
    memCache = { version: CACHE_VERSION, entries: {} };
  }
}

/**
 * Get cached value pour une cle. Retourne undefined si absent ou cache disabled.
 */
export function cacheGet<T>(key: string): T | undefined {
  if (!memCache) return undefined;
  const e = memCache.entries[key];
  if (!e) return undefined;
  return e.v as T;
}

/**
 * Set cached value + flush asynchrone du fichier. Best-effort.
 */
export async function cacheSet(key: string, value: unknown): Promise<void> {
  if (!memCache || !cachePath) return;
  memCache.entries[key] = { t: Date.now(), v: value };
  // Flush asynchrone, ignore les erreurs (cache best-effort)
  try {
    await fs.writeFile(cachePath, JSON.stringify(memCache), 'utf8');
  } catch {
    // ignore
  }
}

/** Reset le cache en memoire ET sur disque. Tests / commande explicite. */
export async function clearCache(): Promise<void> {
  memCache = { version: CACHE_VERSION, entries: {} };
  if (cachePath) {
    try { await fs.writeFile(cachePath, JSON.stringify(memCache), 'utf8'); } catch { /* ignore */ }
  }
}

/** Stats du cache : nb entries + age min/max. Utile pour debug. */
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

/** Reset le path du cache (utile pour les tests isoles). */
export function resetCacheForTests(): void {
  memCache = null;
  cachePath = null;
}
