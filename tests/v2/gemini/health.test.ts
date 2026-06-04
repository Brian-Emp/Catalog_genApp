/**
 * Tests health check Gemini.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { checkGeminiHealth, quickCheckGeminiKey } from '../../../src/v2/gemini/health';
import { clearGeminiKeyCache } from '../../../src/v2/gemini/client';

describe('checkGeminiHealth', () => {
  beforeEach(() => {
    clearGeminiKeyCache();
  });

  it('retourne status string + ok bool', async () => {
    const res = await checkGeminiHealth();
    expect(typeof res.status).toBe('string');
    expect(typeof res.ok).toBe('boolean');
    expect(typeof res.model).toBe('string');
    expect(typeof res.durationMs).toBe('number');
  });

  it('hint fourni si KO', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_KEY_FILE;
    process.env.GEMINI_KEY_FILE = '/tmp/does-not-exist-xyz.key';
    clearGeminiKeyCache();
    const res = await checkGeminiHealth();
    if (!res.ok) {
      expect(typeof res.hint).toBe('string');
    }
  });
});

describe('quickCheckGeminiKey', () => {
  beforeEach(() => {
    clearGeminiKeyCache();
  });

  it('retourne keyPresent bool', async () => {
    const res = await quickCheckGeminiKey();
    expect(typeof res.keyPresent).toBe('boolean');
    expect(typeof res.ok).toBe('boolean');
    expect(res.ok).toBe(res.keyPresent);
  });

  // Test no-key skip si la machine dev a ~/.gemini.key (le client fallback
  // sur ce path par defaut, c'est ok). Le no-key reel est teste via le
  // smoke E2E sur CI sans cle.
});
