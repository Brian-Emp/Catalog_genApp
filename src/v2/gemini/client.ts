/**
 * Low-level Gemini client: fetch() wrapper around the Google AI REST API.
 *
 * No @google/genai npm dependency: we use fetch() directly to minimize the
 * surface (no SDK breaking changes, no bloat). Sufficient for the 4 use cases
 * (text, vision, image gen).
 *
 * Auth: the key is read from:
 *   1. process.env.GEMINI_API_KEY (if defined directly)
 *   2. process.env.GEMINI_KEY_FILE (path to a file containing the key)
 *   3. ~/.gemini.key (host fallback)
 *
 * If no key is found, isGeminiAvailable() returns false and the gemini-*
 * modules must skip their logic (graceful no-op).
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let cachedKey: string | null | undefined;

/** Resolves the Gemini key from env vars / file / home fallback. Caches
 *  the result (null = not found, string = found). */
export async function resolveGeminiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  // 1. Direct env
  const envDirect = process.env.GEMINI_API_KEY?.trim();
  if (envDirect && envDirect.startsWith('AIza')) {
    cachedKey = envDirect;
    return cachedKey;
  }
  // 2. Env -> file path
  const envFile = process.env.GEMINI_KEY_FILE?.trim();
  const candidatePaths = [
    envFile,
    path.join(os.homedir(), '.gemini.key'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const p of candidatePaths) {
    try {
      const content = (await fs.readFile(p, 'utf8')).trim();
      if (content.startsWith('AIza')) {
        cachedKey = content;
        return cachedKey;
      }
    } catch {
      // path doesn't exist, we continue
    }
  }
  cachedKey = null;
  return null;
}

export async function isGeminiAvailable(): Promise<boolean> {
  return (await resolveGeminiKey()) !== null;
}

/** Resets the cache (useful for tests). */
export function clearGeminiKeyCache(): void {
  cachedKey = undefined;
}

// ─── Models constants ───────────────────────────────────────────────────────
export const GEMINI_MODELS = {
  /** Fast multimodal text/vision, cheaper. Free rate limit: 15 RPM. */
  flash: 'gemini-2.5-flash',
  /** Lightweight variant of flash, without thinking budget. Faster + more
   *  generous free rate limit (~30 RPM). Ideal for mapping / descriptions
   *  / short calls. */
  flashLite: 'gemini-2.5-flash-lite',
  /** Premium multimodal text/vision (1M context, deep reasoning). */
  pro: 'gemini-2.5-pro',
  /** Image generation ("Nano Banana"). Paid only on free tier. */
  image: 'gemini-2.5-flash-image',
  /** INDEPENDENT free-tier quota pools (separate daily RPD PER MODEL).
   *  Cascade relay when the 2.5 quota (only 20 RPD/day!) is exhausted.
   *  NB: the 2.0 family is at 0 RPD on this tier (USELESS) → we take 3.x +
   *  Gemma which have budget. Verified empirically (dashboard + real calls). */
  flash31Lite: 'gemini-3.1-flash-lite',
  flash35: 'gemini-3.5-flash',
  gemma: 'gemma-4-31b-it',
} as const;

/** Default TEXT cascade: the free tier limits requests PER MODEL
 *  (RPD/day + RPM/min). We exhaust one model then switch to the next, which has
 *  its own pool. Order: the most permissive/economical first. */
// Order = DECREASING QUALITY: we ALWAYS start with the best models
// (richer output: audit + descriptions). The lite/Gemma ones serve only as a
// FALLBACK when the full models have exhausted their daily quota. Real free-tier
// RPD (AI Studio dashboard):
//   3.5-flash=20 · 2.5-flash=20 · 3.1-flash-lite=500 · 2.5-flash-lite=20 · gemma=1500
// (2.0 and Pro = 0, excluded). So: full ones (3.5/2.5-flash) up front for quality,
// then 3.1-flash-lite (500/day, big net when the 20/day are burned), then Gemma.
export const TEXT_CASCADE: string[] = [
  GEMINI_MODELS.flash35,     // 3.5 flash (full) — BEST, always up front
  GEMINI_MODELS.flash,       // 2.5 flash (full)
  GEMINI_MODELS.flash31Lite, // 3.1 flash-lite (500/day) — big budget net
  GEMINI_MODELS.flashLite,   // 2.5 flash-lite (20/day)
  GEMINI_MODELS.gemma,       // Gemma 4 (1500/day) — deep reserve (lower quality)
];
/** VISION cascade: multimodal models VERIFIED to "accept an image", same
 *  QUALITY-first logic. */
