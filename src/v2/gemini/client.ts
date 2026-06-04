/**
 * Client Gemini bas-niveau : wrapper fetch() autour de l'API REST Google AI.
 *
 * Pas de dependance npm @google/genai : on utilise directement fetch() pour
 * minimiser la surface (pas de breaking change SDK, pas de bloat). Suffisant
 * pour les 4 cas d'usage (text, vision, image gen).
 *
 * Auth : la cle est lue depuis :
 *   1. process.env.GEMINI_API_KEY (si defini directement)
 *   2. process.env.GEMINI_KEY_FILE (path d'un fichier contenant la cle)
 *   3. ~/.gemini.key (fallback host)
 *
 * Si aucune cle trouvee, isGeminiAvailable() retourne false et les modules
 * gemini-* doivent skip leur logique (no-op gracieux).
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let cachedKey: string | null | undefined;

/** Resout la cle Gemini depuis env vars / fichier / fallback home. Cache
 *  le resultat (null = pas trouvee, string = trouvee). */
export async function resolveGeminiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  // 1. Env direct
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
      // path n'existe pas, on continue
    }
  }
  cachedKey = null;
  return null;
}

export async function isGeminiAvailable(): Promise<boolean> {
  return (await resolveGeminiKey()) !== null;
}

/** Reset le cache (utile pour les tests). */
export function clearGeminiKeyCache(): void {
  cachedKey = undefined;
}

// ─── Models constants ───────────────────────────────────────────────────────
export const GEMINI_MODELS = {
  /** Multimodal text/vision rapide, cheaper. Rate limit free : 15 RPM. */
  flash: 'gemini-2.5-flash',
  /** Variante allegee de flash, sans thinking budget. Plus rapide + rate
   *  limit free plus genereux (~30 RPM). Ideal pour mapping / descriptions
   *  / appels courts. */
  flashLite: 'gemini-2.5-flash-lite',
  /** Multimodal text/vision premium (context 1M, raisonnement profond). */
  pro: 'gemini-2.5-pro',
  /** Generation d'images ("Nano Banana"). Payant only sur free tier. */
  image: 'gemini-2.5-flash-image',
  /** Pools de quota free-tier INDEPENDANTS (RPD journalier separe PAR MODELE).
   *  Relais de cascade quand le quota 2.5 (20 RPD/jour seulement !) est epuise.
   *  NB : la famille 2.0 est a 0 RPD sur ce tier (INUTILE) → on prend 3.x +
   *  Gemma qui ont du budget. Verifie empiriquement (dashboard + appels reels). */
  flash31Lite: 'gemini-3.1-flash-lite',
  flash35: 'gemini-3.5-flash',
  gemma: 'gemma-4-31b-it',
} as const;

/** Cascade par defaut TEXTE : le free tier limite les requetes PAR MODELE
 *  (RPD/jour + RPM/min). On epuise un modele puis on bascule au suivant, qui a
 *  son propre pool. Ordre : le plus permissif/economique d'abord. */
// Ordre = QUALITE DECROISSANTE : on commence TOUJOURS par les meilleurs modeles
// (sortie plus riche : audit + descriptions). Les lite/Gemma ne servent que de
// FALLBACK quand les modeles pleins ont epuise leur quota du jour. RPD free-tier
// reels (dashboard AI Studio) :
//   3.5-flash=20 · 2.5-flash=20 · 3.1-flash-lite=500 · 2.5-flash-lite=20 · gemma=1500
// (2.0 et Pro = 0, exclus). Donc : pleins (3.5/2.5-flash) en tete pour la qualite,
// puis 3.1-flash-lite (500/j, gros filet quand les 20/j sont cuits), puis Gemma.
export const TEXT_CASCADE: string[] = [
  GEMINI_MODELS.flash35,     // 3.5 flash (plein) — MEILLEUR, toujours en tete
  GEMINI_MODELS.flash,       // 2.5 flash (plein)
  GEMINI_MODELS.flash31Lite, // 3.1 flash-lite (500/j) — gros filet budget
  GEMINI_MODELS.flashLite,   // 2.5 flash-lite (20/j)
  GEMINI_MODELS.gemma,       // Gemma 4 (1500/j) — reserve profonde (qualite moindre)
];
/** Cascade VISION : modeles multimodaux VERIFIES "acceptent une image", meme
 *  logique QUALITE d'abord. */
