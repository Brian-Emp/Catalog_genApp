import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseRetryDelayMs, isQuotaFailure, isModelUnavailable, isServerOverloaded,
  generateText, GEMINI_MODELS, clearGeminiKeyCache,
} from '../../../src/v2/gemini/client';
import { resetRateLimiter, snapshot as rlSnapshot } from '../../../src/v2/gemini/rateLimiter';
import { resetCircuit, clearQuotaCold, isQuotaCold } from '../../../src/v2/gemini/circuitBreaker';

/** Mock fetch minimal : callGenerate n'appelle que resp.json(). */
function jsonResp(obj: unknown) {
  return { json: async () => obj };
}
const errResp = (code: number, message: string) => jsonResp({ error: { code, message } });
const okResp = (text: string) =>
  jsonResp({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });

describe('isQuotaFailure', () => {
  it('reconnait 429', () => {
    expect(isQuotaFailure('429: blah')).toBe(true);
    expect(isQuotaFailure('Code 429 returned')).toBe(true);
  });
  it('reconnait "quota"', () => {
    expect(isQuotaFailure('Quota exceeded')).toBe(true);
  });
  it('reconnait "rate limit"', () => {
    expect(isQuotaFailure('rate limit hit')).toBe(true);
    expect(isQuotaFailure('rate-limit hit')).toBe(true);
  });
  it('reconnait "circuit ouvert"', () => {
    expect(isQuotaFailure('circuit ouvert (quota epuise)')).toBe(true);
  });
  it('ignore les autres erreurs', () => {
    expect(isQuotaFailure('500: internal server error')).toBe(false);
    expect(isQuotaFailure('fetch failed: network')).toBe(false);
    expect(isQuotaFailure('401: unauthorized')).toBe(false);
  });
  it('NE matche PAS 429 colle a un chiffre (regression 4290)', () => {
    expect(isQuotaFailure('500: internal error code 4290')).toBe(false);
    expect(isQuotaFailure('error 14290 occurred')).toBe(false);
  });
  it('ignore undefined / vide', () => {
    expect(isQuotaFailure(undefined)).toBe(false);
    expect(isQuotaFailure('')).toBe(false);
  });
});

describe('isModelUnavailable', () => {
  it('reconnait 404 / not found / not supported', () => {
    expect(isModelUnavailable('404: model not found')).toBe(true);
    expect(isModelUnavailable('Model is not supported')).toBe(true);
    expect(isModelUnavailable('does not exist')).toBe(true);
  });
  it('ignore quota / serveur / 404 colle a un chiffre', () => {
    expect(isModelUnavailable('429: quota exceeded')).toBe(false);
    expect(isModelUnavailable('500: server error')).toBe(false);
    expect(isModelUnavailable('error 4040 code')).toBe(false);
    expect(isModelUnavailable(undefined)).toBe(false);
  });
});

describe('isServerOverloaded', () => {
  it('reconnait 503 / "high demand" (cas reel audit skip)', () => {
    expect(isServerOverloaded('503: This model is currently experiencing high demand.')).toBe(true);
    expect(isServerOverloaded('503: overloaded')).toBe(true);
  });
  it('reconnait 500 / 502 / 504', () => {
    expect(isServerOverloaded('500: internal error')).toBe(true);
    expect(isServerOverloaded('502: bad gateway')).toBe(true);
    expect(isServerOverloaded('504: gateway timeout')).toBe(true);
  });
  it('reconnait formulations sans code', () => {
    expect(isServerOverloaded('The model is overloaded, try again later')).toBe(true);
    expect(isServerOverloaded('temporarily unavailable')).toBe(true);
  });
  it('ignore quota / auth / bad-request (NE doit PAS cascader dessus en tant que 5xx)', () => {
    expect(isServerOverloaded('429: quota exceeded')).toBe(false);
    expect(isServerOverloaded('401: unauthorized')).toBe(false);
    expect(isServerOverloaded('400: invalid argument')).toBe(false);
    expect(isServerOverloaded('404: not found')).toBe(false);
  });
  it('NE matche PAS un code 5xx colle a un chiffre, ni undefined', () => {
    expect(isServerOverloaded('error 5030 occurred')).toBe(false);
    expect(isServerOverloaded(undefined)).toBe(false);
    expect(isServerOverloaded('')).toBe(false);
  });
});