export const VISION_CASCADE: string[] = [
  GEMINI_MODELS.flash35,     // 3.5 flash — BEST
  GEMINI_MODELS.flash,       // 2.5 flash
  GEMINI_MODELS.flash31Lite, // 3.1 flash-lite (500/day) — big net
  GEMINI_MODELS.flashLite,   // 2.5 flash-lite
];

/** List of models to try: the caller's explicit model(s) first, then the
 *  rest of the cascade (deduped, order preserved). */
function buildCascade(primary: string, fallback: string | undefined, base: string[]): string[] {
  // `base` is ordered by QUALITY (best models first) → AUTHORITATIVE.
  // The caller's explicit model/fallback is guaranteed present but does NOT go
  // ahead of the cascade (otherwise a caller forcing a specific model would
  // short-circuit quality). Added at the end only if missing from the cascade.
  const out = [...base];
  for (const m of [primary, fallback]) {
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Roughly estimates a request's tokens (input + output) for the TPM
 *  rate-limiter. ~4 chars/token; inline image ~300 tokens; output =
 *  declared maxOutputTokens. Approximate but enough to avoid blowing the
 *  TPM (250K/min) — it's mostly the RPM (5-15/min) that's the constraint. */
function estimateRequestTokens(body: GeminiGenerateRequest): number {
  let t = 0;
  for (const content of body.contents ?? []) {
    for (const part of content.parts ?? []) {
      if (typeof part.text === 'string') t += Math.ceil(part.text.length / 4);
      if (part.inlineData) t += 300;
    }
  }
  t += body.generationConfig?.maxOutputTokens ?? 1024;
  return t;
}

/** Tries each model in the cascade. Advances to the next ONLY on a quota
 *  failure (429 / rate-limit / open circuit) — each model having its own
 *  free-tier pool. On a NON-quota error (auth, bad request) we stop (no point
 *  cascading). Returns the first success (flags usedFallback if not the first),
 *  or the last failure. */
async function callWithCascade(
  models: string[],
  body: GeminiGenerateRequest,
  key: string,
  module: string,
): Promise<GenerateTextResult> {
  const cb = await import('./circuitBreaker');
  const rl = await import('./rateLimiter');
  // Short-circuit: if a full cascade failed on quota very recently
  // (<45s), all models are dead → immediate failure without retrying the N.
  // Avoids wasting time on each auxiliary task when the quota is globally
  // exhausted.
  if (cb.isQuotaCold()) {
    return { ok: false, error: 'quota Gemini froid (cascade court-circuitee, retest auto <45s)' };
  }
  const estTokens = estimateRequestTokens(body);
  let last: GenerateTextResult = { ok: false, error: 'cascade vide' };
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    // OPEN CIRCUIT: this (module, model) took 3x429 recently → we SKIP
    // BEFORE any rate-limit reservation. Otherwise we consume an RPM/TPM slot for
    // a call that won't go out (callGenerate fail-fast on open circuit),
    // which eats the per-minute budget of the model SHARED by the other modules.
    if (cb.isCircuitOpen(module, model)) {
      last = { ok: false, error: `${model}: circuit ouvert (quota recent, retest <5min)` };
      continue;
    }
    // PROACTIVE RATE-LIMIT (per minute): if the model has already reached its RPM
    // or TPM over the 60s window, we SKIP straight to the next one (distinct pool) —
    // avoids a guaranteed 429 + its round-trip. The RPD (day) stays handled
    // reactively by the quota 429 below.
    if (!rl.canUse(model, estTokens)) {
      last = { ok: false, error: `${model}: limite par-minute (RPM/TPM) atteinte` };
      continue;
    }
    // RESERVE the RPM/TPM slot BEFORE the call (anti-race: 2 concurrent
    // generations don't all pass canUse before any has counted).
    rl.record(model, estTokens);
    // maxRetryDelayMs=0: on 429 we do NOT sleep on the current model (its
    // announced retry-in is misleading — a daily quota may show "2s").
    // We immediately switch to the next model (independent pool). The 5xx retry
    // (exponential backoff) stays active (network transient != quota).
    const res = await callGenerate(model, body, key, module, 0, i > 0);
    if (res.ok) return i > 0 ? { ...res, usedFallback: true } : res;
    last = res;
    // We CONTINUE the cascade on a QUOTA failure (429/rate-limit), unavailable
    // model (404/not-found: an exotic model not provisioned that day must not
    // kill the gen) OR a transient server overload (5xx / "high demand": another
    // model has a distinct backend and may respond). On a real error
    // (400 bad-request, auth) we stop (cascading is pointless).
    if (!isQuotaFailure(res.error) && !isModelUnavailable(res.error) && !isServerOverloaded(res.error)) {
      return res;
    }
  }
  // The whole cascade failed. markQuotaCold ONLY if (a) it was a true
  // multi-model cascade — a noCascade probe (e.g. health, 1 model) CANNOT
  // conclude that ALL models are burned, it must not poison the global
  // flag — AND (b) the final failure is a quota (not a transient 5xx).
  if (models.length > 1 && isQuotaFailure(last.error)) cb.markQuotaCold();
  return last;
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Hard timeout per HTTP request. Node `fetch` has NO default timeout: a
// connection that hangs (overloaded model, silent proxy) would block the await
// indefinitely. 15s: a healthy Gemini flash/lite call responds in 1-5s; beyond
// that = slow/hanging model → we abort and (in cascade) switch to the next.
const REQUEST_TIMEOUT_MS = 15_000;

// ─── Types Gemini API ───────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiGenerateRequest {
  contents: GeminiContent[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
    responseModalities?: string[];
  };
  safetySettings?: Array<{ category: string; threshold: string }>;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
  error?: { code: number; message: string; status: string };
}

// ─── Generation text ────────────────────────────────────────────────────────

export interface GenerateTextOptions {
  prompt: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Max cap on the honored 429 retry delay. Default 90s.
   * For "fast or nothing" calls (health, UI): pass ~5000 to fail-fast.
   */
  maxRetryDelayMs?: number;
  /**
   * Fallback model tried if the main call fails with 429 exhausted
   * or open circuit. E.g. model='gemini-2.5-flash', fallbackModel='gemini-2.5-flash-lite'.
   * If the fallback succeeds: we continue. If the fallback also fails: we return the main error.
   */
  fallbackModel?: string;
}

export interface GenerateTextResult {
  ok: boolean;
  text?: string;
  finishReason?: string;
  error?: string;
  /** True if the response comes from the fallbackModel (degradation). */
  usedFallback?: boolean;
}

export interface GenerateTextOptionsExt extends GenerateTextOptions {
  /** Caller label for stats tracking (e.g. 'descriptions', 'specMapping'). */
  module?: string;
  /** If true: does NOT USE the cascade — probes ONLY the requested model
   *  (no fan-out to the others). For the health check: 1 fast probe of a
   *  reliable model, without traversing potentially burned 20/day models. */
  noCascade?: boolean;
}

export async function generateText(opts: GenerateTextOptionsExt): Promise<GenerateTextResult> {
  const key = await resolveGeminiKey();
  if (!key) return { ok: false, error: 'GEMINI_KEY absente (skip Gemini)' };
  const model = opts.model ?? GEMINI_MODELS.flash;
  const body: GeminiGenerateRequest = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
    },
  };
  // Cascade: the caller's explicit model + fallback, then the default text
  // cascade. We switch model on exhausted quota (each model = independent free
  // tier pool). noCascade → we probe only `model` (health check).
  const cascade = opts.noCascade ? [model] : buildCascade(model, opts.fallbackModel, TEXT_CASCADE);
  return callWithCascade(cascade, body, key, opts.module ?? 'unknown');
}

