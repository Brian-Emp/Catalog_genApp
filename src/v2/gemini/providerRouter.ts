/**
 * Provider router unifie : un seul point de bascule pour toute generation de
 * texte Gemini/Claude dans le pipeline V2.
 *
 * ORDRE (quality ET speed) : API REST (cascade de modeles, cf. client.ts) →
 *                            Claude CLI (dernier recours).
 *
 * POURQUOI :
 *  - API REST = la cascade multi-modeles (3.1-flash-lite → flash → … → Gemma)
 *    gere deja la diversite + le quota par-modele. Rapide (1-3s) et resilient.
 *  - CLI Gemini = ABANDONNE (lent 8-88s + aucune generation d'image) → retire.
 *  - Claude CLI = dernier recours (NB : auth expire → echec gracieux si invalide ;
 *    et no-op pour les callers sans workDir/projectDir requis par callClaudeFallback).
 *
 * Chaque provider qui echoue (quota, auth, indispo) fait basculer au suivant.
 * Le resultat indique quel provider a repondu (champ `provider`) + la trace
 * des tentatives (pour diagnostic).
 */

import { generateText, GEMINI_MODELS, isGeminiAvailable, isQuotaFailure, type GenerateTextResult } from './client';

export type ProviderName = 'api' | 'claude';
export type RoutePref = 'quality' | 'speed';

export interface RoutedTextOptions {
  prompt: string;
  /** 'quality' (default) = CLI Pro d'abord ; 'speed' = API flash-lite d'abord. */
  pref?: RoutePref;
  /** Label appelant pour stats/trace. */
  module?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** cwd pour le CLI (isole le contexte projet). */
  workDir?: string;
  /** Active le fallback Claude CLI en dernier recours. Default TRUE : le CLI
   *  Gemini est abandonne (lent 8-88s + pas d'image gen), Claude prend le role
   *  de filet qualite. NB : requiert une auth Claude valide (sinon echec
   *  gracieux). Mettre explicitement false pour desactiver. */
  enableClaudeFallback?: boolean;
  claudeBin?: string;
  projectDir?: string;
  /** Force l'ordre des providers (override pref). Utile pour les tests. */
  order?: ProviderName[];
}

export interface ProviderAttempt {
  provider: ProviderName;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** Skip = provider indisponible (pas de cle/token), pas tente. */
  skipped?: boolean;
}

export interface RoutedTextResult extends GenerateTextResult {
  /** Provider qui a finalement repondu, ou 'none' si tous ont echoue. */
  provider: ProviderName | 'none';
  attempts: ProviderAttempt[];
}

/**
 * Genere du texte en basculant entre providers jusqu'a succes.
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
        // En cas de quota flash-lite, l'API tente deja flash-lite seul ; pas de
        // fallback intra-API ici (le router gere la bascule inter-provider).
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

  // Tous les providers ont echoue
  const lastErr = [...attempts].reverse().find((a) => !a.skipped)?.error
    ?? attempts[attempts.length - 1]?.error
    ?? 'aucun provider disponible';
  return { ok: false, error: lastErr, provider: 'none', attempts };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Ordre des providers selon la preference. Exporte pour test.
 */
export function defaultOrder(_pref: RoutePref): ProviderName[] {
  // CLI Gemini ABANDONNE (lent 8-88s + aucune generation d'image) → retire de
  // la cascade. Tout passe par l'API (cascade de modeles, cf. client.ts) puis,
  // en dernier recours, le CLI CLAUDE (meilleure qualite de jugement). Meme
  // ordre pour 'quality' et 'speed' : la cascade API gere deja la diversite.
  return ['api', 'claude'];
}

/**
 * Fallback Claude CLI : --print texte simple. Best-effort ; l'auth Claude
 * peut etre expiree (401), auquel cas on retourne ok:false proprement.
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

// Re-export pour les callers qui veulent tester la nature d'une erreur.
export { isQuotaFailure };
