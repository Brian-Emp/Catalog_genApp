/**
 * Gemini health check: verifies the presence of the key, API accessibility,
 * and quota status via a minimal call (1 token).
 *
 * Used for:
 *  - "Gemini OK / KO / quota" UI badge
 *  - pipeline startup log (warning if KO)
 *  - E2E test precondition
 */

import { generateText, GEMINI_MODELS, isGeminiAvailable, resolveGeminiKey } from './client';

export type GeminiHealthStatus = 'ok' | 'no_key' | 'quota_exceeded' | 'auth_error' | 'network_error' | 'unknown';

export interface GeminiHealthResult {
  status: GeminiHealthStatus;
  /** True if Gemini can be called (status === 'ok'). */
  ok: boolean;
  /** Model tested. */
  model: string;
  /** Test latency (ms). */
  durationMs: number;
  /** Error message if KO. */
  error?: string;
  /** Hint for fixing (user instruction). */
  hint?: string;
}

/**
 * Runs a Gemini health check. Minimal call (1 short prompt, 1 token max).
 * Cost: negligible. Timeout intrinsic to fetch (default).
 *
 * If the check is OK: returns { ok:true }. If KO: indicates the nature of the
 * error + a user hint.
 */
export async function checkGeminiHealth(): Promise<GeminiHealthResult> {
  const t0 = Date.now();
  // Health = probe 1 SINGLE reliable model (noCascade), NOT the quality cascade:
  // otherwise we'd traverse the full 20/day models (often burned out) → slow. We
  // probe 3.1-flash-lite (large 500/day buffer, almost always available) → fast
  // response + representative of "is Gemini reachable?". If it's KO, Gemini truly
  // is (the big safety net has fallen).
  const model = GEMINI_MODELS.flash31Lite;

  if (!(await isGeminiAvailable())) {
    return {
      status: 'no_key',
      ok: false,
      model,
      durationMs: Date.now() - t0,
      error: 'GEMINI_KEY absente',
      hint: 'Definir GEMINI_API_KEY env var OU mettre la cle dans ~/.gemini.key',
    };
  }

  const res = await generateText({
    prompt: 'Reponds juste le mot OK.',
    model,
    temperature: 0,
    // Min 32: gemini-2.5-flash includes an internal "thinking" budget before
    // the output, so maxOutputTokens=1 cuts off before any visible token
    // (finishReason=MAX_TOKENS with no text).
    maxOutputTokens: 32,
    module: 'health',
    // Probe a single model (no cascade fan-out) → fast + predictable.
    noCascade: true,
    // Fast-fail: 4s cap, otherwise the UI badge freezes. If quota is exhausted,
    // we want to know quickly (quota_exceeded), not wait 53s for a retry.
    maxRetryDelayMs: 4000,
  });
  const durationMs = Date.now() - t0;

  if (res.ok) {
    return { status: 'ok', ok: true, model, durationMs };
  }

  // Fine-grained identification of the error type
  const err = res.error ?? 'unknown';
  if (/(?<![0-9])429(?![0-9])|quota|rate.?limit|froid/i.test(err)) {
    return {
      status: 'quota_exceeded',
      ok: false,
      model,
      durationMs,
      error: err,
      hint: 'Quota free tier daily epuise. Reset minuit Pacific Time (~09h Paris). Ou activer billing Google Cloud.',
    };
  }
  if (/401|403|authentication|api.?key/i.test(err)) {
    return {
      status: 'auth_error',
      ok: false,
      model,
      durationMs,
      error: err,
      hint: 'Cle Gemini invalide ou expiree. Generer nouvelle cle sur aistudio.google.com/apikey.',
    };
  }
  if (/fetch|network|timeout|ECONNREFUSED|ENOTFOUND/i.test(err)) {
    return {
      status: 'network_error',
      ok: false,
      model,
      durationMs,
      error: err,
      hint: 'Pas d acces a l API Gemini. Verifier la connectivite internet du container/host.',
    };
  }
  return {
    status: 'unknown',
    ok: false,
    model,
    durationMs,
    error: err,
    hint: 'Erreur inattendue. Verifier les logs Gemini.',
  };
}

/**
 * Variant without an API call: verifies ONLY the presence of the key.
 * Useful for fast gate-keeping (1ms) before attempting an audit.
 */
export async function quickCheckGeminiKey(): Promise<{ ok: boolean; keyPresent: boolean }> {
  const key = await resolveGeminiKey();
  const keyPresent = key !== null;
  return { ok: keyPresent, keyPresent };
}