// ─── Vision (analyse image) ─────────────────────────────────────────────────

export interface AnalyzeImageOptions {
  prompt: string;
  imageBytes: Buffer;
  mimeType?: string;
  model?: string;
  /** Caller label for stats. */
  module?: string;
  /** 429 retry cap in ms (default 90s). */
  maxRetryDelayMs?: number;
  /** Degradation model if main fails on quota. E.g. flash → flashLite. */
  fallbackModel?: string;
}

export async function analyzeImage(opts: AnalyzeImageOptions): Promise<GenerateTextResult> {
  const key = await resolveGeminiKey();
  if (!key) return { ok: false, error: 'GEMINI_KEY absente (skip Gemini)' };
  const model = opts.model ?? GEMINI_MODELS.flash;
  const body: GeminiGenerateRequest = {
    contents: [{
      role: 'user',
      parts: [
        { text: opts.prompt },
        {
          inlineData: {
            mimeType: opts.mimeType ?? 'image/png',
            data: opts.imageBytes.toString('base64'),
          },
        },
      ],
    }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
  };
  const cascade = buildCascade(model, opts.fallbackModel, VISION_CASCADE);
  return callWithCascade(cascade, body, key, opts.module ?? 'analyzeImage');
}

// ─── Vision multi-images (analyse globale) ──────────────────────────────────

export interface MultiImageInput {
  bytes: Buffer;
  mimeType?: string;
  /** Optional label (e.g. "page 5") added as text before the image in the prompt. */
  label?: string;
}

export interface AnalyzeMultiImageOptions {
  prompt: string;
  images: MultiImageInput[];
  model?: string;
  temperature?: number;
  module?: string;
  maxRetryDelayMs?: number;
  /** Degradation model if main fails on quota (e.g. pro → flash). */
  fallbackModel?: string;
}

/**
 * Sends several images in a SINGLE Gemini request for global analysis.
 * Use case: catalog coherence, cross-page comparison, detection of
 * subtle variations between similar pages.
 *
 * The prompt is sent first, then each image preceded by its label
 * (if provided). 1M-token context = supports 20-30 high-quality images.
 */
export async function analyzeMultiImage(
  opts: AnalyzeMultiImageOptions,
): Promise<GenerateTextResult> {
  const key = await resolveGeminiKey();
  if (!key) return { ok: false, error: 'GEMINI_KEY absente (skip Gemini)' };
  const model = opts.model ?? GEMINI_MODELS.pro;
  const parts: GeminiPart[] = [{ text: opts.prompt }];
  for (const img of opts.images) {
    if (img.label) parts.push({ text: img.label });
    parts.push({
      inlineData: {
        mimeType: img.mimeType ?? 'image/png',
        data: img.bytes.toString('base64'),
      },
    });
  }
  const body: GeminiGenerateRequest = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: 8192,
    },
  };
  const cascade = buildCascade(model, opts.fallbackModel, VISION_CASCADE);
  return callWithCascade(cascade, body, key, opts.module ?? 'analyzeMultiImage');
}

