/**
 * Tests cache Gemini : économise quota daily sur re-runs.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  initCache,
  cacheGet,
  cacheSet,
  clearCache,
  computeCacheKey,
  cacheStats,
  resetCacheForTests,
} from '../../../src/v2/gemini/cache';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemcache-'));
  resetCacheForTests();
});

afterAll(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Gemini cache', () => {
  it('computeCacheKey est stable et déterministe', () => {
    const buf = Buffer.from('image-data');
    const k1 = computeCacheKey('prompt A', [buf]);
    const k2 = computeCacheKey('prompt A', [buf]);
    expect(k1).toBe(k2);
    const k3 = computeCacheKey('prompt B', [buf]);
    expect(k1).not.toBe(k3);
  });

  it('cacheGet sans init → undefined (no-op)', () => {
    const v = cacheGet('x');
    expect(v).toBeUndefined();
  });

  it('set + get round-trip après init', async () => {
    await initCache(tmpDir);
    await cacheSet('k1', { issues: [{ severity: 'critical' }] });
    const v = cacheGet<{ issues: unknown[] }>('k1');
    expect(v).toBeDefined();
    expect(v?.issues).toHaveLength(1);
  });

  it('persiste sur disque (re-init lit du fichier)', async () => {
    await initCache(tmpDir);
    await cacheSet('persisted', { x: 42 });
    resetCacheForTests();
    await initCache(tmpDir);
    const v = cacheGet<{ x: number }>('persisted');
    expect(v?.x).toBe(42);
  });

  it('clearCache vide tout', async () => {
    await initCache(tmpDir);
    await cacheSet('a', 1);
    await cacheSet('b', 2);
    expect(cacheStats().entries).toBe(2);
    await clearCache();
    expect(cacheStats().entries).toBe(0);
  });

  it('cacheStats retourne nb entries + age min/max', async () => {
    await initCache(tmpDir);
    const before = Date.now();
    await cacheSet('x', 1);
    const stats = cacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.oldestMs).toBeGreaterThanOrEqual(before - 1);
    expect(stats.newestMs).toBeGreaterThanOrEqual(before - 1);
  });

  it('init multiple fois est idempotent', async () => {
    await initCache(tmpDir);
    await cacheSet('k', 'v');
    await initCache(tmpDir); // ne reset pas
    expect(cacheGet('k')).toBe('v');
  });
});
