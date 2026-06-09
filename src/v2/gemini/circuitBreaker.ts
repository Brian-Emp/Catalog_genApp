/**
 * Gemini circuit breaker: avoids burning time retrying a module that just
 * took 3 x 429 in a row (daily quota probably exhausted).
 *
 * Per-module state (key = "<module>:<model>"):
 *  - closed: calls pass through normally
 *  - open  : calls are short-circuited (no fetch, immediate failure)
 *
 * Transition closed → open: 3 consecutive 429 errors with no success in between.
 * Transition open → closed: manual reset via resetCircuit() or trip TTL (5min).
 *
 * The breaker is OPT-IN: we only short-circuit modules that have been marked
 * abandoned. Default = never open (maximum compatibility).
 */

const TRIP_TTL_MS = 5 * 60 * 1000; // 5min: we retry after this
const FAILURE_THRESHOLD = 3;

// ─── Global "cold" quota (cross-module, cross-model) ────────────────────────
// Flag set when a full CASCADE fails on quota (no model has any
// budget). Auxiliary LLM tasks (audit, descriptions, enrich) check
// this flag BEFORE their expensive work (page rasterization, cascade of N
// models) and skip if cold → generation does not waste time when the
// quota is globally exhausted. Short TTL: we retry quickly (a model can
// recover its per-minute quota).
const QUOTA_COLD_TTL_MS = 45 * 1000;
let quotaColdUntil = 0;

/** Marks the Gemini quota as "cold" (a full cascade just failed). */
export function markQuotaCold(): void {
  quotaColdUntil = Date.now() + QUOTA_COLD_TTL_MS;
}

/** Is the Gemini quota "cold" (a full cascade failed very recently)?
 *  Auxiliary tasks can then short-circuit their expensive work. */
export function isQuotaCold(): boolean {
  return Date.now() < quotaColdUntil;
}

/** Resets the cold flag (test / new day / quota refresh). */
export function clearQuotaCold(): void {
  quotaColdUntil = 0;
}

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
}

const state = new Map<string, CircuitState>();

function key(module: string, model: string): string {
  return `${module}:${model}`;
}

/**
 * Checks whether the circuit is open for (module, model). If so: skip the call
 * and return true (caller must fail-fast). If not: false (call allowed).
 *
 * Auto-reset if TRIP_TTL_MS has elapsed since opening.
 */
export function isCircuitOpen(module: string, model: string): boolean {
  const s = state.get(key(module, model));
  if (!s || s.openedAt === null) return false;
  if (Date.now() - s.openedAt > TRIP_TTL_MS) {
    // TTL elapsed, we retry (half-open)
    s.openedAt = null;
    s.consecutiveFailures = 0;
    return false;
  }
  return true;
}

/**
 * Notifies a 429 failure (or similar quota error). If threshold reached: opens the circuit.
 */
export function recordFailure(module: string, model: string, errorCode?: number): void {
  // We only trip on 429 (rate limit/quota). 5xx errors are transient.
  if (errorCode !== 429) return;
  const k = key(module, model);
  const s = state.get(k) ?? { consecutiveFailures: 0, openedAt: null };
  s.consecutiveFailures++;
  if (s.consecutiveFailures >= FAILURE_THRESHOLD) {
    s.openedAt = Date.now();
  }
  state.set(k, s);
}

/**
 * Notifies a success: resets the consecutive failure counter.
 */
export function recordSuccess(module: string, model: string): void {
  const s = state.get(key(module, model));
  if (s) {
    s.consecutiveFailures = 0;
    s.openedAt = null;
  }
}

/** Manual reset of a circuit (e.g. new day, quota refresh). */
export function resetCircuit(module?: string, model?: string): void {
  if (module && model) {
    state.delete(key(module, model));
  } else {
    state.clear();
  }
}

/** Snapshot for diagnostics / UI. */
export function getCircuitState(): Record<string, { failures: number; open: boolean; openedAt: number | null }> {
  const out: Record<string, { failures: number; open: boolean; openedAt: number | null }> = {};
  for (const [k, s] of state) {
    out[k] = {
      failures: s.consecutiveFailures,
      open: s.openedAt !== null,
      openedAt: s.openedAt,
    };
  }
  return out;
}