// ─── Generation image (Nano Banana / Imagen) ────────────────────────────────

export interface GenerateImageOptions {
  prompt: string;
  model?: string;
}

export interface GenerateImageResult {
  ok: boolean;
  imageBytes?: Buffer;
  mimeType?: string;
  error?: string;
}

export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const key = await resolveGeminiKey();
  if (!key) return { ok: false, error: 'GEMINI_KEY absente (skip Gemini)' };
  const model = opts.model ?? GEMINI_MODELS.image;
  const body: GeminiGenerateRequest = {
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await resp.json() as GeminiGenerateResponse;
    if (json.error) return { ok: false, error: `${json.error.code}: ${json.error.message}` };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData?.data) {
      return { ok: false, error: 'Reponse sans inlineData (image manquante)' };
    }
    return {
      ok: true,
      imageBytes: Buffer.from(part.inlineData.data, 'base64'),
      mimeType: part.inlineData.mimeType,
    };
  } catch (err) {
    return { ok: false, error: `fetch echec: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Helper interne ─────────────────────────────────────────────────────────

async function callGenerate(
  model: string,
  body: GeminiGenerateRequest,
  key: string,
  module: string = 'unknown',
  maxRetryDelayMsOverride?: number,
  isFallbackAttempt: boolean = false,
): Promise<GenerateTextResult> {
  const t0 = Date.now();
  // Lazy import to avoid a cycle (stats.ts is a leaf)
  const { recordCall } = await import('./stats');
  const cb = await import('./circuitBreaker');
  // If the circuit is open for this (module, model): fail-fast.
  if (cb.isCircuitOpen(module, model)) {
    recordCall({
      module,
      model,
      status: 'retry_exhausted',
      durationMs: 0,
      errorCode: 429,
    });
    return { ok: false, error: 'circuit ouvert (quota Gemini probablement epuise, retest dans 5min)' };
  }
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  // Retry on 5xx/429 (transient / rate limit). 3 attempts max.
  // For 429: we parse the "retry in Xs" announced by Gemini (precise) and
  // honor that delay if <= maxRetryDelayMs. Beyond that = probable daily quota
  // → fail fast to let the orchestrator skip.
  const RETRY_CODES = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  // Fail-fast: if a 429 announces a retry > this cap, it's a dead daily quota
  // → immediate abort (no nap). Low default (8s) to NEVER block a generation
  // for minutes on an auxiliary task. Short rate-limits
  // (<8s, per-minute) are still retried normally.
  const MAX_RETRY_DELAY_MS = maxRetryDelayMsOverride ?? 8_000;
  let lastError: string | null = null;
  let lastErrorCode: number | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = await resp.json() as GeminiGenerateResponse;
      if (json.error) {
        lastError = `${json.error.code}: ${json.error.message}`;
        lastErrorCode = json.error.code;
        if (RETRY_CODES.has(json.error.code) && attempt < MAX_ATTEMPTS) {
          // 429: parse the retry_in announced by Gemini if available
          const apiDelayMs = json.error.code === 429
            ? parseRetryDelayMs(json.error.message)
            : null;
          // FAIL-FAST 429: if NO delay announced (null — Gemini doesn't always
          // announce it) OR delay > cap → we do NOT wait and do NOT retry
          // the same model (probable quota). A null must NOT trigger a
          // blind 3x retry: the cascade switches model instead. (The 5xx
          // is not affected: code!==429 → exponential backoff below.)
          if (json.error.code === 429 && (apiDelayMs === null || apiDelayMs > MAX_RETRY_DELAY_MS)) {
            cb.recordFailure(module, model, lastErrorCode);
            recordCall({
              module,
              model,
              status: 'retry_exhausted',
              durationMs: Date.now() - t0,
              errorCode: lastErrorCode,
            });
            const retryHint = apiDelayMs !== null ? `, retry annonce ${Math.round(apiDelayMs / 1000)}s` : '';
            return { ok: false, error: `${lastError} (quota${retryHint})` };
          }
          // Same-model retry ONLY in non-cascade mode (cap>0, e.g. health).
          // In CASCADE (cap=0) we NEVER retry the same model (429 or 5xx
          // transient included): a slow/overloaded model doesn't heal by being
          // re-hit → we fall through to the return fail below and the cascade
          // switches to the next model. Avoids blocking 3x on a dead model.
          if (MAX_RETRY_DELAY_MS > 0) {
            const delayMs = apiDelayMs ?? (500 * Math.pow(2, attempt - 1));
            await sleep(delayMs);
            continue;
          }
        }
        cb.recordFailure(module, model, lastErrorCode);
        recordCall({
          module,
          model,
          status: attempt >= MAX_ATTEMPTS ? 'retry_exhausted' : 'error',
          durationMs: Date.now() - t0,
          errorCode: lastErrorCode,
        });
        return { ok: false, error: lastError };
      }
      const candidate = json.candidates?.[0];
      const textPart = candidate?.content?.parts?.find((p) => typeof p.text === 'string');
      if (!textPart?.text) {
        recordCall({ module, model, status: 'error', durationMs: Date.now() - t0 });
        return {
          ok: false,
          error: `Reponse sans text (finishReason=${candidate?.finishReason ?? 'unknown'})`,
          finishReason: candidate?.finishReason,
        };
      }
      cb.recordSuccess(module, model);
      recordCall({
        module,
        model,
        status: 'ok',
        durationMs: Date.now() - t0,
        usedFallback: isFallbackAttempt || undefined,
        promptTokens: json.usageMetadata?.promptTokenCount,
        candidateTokens: json.usageMetadata?.candidatesTokenCount,
      });
      return { ok: true, text: textPart.text, finishReason: candidate?.finishReason };
    } catch (err) {
      // Includes the AbortError from the fetch timeout (hanging model). In cascade
      // (cap=0) we do NOT retry (a hanging model doesn't heal) → we exit and the
      // cascade switches. In non-cascade (cap>0) we retry (network blip).
      lastError = `fetch echec: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < MAX_ATTEMPTS && MAX_RETRY_DELAY_MS > 0) {
        await sleep(500 * Math.pow(2, attempt - 1));
        continue;
      }
    }
  }
  cb.recordFailure(module, model, lastErrorCode);
  recordCall({
    module,
    model,
    status: 'retry_exhausted',
    durationMs: Date.now() - t0,
    errorCode: lastErrorCode,
  });
  return { ok: false, error: lastError ?? 'unknown' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detects whether a callGenerate error is due to the Gemini quota (429 / circuit open).
 * Used by the fallback: we degrade ONLY on quota, not on other
 * errors (auth fail, network, bad request → no useful fallback).
 *
 * Exported for unit testing.
 */
export function isQuotaFailure(error: string | undefined): boolean {
  if (!error) return false;
  // `429` must be an isolated number: not stuck to a letter NOR a digit
  // (otherwise "500: code 4290" would match wrongly). Lookarounds [a-z0-9].
  return /(?<![a-z0-9])429(?![a-z0-9])|quota|rate.?limit|circuit ouvert/i.test(error);
}

/**
 * Detects a "model unavailable" error (404 / not found / not supported):
 * an exotic cascade model not provisioned that day. The cascade must
 * SKIP this model and continue (vs stopping as on a real bad-request).
 */
export function isModelUnavailable(error: string | undefined): boolean {
  if (!error) return false;
  return /(?<![0-9])404(?![0-9])|not found|not supported|not available|does not exist|unavailable/i.test(error);
}

/**
 * Detects a TRANSIENT server overload (500/502/503/504, "high demand",
 * "overloaded", "try again later"). The cascade must SWITCH to the next model
 * (distinct backend) instead of giving up: a 503 on 3.5-flash says nothing about
 * the availability of 2.5-flash. NB: does NOT trip the circuit breaker (transient, not
 * quota). Exported for testing.
 */
export function isServerOverloaded(error: string | undefined): boolean {
  if (!error) return false;
  return /(?<![0-9])(500|502|503|504)(?![0-9])|overload|high demand|experiencing high|try again later|temporarily unavailable|internal error/i.test(error);
}

/**
 * Parses "Please retry in 53.55s." in a Gemini 429 error message.
 * Returns the delay in ms, or null if not parsed.
 * Capped at 5 min (300_000ms) to avoid absurd sleeps.
 *
 * Exported for unit testing.
 */
export function parseRetryDelayMs(message: string): number | null {
  // "Please retry in 53.553775854s." or "retry in 1m23s" (rare)
  const m = message.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!m) return null;
  const seconds = parseFloat(m[1]);
  if (!isFinite(seconds) || seconds <= 0) return null;
  // Cap at 5 min
  return Math.min(Math.round(seconds * 1000), 300_000);
}
