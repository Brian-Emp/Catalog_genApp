/**
 * PROACTIVE per-model rate limiter for the Gemini cascade.
 *
 * The cascade already handles RPD (requests/DAY) REACTIVELY: a daily quota 429
 * switches to another model. But the free tier ALSO limits per MINUTE:
 *  - RPM : requests / minute
 *  - TPM : tokens (input + output) / minute
 *
 * Without a guard, a burst of generations burns a model's RPM → 429 → useless
 * round-trip + throttle. This module tracks per-model usage over a sliding
 * 60 s window and lets the cascade SKIP a model BEFORE hitting its per-minute
 * limit (so without a 429), moving straight to the next model (distinct pool).
 *
 * Free-tier values (Google AI Studio dashboard, 2026-06). Easy to adjust;
 * an unknown model falls back to DEFAULT_LIMIT (conservative).
 */

export interface ModelLimit {
  /** Requests per minute. */
  rpm: number;
  /** Tokens (input+output) per minute. Infinity = no TPM limit. */
  tpm: number;
}

const LIMITS: Record<string, ModelLimit> = {
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000 },
  'gemini-2.5-flash-lite': { rpm: 10, tpm: 250_000 },
  'gemini-2.5-flash': { rpm: 5, tpm: 250_000 },
  'gemini-3.5-flash': { rpm: 5, tpm: 250_000 },
  'gemma-4-31b-it': { rpm: 15, tpm: Number.POSITIVE_INFINITY },
};

/** Unlisted model → conservative limit (avoids burning an unknown quota). */
const DEFAULT_LIMIT: ModelLimit = { rpm: 5, tpm: 250_000 };

const WINDOW_MS = 60_000;

/** Per-model history: timestamp + estimated tokens of each recent call. */
const usage = new Map<string, { ts: number; tokens: number }[]>();

export function getLimit(model: string): ModelLimit {
  return LIMITS[model] ?? DEFAULT_LIMIT;
}

/** Purges entries > 60 s and returns the current window. */
function windowOf(model: string, now: number): { ts: number; tokens: number }[] {
  const arr = usage.get(model) ?? [];
  const fresh = arr.filter((e) => now - e.ts < WINDOW_MS);
  if (fresh.length !== arr.length) usage.set(model, fresh);
  return fresh;
}

/**
 * Can the model absorb a call of ~estTokens tokens this minute without
 * exceeding its RPM/TPM? If false: the cascade must skip it (the next one has a
 * distinct pool).
 */
export function canUse(model: string, estTokens = 0): boolean {
  const lim = getLimit(model);
  const now = Date.now();
  const win = windowOf(model, now);
  if (win.length >= lim.rpm) return false; // RPM reached this minute
  if (lim.tpm !== Number.POSITIVE_INFINITY) {
    const tokens = win.reduce((s, e) => s + e.tokens, 0);
    if (tokens + estTokens > lim.tpm) return false; // TPM reached
  }
  return true;
}

/** Records a (sent) call for this model: counts toward RPM + TPM. */
export function record(model: string, tokens: number): void {
  const now = Date.now();
  const win = windowOf(model, now);
  win.push({ ts: now, tokens: Math.max(0, tokens) });
  usage.set(model, win);
}

/** Snapshot for diagnostics: current RPM/TPM usage per model. */
export function snapshot(): Record<string, { rpmUsed: number; rpmMax: number; tpmUsed: number }> {
  const now = Date.now();
  const out: Record<string, { rpmUsed: number; rpmMax: number; tpmUsed: number }> = {};
  for (const model of usage.keys()) {
    const win = windowOf(model, now);
    if (win.length === 0) continue;
    out[model] = {
      rpmUsed: win.length,
      rpmMax: getLimit(model).rpm,
      tpmUsed: win.reduce((s, e) => s + e.tokens, 0),
    };
  }
  return out;
}

/** Reset (tests). */
export function resetRateLimiter(): void {
  usage.clear();
}
