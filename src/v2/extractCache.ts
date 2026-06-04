/**
 * Cache des extracts C++ par hash du PDF template.
 *
 * Ratio cout/benefice : extract 188p = ~700ms ; cache hit = ~30ms (copie
 * de fichiers + parsing JSON). Gain net sur 2eme run avec meme template
 * (test, batch, re-generation apres edit xlsx) ~660ms.
 *
 * Cache disk-based dans `${os.tmpdir()}/catgen-extract-cache/<sha256>/`.
 * Eviction : si > 5 entrees, on supprime la plus ancienne (FIFO par mtime).
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const CACHE_ROOT = path.join(os.tmpdir(), 'catgen-extract-cache');
const MAX_ENTRIES = 5;

export async function pdfHash(pdfPath: string): Promise<string> {
  const buf = await fs.readFile(pdfPath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Si le cache contient un extract pour ce hash, copie son contenu vers
 * `targetDir` et retourne true. Sinon false (caller doit lancer l'extract).
 */
export async function tryRestoreFromCache(
  hash: string,
  targetDir: string,
): Promise<boolean> {
  const entryDir = path.join(CACHE_ROOT, hash);
  try {
    const stat = await fs.stat(entryDir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(entryDir);
  await Promise.all(
    entries.map((e) =>
      fs.copyFile(path.join(entryDir, e), path.join(targetDir, e)),
    ),
  );
  // Touch mtime pour ordre FIFO (eviction)
  const now = new Date();
  await fs.utimes(entryDir, now, now).catch(() => {});
  return true;
}

/** Sauvegarde l'extract dans le cache (best-effort, non-bloquant en cas d'echec). */
export async function saveToCache(hash: string, sourceDir: string): Promise<void> {
  try {
    const entryDir = path.join(CACHE_ROOT, hash);
    await fs.rm(entryDir, { recursive: true, force: true });
    await fs.mkdir(entryDir, { recursive: true });
    const entries = await fs.readdir(sourceDir);
    await Promise.all(
      entries.map((e) =>
        fs.copyFile(path.join(sourceDir, e), path.join(entryDir, e)),
      ),
    );
    await evictIfNeeded();
  } catch {
    // Best-effort : si le cache disk fail on log pas, juste tant pis.
  }
}

async function evictIfNeeded(): Promise<void> {
  try {
    const entries = await fs.readdir(CACHE_ROOT);
    if (entries.length <= MAX_ENTRIES) return;
    const withMtime = await Promise.all(
      entries.map(async (e) => {
        const stat = await fs.stat(path.join(CACHE_ROOT, e)).catch(() => null);
        return stat ? { name: e, mtime: stat.mtimeMs } : null;
      }),
    );
    const valid = withMtime.filter((x): x is { name: string; mtime: number } => x !== null);
    valid.sort((a, b) => a.mtime - b.mtime);
    const toEvict = valid.slice(0, valid.length - MAX_ENTRIES);
    await Promise.all(
      toEvict.map((e) =>
        fs.rm(path.join(CACHE_ROOT, e.name), { recursive: true, force: true }),
      ),
    );
  } catch { /* best-effort */ }
}
