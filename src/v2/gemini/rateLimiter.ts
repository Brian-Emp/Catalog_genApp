/**
 * Rate-limiter PROACTIF par modele pour la cascade Gemini.
 *
 * La cascade gere deja le RPD (requetes/JOUR) de facon REACTIVE : un 429 quota
 * journalier fait basculer de modele. Mais le free tier limite AUSSI par MINUTE :
 *  - RPM  : requetes / minute
 *  - TPM  : tokens (input + output) / minute
 *
 * Sans garde, un burst de generations crame le RPM d'un modele → 429 → round-trip
 * inutile + throttle. Ce module track l'usage par modele sur une fenetre glissante
 * de 60 s et permet a la cascade de SKIPPER un modele AVANT de taper sa limite
 * minute (donc sans 429), en passant directement au modele suivant (pool distinct).
 *
 * Valeurs free tier (dashboard Google AI Studio, 2026-06). Faciles a ajuster ;
 * un modele inconnu retombe sur DEFAULT_LIMIT (conservateur).
 */

export interface ModelLimit {
  /** Requetes par minute. */
  rpm: number;
  /** Tokens (input+output) par minute. Infinity = pas de limite TPM. */
  tpm: number;
}

const LIMITS: Record<string, ModelLimit> = {
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000 },
  'gemini-2.5-flash-lite': { rpm: 10, tpm: 250_000 },
  'gemini-2.5-flash': { rpm: 5, tpm: 250_000 },
  'gemini-3.5-flash': { rpm: 5, tpm: 250_000 },
  'gemma-4-31b-it': { rpm: 15, tpm: Number.POSITIVE_INFINITY },
};

/** Modele non liste → limite conservatrice (evite de cramer un quota inconnu). */
const DEFAULT_LIMIT: ModelLimit = { rpm: 5, tpm: 250_000 };

const WINDOW_MS = 60_000;

/** Historique par modele : timestamp + tokens estimes de chaque appel recent. */
const usage = new Map<string, { ts: number; tokens: number }[]>();

export function getLimit(model: string): ModelLimit {
  return LIMITS[model] ?? DEFAULT_LIMIT;
}

/** Purge les entrees > 60 s et retourne la fenetre courante. */
function windowOf(model: string, now: number): { ts: number; tokens: number }[] {
  const arr = usage.get(model) ?? [];
  const fresh = arr.filter((e) => now - e.ts < WINDOW_MS);
  if (fresh.length !== arr.length) usage.set(model, fresh);
  return fresh;
}

/**
 * Le modele peut-il absorber un appel de ~estTokens tokens cette minute sans
 * depasser son RPM/TPM ? Si false : la cascade doit le skipper (le suivant a un
 * pool distinct).
 */
export function canUse(model: string, estTokens = 0): boolean {
  const lim = getLimit(model);
  const now = Date.now();
  const win = windowOf(model, now);
  if (win.length >= lim.rpm) return false; // RPM atteint cette minute
  if (lim.tpm !== Number.POSITIVE_INFINITY) {
    const tokens = win.reduce((s, e) => s + e.tokens, 0);
    if (tokens + estTokens > lim.tpm) return false; // TPM atteint
  }
  return true;
}

/** Enregistre un appel (envoye) pour ce modele : compte dans RPM + TPM. */
export function record(model: string, tokens: number): void {
  const now = Date.now();
  const win = windowOf(model, now);
  win.push({ ts: now, tokens: Math.max(0, tokens) });
  usage.set(model, win);
}

/** Snapshot pour diagnostic : usage RPM/TPM courant par modele. */
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