describe('callWithCascade — resilience reseau', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'AIza-DUMMY-TEST-KEY-NOT-A-REAL-SECRET';
    clearGeminiKeyCache();
    resetRateLimiter();
    resetCircuit();
    clearQuotaCold();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    clearGeminiKeyCache();
    resetCircuit();
    clearQuotaCold();
  });

  it('503 sur le 1er modele → bascule au suivant (usedFallback), pas d echec', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      // 1er modele cascade = gemini-3.5-flash → 503 ; suivants → succes
      return String(url).includes('gemini-3.5-flash:')
        ? errResp(503, 'This model is currently experiencing high demand.')
        : okResp('OK');
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateText({ prompt: 'x', module: 'test' });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('OK');
    expect(res.usedFallback).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('400 bad-request → stoppe la cascade (1 seul appel, pas de fan-out inutile)', async () => {
    const fetchMock = vi.fn(async () => errResp(400, 'Invalid argument'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateText({ prompt: 'x', module: 'test' });
    expect(res.ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('cascade complete 429 → quota marque FROID', async () => {
    const fetchMock = vi.fn(async () => errResp(429, 'Resource has been exhausted (quota).'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateText({ prompt: 'x', module: 'test' });
    expect(res.ok).toBe(false);
    expect(isQuotaCold()).toBe(true);
  });

  it('circuit ouvert → skip sans consommer le budget RPM (pas de record fantome)', async () => {
    const fetchMock = vi.fn(async () => errResp(429, 'Resource has been exhausted (quota).'));
    vi.stubGlobal('fetch', fetchMock);
    // 3 cascades completes 429 → ouvre le circuit de chaque (module,modele).
    // clearQuotaCold a chaque tour : sinon le 1er echec marque froid et les
    // cascades suivantes court-circuitent AVANT d'accumuler leurs echecs.
    for (let k = 0; k < 3; k++) {
      clearQuotaCold();
      await generateText({ prompt: 'x', module: 'rl-test' });
    }
    resetRateLimiter();   // budget par-minute repropre
    clearQuotaCold();     // sinon court-circuit global AVANT la boucle modeles
    await generateText({ prompt: 'x', module: 'rl-test' });
    // Tous les circuits sont ouverts → aucun modele ne doit reserver de slot RPM.
    expect(Object.keys(rlSnapshot())).toHaveLength(0);
  });

  it('sonde noCascade 429 (1 modele, ex health) → n empoisonne PAS le quota-froid', async () => {
    const fetchMock = vi.fn(async () => errResp(429, 'Resource has been exhausted (quota).'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateText({
      prompt: 'x', model: GEMINI_MODELS.flash31Lite, noCascade: true, module: 'health', maxRetryDelayMs: 0,
    });
    expect(res.ok).toBe(false);
    expect(isQuotaCold()).toBe(false);
  });
});

describe('parseRetryDelayMs', () => {
  it('parse "Please retry in 53.55s."', () => {
    const ms = parseRetryDelayMs('429: Quota exceeded. Please retry in 53.553775854s. \n');
    expect(ms).toBe(53554);
  });

  it('parse "retry in 5s" tout court', () => {
    expect(parseRetryDelayMs('retry in 5s')).toBe(5000);
  });

  it('cap a 5 min si delai > 300s', () => {
    expect(parseRetryDelayMs('retry in 9999s')).toBe(300_000);
  });

  it('retourne null si pas de pattern', () => {
    expect(parseRetryDelayMs('quota exceeded')).toBeNull();
    expect(parseRetryDelayMs('')).toBeNull();
  });

  it('retourne null si delai <= 0', () => {
    expect(parseRetryDelayMs('retry in 0s')).toBeNull();
    expect(parseRetryDelayMs('retry in -5s')).toBeNull();
  });

  it('parse case-insensitive', () => {
    expect(parseRetryDelayMs('RETRY IN 10s')).toBe(10_000);
  });
});
