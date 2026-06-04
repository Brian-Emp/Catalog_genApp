/**
 * Circuit breaker Gemini : evite de bruler du temps en re-essayant un module
 * qui vient de prendre 3 x 429 d'affilee (quota daily probablement epuise).
 *
 * Etat per-module (key = "<module>:<model>") :
 *  - closed : appels passent normalement
 *  - open   : appels skip court-circuit (pas de fetch, fail immediat)
 *
 * Transition closed → open : 3 erreurs 429 consecutives sans succes interleave.
 * Transition open → closed : reset manuel via resetCircuit() ou trip TTL (5min).
 *
 * Le breaker est OPT-IN : on ne court-circuite que les modules qui ont ete
 * marques abandonnes. Default = jamais ouvert (compatibilite max).
 */

const TRIP_TTL_MS = 5 * 60 * 1000; // 5min : on reteste apres
const FAILURE_THRESHOLD = 3;

// ─── Quota "froid" global (cross-module, cross-model) ───────────────────────
// Marque pose quand une CASCADE complete echoue sur quota (aucun modele n'a de
// budget). Les taches LLM auxiliaires (audit, descriptions, enrich) consultent
// ce flag AVANT leur travail couteux (rasterisation de pages, cascade de N
// modeles) et skippent si froid → la generation ne gaspille pas de temps quand
// le quota est globalement epuise. TTL court : on reteste vite (un modele peut
// recuperer son quota par-minute).
const QUOTA_COLD_TTL_MS = 45 * 1000;
let quotaColdUntil = 0;

/** Marque le quota Gemini "froid" (une cascade complete vient d'echouer). */
export function markQuotaCold(): void {
  quotaColdUntil = Date.now() + QUOTA_COLD_TTL_MS;
}

/** Le quota Gemini est-il "froid" (cascade complete echouee tres recemment) ?
 *  Les taches auxiliaires peuvent alors court-circuiter leur travail couteux. */
export function isQuotaCold(): boolean {
  return Date.now() < quotaColdUntil;
}

/** Reset du flag froid (test / nouveau jour / quota refresh). */
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
 * Verifie si le circuit est ouvert pour (module, model). Si oui : skip l'appel
 * et retourne true (caller doit fail-fast). Si non : false (appel autorise).
 *
 * Auto-reset si TRIP_TTL_MS ecoule depuis l'ouverture.
 */
export function isCircuitOpen(module: string, model: string): boolean {
  const s = state.get(key(module, model));
  if (!s || s.openedAt === null) return false;
  if (Date.now() - s.openedAt > TRIP_TTL_MS) {
    // TTL ecoule, on retente (half-open)
    s.openedAt = null;
    s.consecutiveFailures = 0;
    return false;
  }
  return true;
}

/**
 * Notifie un echec 429 (ou similaire quota). Si seuil atteint : ouvre le circuit.
 */
export function recordFailure(module: string, model: string, errorCode?: number): void {
  // On ne trip que sur 429 (rate limit/quota). Les 5xx sont transient.
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
 * Notifie un succes : reset le compteur d'echecs consecutifs.
 */
export function recordSuccess(module: string, model: string): void {
  const s = state.get(key(module, model));
  if (s) {
    s.consecutiveFailures = 0;
    s.openedAt = null;
  }
}

/** Reset manuel d'un circuit (ex : nouveau jour, quota refresh). */
export function resetCircuit(module?: string, model?: string): void {
  if (module && model) {
    state.delete(key(module, model));
  } else {
    state.clear();
  }
}

/** Snapshot pour diagnostic / UI. */
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
