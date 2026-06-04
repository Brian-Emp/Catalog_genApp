/**
 * Wrapper du CLI Gemini (`@google/gemini-cli`) pour le pipeline V2.
 *
 * POURQUOI un CLI en plus de l'API REST (client.ts) :
 *  - L'API free tier bloque gemini-2.5-pro (limit:0) et impose des rate limits
 *    serres (20 RPM flash).
 *  - Le CLI s'authentifie en OAuth "Login with Google" (Gemini Code Assist),
 *    ce qui exploite l'ABONNEMENT Gemini Pro de l'utilisateur : acces Pro +
 *    quotas bien plus larges, sans cle API payante.
 *
 * AUTH : le CLI lit l'auth via env GOOGLE_GENAI_USE_GCA=true (Google Code
 * Assist = OAuth perso). Le token est persiste dans ~/.gemini/ apres un
 * `gemini` interactif initial (login navigateur, une seule fois).
 *
 * MODE : -p/--prompt = headless non-interactif. -o json = sortie structuree.
 * On passe --approval-mode yolo car nos prompts ne demandent aucune action
 * fichier (pure generation de texte), donc rien a approuver.
 *
 * Contract : retourne un GenerateTextResult identique a client.ts pour swap
 * drop-in dans le provider router (providerRouter.ts).
 */

import { runBinary } from '../binaryRunner';
import type { GenerateTextResult } from './client';

export interface GeminiCliOptions {
  prompt: string;
  /** Modele. Default gemini-2.5-pro (dispo via abonnement OAuth). */
  model?: string;
  /** Timeout ms. Default 120s (le CLI a un cold start + thinking). */
  timeoutMs?: number;
  /** Path/nom du binaire. Default env GEMINI_BIN ou 'gemini'. */
  geminiBin?: string;
  /** cwd du process (isole le contexte projet du CLI). Default /tmp. */
  workDir?: string;
  /** Label appelant pour stats. */
  module?: string;
}

export const GEMINI_CLI_MODELS = {
  pro: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Detecte si le CLI Gemini est utilisable : binaire present + auth OAuth
 * persistee. Best-effort (verifie juste la presence du token).
 */
export async function isGeminiCliAvailable(geminiBin?: string): Promise<boolean> {
  const { promises: fs } = await import('fs');
  const os = await import('os');
  const path = await import('path');
  // Token OAuth GCA persiste apres login interactif.
  const candidates = [
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    path.join(os.homedir(), '.gemini', 'google_accounts.json'),
  ];
  for (const p of candidates) {
    try {
      const st = await fs.stat(p);
      if (st.size > 0) return true;
    } catch { /* continue */ }
  }
  return false;
}

/**
 * Lance le CLI Gemini sur un prompt. Retourne un GenerateTextResult.
 *
 * Le prompt est passe en argv (-p). spawn gere le quoting (array argv) donc
 * pas de probleme d'echappement meme avec du JSON dans le prompt.
 */
export async function callGeminiCli(opts: GeminiCliOptions): Promise<GenerateTextResult> {
  const bin = opts.geminiBin ?? process.env.GEMINI_BIN ?? 'gemini';
  const model = opts.model ?? GEMINI_CLI_MODELS.pro;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const { recordCall } = await import('./stats');
  const moduleLabel = opts.module ?? 'cli';

  const raw = await runBinary({
    bin,
    args: ['-o', 'json', '-m', model, '--approval-mode', 'yolo', '-p', opts.prompt],
    env: {
      // OAuth perso (Gemini Code Assist) = exploite l'abonnement Pro.
      GOOGLE_GENAI_USE_GCA: 'true',
      // Sans ça le CLI refuse de tourner en headless hors "trusted folder"
      // (il attend une confirmation interactive impossible en pipeline).
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    },
    cwd: opts.workDir ?? '/tmp',
    timeoutMs,
  });

  if (raw.timedOut) {
    recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'retry_exhausted', durationMs: raw.durationMs });
    return { ok: false, error: `gemini CLI timeout (${timeoutMs}ms)` };
  }
  if (!raw.stdout || raw.stdout.trim().length === 0) {
    recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'error', durationMs: raw.durationMs });
    const errSnippet = raw.stderr?.slice(0, 300) || `exit ${raw.exitCode ?? '?'}`;
    return { ok: false, error: `gemini CLI sans output : ${errSnippet}` };
  }

  const text = extractCliText(raw.stdout);
  if (text === null) {
    recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'error', durationMs: raw.durationMs });
    return { ok: false, error: `gemini CLI output non parseable : ${raw.stdout.slice(0, 200)}` };
  }

  recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'ok', durationMs: Date.now() - t0 });
  return { ok: true, text };
}

export interface GeminiCliVisionOptions {
  prompt: string;
  /** Chemins ABSOLUS des images (PNG) a analyser. Passes au CLI via @path. */
  imagePaths: string[];
  /** Default gemini-2.5-pro (raisonnement Vision profond, dispo via abonnement). */
  model?: string;
  /** Timeout ms. Default 180s (Vision multi-image Pro = lent). */
  timeoutMs?: number;
  geminiBin?: string;
  workDir?: string;
  module?: string;
}

/**
 * Analyse Vision multi-image via le CLI Gemini (Pro). Les images sont
 * referencees par @chemin dans le prompt (le CLI les lit depuis le disque).
 * Reutilise callGeminiCli : meme auth OAuth, meme parsing.
 *
 * Cas d'usage : audit de coherence cross-page (rôle H) ou` Pro apporte un vrai
 * raisonnement vs flash. Le free tier API bloque Pro (limit:0), le CLI le
 * debloque via l'abonnement.
 */
export async function callGeminiCliVision(opts: GeminiCliVisionOptions): Promise<GenerateTextResult> {
  if (opts.imagePaths.length === 0) {
    return { ok: false, error: 'callGeminiCliVision : aucune image' };
  }
  const refs = opts.imagePaths.map((p) => `@${p}`).join(' ');
  return callGeminiCli({
    prompt: `${refs}\n\n${opts.prompt}`,
    model: opts.model ?? GEMINI_CLI_MODELS.pro,
    timeoutMs: opts.timeoutMs ?? 180_000,
    geminiBin: opts.geminiBin,
    workDir: opts.workDir,
    module: opts.module ?? 'cliVision',
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extrait le texte de reponse du stdout CLI. Le format -o json du gemini CLI
 * encapsule la reponse ; on tente plusieurs cles connues, puis fallback texte
 * brut. Retourne null si vraiment rien d'exploitable.
 *
 * Exporte pour test unitaire.
 */
export function extractCliText(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // 1. Tenter JSON structure
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    // Cles connues du gemini CLI selon version : response / result / text /
    // content. On prend la 1ere string non-vide.
    for (const key of ['response', 'result', 'text', 'content', 'output']) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    // Parfois { stats, response } imbrique, ou un message direct.
    if (typeof parsed.message === 'string') return parsed.message.trim();
  } catch {
    // pas du JSON : c'est probablement du texte brut (output-format text)
    return trimmed;
  }
  // JSON parse OK mais aucune cle texte connue → renvoyer le JSON brut
  // (le caller parsera avec parseGeminiJson si besoin).
  return trimmed;
}
