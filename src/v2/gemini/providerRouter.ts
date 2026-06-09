/**
 * Unified provider router: a single switch point for all Gemini/Claude text
 * generation in the V2 pipeline.
 *
 * ORDER (quality AND speed): REST API (model cascade, cf. client.ts) →
 *                            Claude CLI (last resort).
 *
 * WHY:
 *  - REST API = the multi-model cascade (3.1-flash-lite → flash → … → Gemma)
 *    already handles diversity + per-model quota. Fast (1-3s) and resilient.
 *  - Gemini CLI = ABANDONED (slow 8-88s + no image generation) → removed.
 *  - Claude CLI = last resort (NB: auth expires → graceful failure if invalid;
 *    and a no-op for callers without the workDir/projectDir required by callClaudeFallback).
 *
 * Each provider that fails (quota, auth, unavailable) switches to the next.
 * The result indicates which provider answered (field `provider`) + the trace
 * of attempts (for diagnostics).
 */

import { generateText, GEMINI_MODELS, isGeminiAvailable, isQuotaFailure, type GenerateTextResult } from './client';

export type ProviderName = 'api' | 'claude';
export type RoutePref = 'quality' | 'speed';

export interface RoutedTextOptions {
  prompt: string;
  /** 'quality' (default) = Pro CLI first; 'speed' = flash-lite API first. */
  pref?: RoutePref;
  /** Caller label for stats/trace. */
  module?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** cwd for the CLI (isolates the project context). */
  workDir?: string;
  /** Enables the Claude CLI fallback as a last resort. Default TRUE: the Gemini
   *  CLI is abandoned (slow 8-88s + no image gen), Claude takes the role of
   *  quality safety net. NB: requires valid Claude auth (otherwise graceful
   *  failure). Set explicitly to false to disable. */
  enableClaudeFallback?: boolean;
  claudeBin?: string;
  projectDir?: string;
  /** Forces the provider order (overrides pref). Useful for tests. */
  order?: ProviderName[];
}

export interface ProviderAttempt {
  provider: ProviderName;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** Skip = provider unavailable (no key/token), not attempted. */
  skipped?: boolean;
}

export interface RoutedTextResult extends GenerateTextResult {
  /** Provider that ultimately answered, or 'none' if all failed. */
  provider: ProviderName | 'none';
  attempts: ProviderAttempt[];
}

/**
 * Generates text by switching between providers until success.
 */
export async function routedGenerateText(opts: RoutedTextOptions): Promise<RoutedTextResult> {
  const pref: RoutePref = opts.pref ?? 'quality';
  const order = opts.order ?? defaultOrder(pref);
  const attempts: ProviderAttempt[] = [];

  for (const provider of order) {
    const t0 = Date.now();
    if (provider === 'api') {
      if (!(await isGeminiAvailable())) {
        attempts.push({ provider, ok: false, durationMs: 0, skipped: true, error: 'GEMINI_KEY absente' });
        continue;
      }
      const res = await generateText({
        prompt: opts.prompt,
        model: GEMINI_MODELS.flashLite,
        // On flash-lite quota, the API already tries flash-lite alone; no
        // intra-API fallback here (the router handles the inter-provider switch).
        temperature: opts.temperature,
        maxOutputTokens: opts.maxOutputTokens,
        module: opts.module ?? 'router',
      });
      attempts.push({ provider, ok: res.ok, durationMs: Date.now() - t0, error: res.error });
      if (res.ok) return { ...res, provider, attempts };
      continue;
    }

    if (provider === 'claude') {
      if (opts.enableClaudeFallback === false) {
        attempts.push({ provider, ok: false, durationMs: 0, skipped: true, error: 'claude fallback desactive' });
        continue;
      }
      const res = await callClaudeFallback(opts);
      attempts.push({ provider, ok: res.ok, durationMs: Date.now() - t0, error: res.error });
      if (res.ok) return { ...res, provider, attempts };
      continue;
    }
  }

  // All providers failed
  const lastErr = [...attempts].reverse().find((a) => !a.skipped)?.error
    ?? attempts[attempts.length - 1]?.error
    ?? 'aucun provider disponible';
  return { ok: false, error: lastErr, provider: 'none', attempts };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Provider order based on the preference. Exported for testing.
 */
export function defaultOrder(_pref: RoutePref): ProviderName[] {
  // Gemini CLI ABANDONED (slow 8-88s + no image generation) → removed from
  // the cascade. Everything goes through the API (model cascade, cf. client.ts)
  // then, as a last resort, the CLAUDE CLI (better judgment quality). Same
  // order for 'quality' and 'speed': the API cascade already handles diversity.
  return ['api', 'claude'];
}

/**
 * Claude CLI fallback: --print simple text. Best-effort; Claude auth may be
 * expired (401), in which case we cleanly return ok:false.
 */
async function callClaudeFallback(opts: RoutedTextOptions): Promise<GenerateTextResult> {
  if (!opts.workDir || !opts.projectDir) {
    return { ok: false, error: 'claude fallback : workDir/projectDir requis' };
  }
  try {
    const { callClaudeCli } = await import('../claudeCli');
    const res = await callClaudeCli({
      prompt: opts.prompt,
      workDir: opts.workDir,
      projectDir: opts.projectDir,
      claudeBin: opts.claudeBin,
      allowedTools: '',
    });
    if (!res.ok) return { ok: false, error: `claude : ${res.result.slice(0, 200)}` };
    return { ok: true, text: res.result };
  } catch (e) {
    return { ok: false, error: `claude fallback exception : ${(e as Error).message}` };
  }
}

// Re-exported for callers that want to test the nature of an error.
export { isQuotaFailure };
