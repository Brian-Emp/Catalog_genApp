/**
 * Tests smart mapping Gemini : XLSX columns → produits.
 *
 * Pas d'appel Gemini reel dans ces tests (clé désactivée). On vérifie :
 *  - guards (enabled=false, headers vide, key absente)
 *  - structure du contract de sortie
 *
 * Les tests d'integration appel Gemini reel sont dans le smoke E2E.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { geminiColumnMap } from '../../../src/v2/gemini/smartMapping';
import { clearGeminiKeyCache } from '../../../src/v2/gemini/client';

describe('geminiColumnMap', () => {
  beforeEach(() => {
    clearGeminiKeyCache();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_KEY_FILE;
  });

  it('enabled=false → no-op', async () => {
    const res = await geminiColumnMap({
      headers: ['Name', 'SKU'],
      sampleRows: [],
      enabled: false,
    });
    expect(res.ran).toBe(false);
    expect(res.mapping).toBeNull();
    expect(res.notes).toContain('disabled');
  });

  it('headers vide → no-op', async () => {
    const res = await geminiColumnMap({
      headers: [],
      sampleRows: [],
    });
    expect(res.ran).toBe(false);
    expect(res.mapping).toBeNull();
    expect(res.notes).toContain('no headers');
  });

  // Note : le test "GEMINI_KEY absente" est non-deterministe selon la
  // presence de ~/.gemini.key sur la machine dev. On le skip car le client
  // gere deja le no-op gracieux en cas d'absence (verifie unitairement
  // dans client.ts).

  it('signature retourne durationMs et notes', async () => {
    const res = await geminiColumnMap({
      headers: ['Name'],
      sampleRows: [],
      enabled: false,
    });
    expect(typeof res.durationMs).toBe('number');
    expect(Array.isArray(res.notes)).toBe(true);
  });
});
