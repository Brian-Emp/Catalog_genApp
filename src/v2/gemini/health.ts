/**
 * Health check Gemini : verifie la presence de la cle, l'accessibilite de
 * l'API et le statut du quota par un appel minimal (1 token).
 *
 * Utilise pour :
 *  - badge UI "Gemini OK / KO / quota"
 *  - log de demarrage pipeline (warning si KO)
 *  - tests E2E precondition
 */

import { generateText, GEMINI_MODELS, isGeminiAvailable, resolveGeminiKey } from './client';

export type GeminiHealthStatus = 'ok' | 'no_key' | 'quota_exceeded' | 'auth_error' | 'network_error' | 'unknown';

export interface GeminiHealthResult {
  status: GeminiHealthStatus;
  /** True si on peut appeler Gemini (status === 'ok'). */
  ok: boolean;
  /** Modele teste. */
  model: string;
  /** Latence du test (ms). */
  durationMs: number;
  /** Message d'erreur si KO. */
  error?: string;
  /** Hint pour fix (instruction utilisateur). */
  hint?: string;
}

/**
 * Run un health check Gemini. Appel minimal (1 prompt court, 1 token max).
 * Coût : negligeable. Timeout intrinseque a fetch (par defaut).
 *
 * Si check OK : retourne { ok:true }. Si KO : indique la nature de l'erreur
 * + un hint utilisateur.
 */
export async function checkGeminiHealth(): Promise<GeminiHealthResult> {
  const t0 = Date.now();
  // Health = sonde 1 SEUL modele fiable (noCascade), PAS la cascade qualite :
  // sinon on traverserait les modeles pleins 20/j (souvent cuits) → lent. On
  // sonde 3.1-flash-lite (gros buffer 500/j, quasi toujours dispo) → reponse
  // rapide + representative de "Gemini joignable ?". S'il est KO, Gemini l'est
  // vraiment (le gros filet est tombe).
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
    // Min 32 : gemini-2.5-flash inclut un "thinking" budget interne avant
    // l'output, donc maxOutputTokens=1 coupe avant le moindre token visible
    // (finishReason=MAX_TOKENS sans text).
    maxOutputTokens: 32,
    module: 'health',
    // Sonde 1 seul modele (pas de fan-out cascade) → rapide + predictible.
    noCascade: true,
    // Fast-fail : 4s cap, sinon le badge UI freeze. Si quota epuise, on
    // veut savoir vite (quota_exceeded), pas attendre 53s pour retry.
    maxRetryDelayMs: 4000,
  });
  const durationMs = Date.now() - t0;

  if (res.ok) {
    return { status: 'ok', ok: true, model, durationMs };
  }

  // Identification fine du type d'erreur
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
 * Variante sans appel API : verifie SEULEMENT la presence de la cle.
 * Utile pour gate-keeping rapide (1ms) avant de tenter un audit.
 */
export async function quickCheckGeminiKey(): Promise<{ ok: boolean; keyPresent: boolean }> {
  const key = await resolveGeminiKey();
  const keyPresent = key !== null;
  return { ok: keyPresent, keyPresent };
}
