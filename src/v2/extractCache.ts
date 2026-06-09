/**
 * Cache of C++ extracts keyed by the template PDF hash.
 *
 * Cost/benefit ratio: 188p extract = ~700ms; cache hit = ~30ms (file copy
 * + JSON parsing). Net gain on a 2nd run with the same template
 * (test, batch, re-generation after xlsx edit) ~660ms.
 *
 * Disk-based cache in `${os.tmpdir()}/catgen-extract-cache/<sha256>/`.
 * Eviction: if > 5 entries, we remove the oldest (FIFO by mtime).
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
 * If the cache contains an extract for this hash, copies its content to
 * `targetDir` and returns true. Otherwise false (caller must run the extract).
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
  // Touch mtime for FIFO ordering (eviction)
  const now = new Date();
  await fs.utimes(entryDir, now, now).catch(() => {});
  return true;
}

/** Saves the extract to the cache (best-effort, non-blocking on failure). */
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
    // Best-effort: if the disk cache fails we don't log, just move on.
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