export const VISION_CASCADE: string[] = [
  GEMINI_MODELS.flash35,     // 3.5 flash — MEILLEUR
  GEMINI_MODELS.flash,       // 2.5 flash
  GEMINI_MODELS.flash31Lite, // 3.1 flash-lite (500/j) — gros filet
  GEMINI_MODELS.flashLite,   // 2.5 flash-lite
];

/** Liste de modeles a essayer : le(s) modele(s) explicite(s) du caller
 *  d'abord, puis le reste de la cascade (dedupe, ordre preserve). */
function buildCascade(primary: string, fallback: string | undefined, base: string[]): string[] {
  // `base` est ordonnee par QUALITE (meilleurs modeles d'abord) → AUTORITAIRE.
  // Le modele/fallback explicite du caller est garanti present mais NE passe PAS
  // devant la cascade (sinon un caller forcant un modele precis court-circuiterait
  // la qualite). Ajoute en fin uniquement s'il manque de la cascade.
  const out = [...base];
  for (const m of [primary, fallback]) {
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Estime grossierement les tokens d'une requete (input + output) pour le
 *  rate-limiter TPM. ~4 chars/token ; image inline ~300 tokens ; output =
 *  maxOutputTokens annonce. Approximatif mais suffisant pour ne pas exploser le
 *  TPM (250K/min) — c'est surtout le RPM (5-15/min) qui borde. */
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

/** Essaie chaque modele de la cascade. Avance au suivant UNIQUEMENT sur echec
 *  quota (429 / rate-limit / circuit ouvert) — chaque modele ayant son propre
 *  pool free-tier. Sur erreur NON-quota (auth, bad request) on s'arrete (inutile
 *  de cascader). Retourne le 1er succes (marque usedFallback si pas le 1er), ou
 *  le dernier echec. */
async function callWithCascade(
  models: string[],
  body: GeminiGenerateRequest,
  key: string,
  module: string,
): Promise<GenerateTextResult> {
  const cb = await import('./circuitBreaker');
  const rl = await import('./rateLimiter');
  // Court-circuit : si une cascade complete a echoue sur quota tres recemment
  // (<45s), tous les modeles sont morts → fail immediat sans re-tenter les N.
  // Evite de gaspiller du temps sur chaque tache auxiliaire quand le quota est
  // globalement epuise.
  if (cb.isQuotaCold()) {
    return { ok: false, error: 'quota Gemini froid (cascade court-circuitee, retest auto <45s)' };
  }
  const estTokens = estimateRequestTokens(body);
  let last: GenerateTextResult = { ok: false, error: 'cascade vide' };
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    // CIRCUIT OUVERT : ce (module, modele) a pris 3x429 recemment → on SKIP
    // AVANT toute reservation rate-limit. Sinon on consomme un slot RPM/TPM pour
    // un appel qui ne partira pas (callGenerate fail-fast sur circuit ouvert),
    // ce qui ronge le budget par-minute du modele PARTAGE par les autres modules.
    if (cb.isCircuitOpen(module, model)) {
      last = { ok: false, error: `${model}: circuit ouvert (quota recent, retest <5min)` };
      continue;
    }
    // RATE-LIMIT PROACTIF (par minute) : si le modele a deja atteint son RPM ou
    // TPM sur la fenetre 60s, on SKIP directement au suivant (pool distinct) —
    // evite un 429 garanti + son round-trip. Le RPD (jour) reste gere reactif
    // par le 429 quota ci-dessous.
    if (!rl.canUse(model, estTokens)) {
      last = { ok: false, error: `${model}: limite par-minute (RPM/TPM) atteinte` };
      continue;
    }
    // RESERVE le slot RPM/TPM AVANT l'appel (anti-race : 2 generations
    // concurrentes ne passent pas toutes canUse avant qu'aucune n'ait compte).
    rl.record(model, estTokens);
    // maxRetryDelayMs=0 : sur 429 on NE dort PAS sur le modele courant (son
    // retry-in annonce est trompeur — un quota journalier peut afficher "2s").
    // On bascule immediatement au modele suivant (pool independant). Le retry
    // 5xx (backoff exponentiel) reste actif, lui (transient reseau != quota).
    const res = await callGenerate(model, body, key, module, 0, i > 0);
    if (res.ok) return i > 0 ? { ...res, usedFallback: true } : res;
    last = res;
    // On CONTINUE la cascade sur echec QUOTA (429/rate-limit), modele indispo
    // (404/not-found : un modele exotique non provisionne ce jour ne doit pas
    // tuer la gen) OU surcharge serveur transitoire (5xx / "high demand" : un
    // autre modele a un backend distinct et peut repondre). Sur une vraie
    // erreur (400 bad-request, auth) on s'arrete (cascader ne sert a rien).
    if (!isQuotaFailure(res.error) && !isModelUnavailable(res.error) && !isServerOverloaded(res.error)) {
      return res;
    }
  }
  // Toute la cascade a echoue. markQuotaCold UNIQUEMENT si (a) c'etait une vraie
  // cascade multi-modeles — une sonde noCascade (ex health, 1 modele) ne peut PAS
  // conclure que TOUS les modeles sont cuits, elle ne doit pas empoisonner le
  // flag global — ET (b) l'echec final est un quota (pas un 5xx transitoire).
  if (models.length > 1 && isQuotaFailure(last.error)) cb.markQuotaCold();
  return last;
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Timeout dur par requete HTTP. Node `fetch` n'a AUCUN timeout par defaut : une
// connexion qui hang (modele surcharge, proxy muet) bloquerait l'await
// indefiniment. 15s : un appel Gemini flash/lite sain repond en 1-5s ; au-dela
// = modele lent/qui hang → on abort et (en cascade) on bascule au suivant.
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
   * Cap max sur le delai de retry 429 honore. Default 90s.
   * Pour des calls "vite ou rien" (health, UI) : passer ~5000 pour fail-fast.
   */
  maxRetryDelayMs?: number;
  /**
   * Modele de fallback tente si l'appel principal echoue avec 429 exhausted
   * ou circuit ouvert. Ex : model='gemini-2.5-flash', fallbackModel='gemini-2.5-flash-lite'.
   * Si fallback reussit : on continue. Si fallback fail aussi : on retourne l'erreur du main.
   */
  fallbackModel?: string;
}

export interface GenerateTextResult {
  ok: boolean;
  text?: string;
  finishReason?: string;
  error?: string;
  /** True si la reponse vient du fallbackModel (degradation). */
  usedFallback?: boolean;
}

export interface GenerateTextOptionsExt extends GenerateTextOptions {
  /** Label appelant pour le tracking stats (ex 'descriptions', 'specMapping'). */
  module?: string;
  /** Si true : N'UTILISE PAS la cascade — sonde UNIQUEMENT le modele demande
   *  (pas de fan-out sur les autres). Pour le health check : 1 sonde rapide d'un
   *  modele fiable, sans traverser des modeles 20/j potentiellement cuits. */
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
  // Cascade : modele explicite + fallback du caller, puis la cascade texte par
  // defaut. On bascule de modele sur quota epuise (chaque modele = pool free
  // tier independant). noCascade → on sonde uniquement `model` (health check).
  const cascade = opts.noCascade ? [model] : buildCascade(model, opts.fallbackModel, TEXT_CASCADE);
  return callWithCascade(cascade, body, key, opts.module ?? 'unknown');
}

// ─── Vision (analyse image) ─────────────────────────────────────────────────

export interface AnalyzeImageOptions {
  prompt: string;
  imageBytes: Buffer;
  mimeType?: string;
  model?: string;
  /** Label appelant pour stats. */
  module?: string;
  /** Cap retry 429 ms (default 90s). */
  maxRetryDelayMs?: number;
  /** Modele degradation si main fail sur quota. Ex flash → flashLite. */
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
  /** Label optionnel (ex "page 5") ajoute en text avant l'image dans le prompt. */
  label?: string;
}

export interface AnalyzeMultiImageOptions {
  prompt: string;
  images: MultiImageInput[];
  model?: string;
  temperature?: number;
  module?: string;
  maxRetryDelayMs?: number;
  /** Modele degradation si main fail sur quota (ex pro → flash). */
  fallbackModel?: string;
}

/**
 * Envoie plusieurs images en UNE seule requete Gemini pour analyse globale.
 * Cas d'usage : coherence catalogue, comparaison cross-pages, detection de
 * variations subtiles entre pages similaires.
 *
 * Le prompt est envoye en premier, puis chaque image precedee de son label
 * (si fourni). Context 1M tokens = supporte 20-30 images haute qualite.
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
  // Lazy import pour eviter cycle (stats.ts est leaf)
  const { recordCall } = await import('./stats');
  const cb = await import('./circuitBreaker');
  // Si le circuit est ouvert pour ce (module, model) : fail-fast.
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
  // Retry sur 5xx/429 (transient / rate limit). 3 essais max.
  // Pour 429 : on parse le "retry in Xs" annonce par Gemini (precis) et on
  // respecte ce delai si <= maxRetryDelayMs. Au-dela = quota daily probable
  // → fail fast pour laisser l'orchestrator skip.
  const RETRY_CODES = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  // Fail-fast : si un 429 annonce un retry > ce cap, c'est un quota daily mort
  // → abandon immediat (pas de sieste). Defaut bas (8s) pour ne JAMAIS bloquer
  // une generation des minutes sur une tache auxiliaire. Les rate-limits courts
  // (<8s, par-minute) restent retentes normalement.
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
          // 429 : parser le retry_in annonce par Gemini si dispo
          const apiDelayMs = json.error.code === 429
            ? parseRetryDelayMs(json.error.message)
            : null;
          // FAIL-FAST 429 : si PAS de delai annonce (null — Gemini ne l'annonce
          // pas toujours) OU delai > cap → on n'attend PAS et on ne retente PAS
          // le meme modele (quota probable). Un null NE doit PAS declencher un
          // retry aveugle 3x : la cascade bascule de modele a la place. (Le 5xx
          // n'est pas concerne : code!==429 → backoff exponentiel plus bas.)
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
          // Same-model retry UNIQUEMENT en mode non-cascade (cap>0, ex health).
          // En CASCADE (cap=0) on ne retente JAMAIS le meme modele (429 ou 5xx
          // transient inclus) : un modele lent/surcharge ne se repare pas en le
          // re-tapant → on tombe sur le return fail ci-dessous et la cascade
          // bascule au modele suivant. Evite de bloquer 3x sur un modele mort.
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
      // Inclut l'AbortError du timeout fetch (modele qui hang). En cascade
      // (cap=0) on NE retente PAS (un modele qui hang ne se repare pas) → on
      // sort et la cascade bascule. En non-cascade (cap>0) on retente (blip reseau).
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
 * Detecte si une erreur callGenerate est due au quota Gemini (429 / circuit open).
 * Utilise par le fallback : on degrade SEULEMENT sur quota, pas sur les autres
 * erreurs (auth fail, network, mauvais request → pas de fallback utile).
 *
 * Exporte pour test unitaire.
 */
export function isQuotaFailure(error: string | undefined): boolean {
  if (!error) return false;
  // `429` doit etre un nombre isole : pas colle a une lettre NI a un chiffre
  // (sinon "500: code 4290" matcherait a tort). Lookarounds [a-z0-9].
  return /(?<![a-z0-9])429(?![a-z0-9])|quota|rate.?limit|circuit ouvert/i.test(error);
}

/**
 * Detecte une erreur "modele indisponible" (404 / not found / not supported) :
 * un modele exotique de la cascade non provisionne ce jour. La cascade doit
 * SKIPPER ce modele et continuer (vs s'arreter comme sur un vrai bad-request).
 */
export function isModelUnavailable(error: string | undefined): boolean {
  if (!error) return false;
  return /(?<![0-9])404(?![0-9])|not found|not supported|not available|does not exist|unavailable/i.test(error);
}

/**
 * Detecte une surcharge serveur TRANSITOIRE (500/502/503/504, "high demand",
 * "overloaded", "try again later"). La cascade doit BASCULER au modele suivant
 * (backend distinct) au lieu d'abandonner : un 503 sur 3.5-flash ne dit rien de
 * la dispo de 2.5-flash. NB : ne trip PAS le circuit breaker (transient, pas
 * quota). Exporte pour test.
 */
export function isServerOverloaded(error: string | undefined): boolean {
  if (!error) return false;
  return /(?<![0-9])(500|502|503|504)(?![0-9])|overload|high demand|experiencing high|try again later|temporarily unavailable|internal error/i.test(error);
}

/**
 * Parse "Please retry in 53.55s." dans un message d'erreur Gemini 429.
 * Retourne le delai en ms, ou null si pas parse.
 * Cap a 5 min (300_000ms) pour eviter des sleeps absurdes.
 *
 * Exporte pour test unitaire.
 */
export function parseRetryDelayMs(message: string): number | null {
  // "Please retry in 53.553775854s." ou "retry in 1m23s" (rare)
  const m = message.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!m) return null;
  const seconds = parseFloat(m[1]);
  if (!isFinite(seconds) || seconds <= 0) return null;
  // Cap a 5 min
  return Math.min(Math.round(seconds * 1000), 300_000);
}
