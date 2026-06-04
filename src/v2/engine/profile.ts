/**
 * TemplateProfile : profil typographique et geometrique d'un template PDF.
 *
 * Port TS de la dataclass TemplateProfile + auto_detect_template() du moteur
 * V1 (python/substitute.py). Sert au pipeline V2 (blockDetector, substitutor)
 * pour identifier les fiches produit dans n'importe quel template sans
 * heuristiques figees ni hardcodes par template.
 *
 * Strategie de detection :
 *  1. Heuristique pure (detectProfileHeuristic) : echantillonne les spans,
 *     trouve le pattern font le plus probable pour nom/cle/valeur. Marche
 *     sur les templates conventionnels (poids typo nommes SemiBold/Medium/etc).
 *  2. Fallback Claude (detectProfileClaude) : si l'heuristique retourne
 *     defaults (= incertaine), on demande a Claude d'analyser un echantillon
 *     et de produire le profil. Generalise aux templates exotiques.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import type { ExtractedPage, TextSpan } from '../types';
import { hasKeyValueSeparator } from './keyValueSeparator';

// ─── Type ────────────────────────────────────────────────────────────────────

export interface TemplateProfile {
  // === Typo ===
  /** Substring qu'on cherche dans le font name pour identifier le span "nom produit". */
  nameFontPattern: string;
  /** Plage de taille (pt) pour qu'un span soit candidat "nom". */
  nameSizeRange: [number, number];
  /** Taille minimale absolue pour qu'un span soit candidat "nom" (sous laquelle on rejette). */
  nameMinSize: number;
  /** Substring du font name pour le span "cle de spec" (ex "MECANISME:"). */
  keyFontPattern: string;
  /** Taille (pt) typique des cles. */
  keySize: number;
  /** Substring du font name pour les valeurs de specs. */
  valueFontPattern: string;
  /** Taille (pt) typique des valeurs. */
  valueSize: number;
  /** Substring font pour la ref produit (souvent Regular avec digit). */
  headerRefFontPattern: string;
  /** Substring font pour la couleur principale (souvent Medium sans digit). */
  headerColorFontPattern: string;

  // === Geometrie ===
  /** X max pour qu'un span soit candidat "nom" (a gauche de la page). */
  nameXMax: number;
  /** X min a partir duquel commence la colonne des specs. */
  specsXMin: number;
  /** Hauteur de ligne typique (pt). */
  lineHeight: number;

  // === Bornes blocs ===
  /** Gap Y entre 2 blocs produit verticaux (pt). */
  blockYGap: number;
  /** Marge Y depuis le bas de page pour le dernier bloc produit (pt). */
  blockLastBottomMargin: number;
  /** Hauteur de la zone header (sous le nom : ref + color). */
  blockHeaderZoneHeight: number;
  /** Ratio multiplicateur de name_size pour la zone header adaptive. */
  blockHeaderZoneSizeRatio: number;
  /** Offset Y depuis le bas du header pour commencer la zone variantes. */
  blockHeaderExcludeYOffset: number;

  // === Color / Ref ===
  /** Plage de taille pour spans color/ref. */
  colorRefSizeRange: [number, number];
  /** Espacement horizontal entre color et ref (pt). */
  colorRefSpacing: number;

  // === Variantes ===
  /** Plage taille des vignettes carrees de variantes couleur. */
  variantCircleSizeRange: [number, number];
  /** Ratio w/h pour considerer une bbox "carree". */
  squareRatioRange: [number, number];
  /** Plage taille des pictos (NF, made in France...) — a EXCLURE des variantes. */
  pictoSizeRange: [number, number];

  // === Tolerances merge nom (wrapping multi-ligne) ===
  nameMergeXTolerance: number;
  nameMergeYTolerance: number;
  nameMergeSizeTolerance: number;

  // === Tolerances specs ===
  specInlineYTolerance: number;
  specInlineXTolerance: number;
  specContinuationYExtra: number;
  specContinuationXTolerance: number;

  // === Banner / Ribbon ===
  bannerMinSize: number;
  /** Marge droite : zone d'erase specs s'arrete a (pageWidth - ribbonMargin)
   *  pour preserver les rubans verticaux de droite (section ribbon, page
   *  number, etc.). Le nom est legacy (V1) ; ça signifie "right margin". */
  ribbonMargin: number;

  // === Provenance ===
  source: 'heuristic' | 'claude' | 'fallback';
}

export const DEFAULT_PROFILE: TemplateProfile = {
  nameFontPattern: 'SemiBold',
  nameSizeRange: [14.0, 18.0],
  nameMinSize: 13.0,
  keyFontPattern: 'Medium',
  keySize: 11.0,
  valueFontPattern: 'Light',
  valueSize: 11.0,
  headerRefFontPattern: 'Regular',
  headerColorFontPattern: 'Medium',

  nameXMax: 250.0,
  specsXMin: 280.0,
  lineHeight: 13.0,

  blockYGap: 5.0,
  blockLastBottomMargin: 50.0,
  blockHeaderZoneHeight: 30.0,
  blockHeaderZoneSizeRatio: 2.5,
  blockHeaderExcludeYOffset: 4.0,

  colorRefSizeRange: [11.0, 13.0],
  colorRefSpacing: 6.0,

  variantCircleSizeRange: [15.0, 30.0],
  squareRatioRange: [0.7, 1.4],
  pictoSizeRange: [15.0, 60.0],

  nameMergeXTolerance: 8.0,
  nameMergeYTolerance: 8.0,
  nameMergeSizeTolerance: 1.0,

  specInlineYTolerance: 3.0,
  specInlineXTolerance: 1.0,
  specContinuationYExtra: 2.0,
  specContinuationXTolerance: 5.0,

  bannerMinSize: 14.0,
  ribbonMargin: 30.0,

  source: 'fallback',
};

// ─── Constantes de detection ─────────────────────────────────────────────────

/** Patterns de font à chercher dans le nom du fichier font pour identifier
 *  un texte "fort" (= nom produit, généralement le plus gros à gauche).
 *
 *  Listes étendues :
 *   - EN : SemiBold, Bold, Black, Heavy, Demibold, ExtraBold, UltraBold
 *   - FR : Gras, Demi-Gras
 *   - DE : Fett, Halbfett
 *   - ES : Negrita
 *   - PostScript weight names : 700, 800, 900 (sometimes embedded in font name)
 *   - Display fonts often used in titles : Display, Title, Headline, Heading
 *
 *  Match par substring insensible casse via .includes() côté caller. */
const DETECT_NAME_FONT_CANDIDATES = [
  // EN poids gras
  'SemiBold', 'Semibold', 'Semi-Bold',
  'Bold',
  'Black', 'Heavy',
  'Demibold', 'DemiBold', 'Demi-Bold', 'Demi',
  'ExtraBold', 'Extra-Bold', 'UltraBold', 'Ultra-Bold',
  'Extra',
  // FR
  'Gras', 'Demi-Gras', 'DemiGras',
  // DE
  'Fett', 'Halbfett',
  // ES
  'Negrita',
  // PostScript weight (numeric)
  '700', '800', '900',
  // Display / Title fonts (souvent utilisées pour les titres produit)
  'Display', 'Headline', 'Heading', 'Title',
];
const NAME_ZONE_GUESS_RATIO = 0.45;
const SPECS_ZONE_GUESS_RATIO = 0.4;
const LINE_HEIGHT_RATIO = 1.18;
const AUTO_DETECT_SIZE_PADDING = 1.0;
const DETECT_NAME_SIZE_MAX_CLAMP = 24.0;
const DETECT_SPECS_X_OFFSET = 4.0;
const DETECT_NAME_X_MARGIN = 10.0;
const DETECT_NAME_X_FACTOR = 0.9;
/** Seuil minimum de candidats (keys de specs OU spans de nom) pour
 *  considerer qu'une page est une "fiche produit standard" exploitable
 *  pour la detection de profil typo. 3 = compromis entre :
 *   - eviter les pages a 1-2 specs (intercalaires/cover faussement product)
 *   - accepter les fiches avec peu de specs (vue compact / produit simple).
 *  Audit mineur : factorise depuis 4 occurrences inline. */
const MIN_KEY_CANDIDATES = 3;

// ─── Heuristique pure (port V1 auto_detect_template) ────────────────────────

/**
 * Detecte le profil d'un template via heuristique pure sur les raw_spans
 * d'une (ou plusieurs) page(s) d'echantillon. Equivalent du V1
 * auto_detect_template() en Python.
 *
 * On echantillonne plusieurs pages et on prend la 1ere qui produit un
 * pattern de nom convaincant (>= 3 candidats). Sinon on retombe sur defaults.
 */
export function detectProfileHeuristic(pages: ExtractedPage[]): TemplateProfile {
  // Echantillon large : on cherche une page "fiche produit standard" (avec
  // spec keys ":" + noms gros a gauche). Les intercalaires/sommaires sont
  // skip puisqu'ils n'ont pas de keys.
  const candidates = pickSamplePages(pages, 12);

  // 1. Collecter TOUS les profils valides parmi les pages d'échantillon.
  // Sur catalogue homogène (Catalogue A, Catalogue E), tous les profils sont équivalents
  // → on prend le premier. Sur catalogue hétérogène (Catalogue C = certaines
  // pages tabulaires multi-cols + autres verticales), on préfère le
  // profil avec le nameXMax le plus grand (= tabulaire détecté), qui
  // couvre les deux layouts (zone élargie n'empêche pas de matcher noms
  // étroits).
  const allProfiles: TemplateProfile[] = [];
  for (const page of candidates) {
    const spans = page.raw_spans;
    if (!spans || spans.length < 5) continue;
    const profile = detectFromPage(page, spans);
    if (profile) allProfiles.push(profile);
  }
  if (allProfiles.length > 0) {
    // Préférer le profil avec nameXMax le plus grand (= profil tabulaire
    // s'il existe, sinon n'importe quel profil vertical équivalent).
    //
    // Validation anti-outlier : si UN seul profil "extra-large" se distingue
    // (>= 90% pageW alors que les autres sont a 50-60% pageW), c'est suspect
    // (page d'index, footer table, watermark) → on l'ignore et on prend la
    // majorité. Seuil : best > 1.5x median ET best est isolé (1 seul profil
    // dans la fourchette top).
    if (allProfiles.length >= 3) {
      const xMaxValues = allProfiles.map((p) => p.nameXMax).sort((a, b) => a - b);
      const median = xMaxValues[Math.floor(xMaxValues.length / 2)];
      const topCandidate = allProfiles.reduce((a, b) =>
        b.nameXMax > a.nameXMax ? b : a,
      );
      // Combien de profils sont "proches" du top (>= 90% de son nameXMax) ?
      const closeToTop = allProfiles.filter(
        (p) => p.nameXMax >= topCandidate.nameXMax * 0.9,
      ).length;
      if (topCandidate.nameXMax > median * 1.5 && closeToTop === 1) {
        // Outlier détecté : on rejette le top et on prend le 2e meilleur.
        const filtered = allProfiles.filter((p) => p !== topCandidate);
        const best = filtered.reduce((a, b) =>
          b.nameXMax > a.nameXMax ? b : a,
        );
        return best;
      }
    }
    const best = allProfiles.reduce((a, b) =>
      b.nameXMax > a.nameXMax ? b : a,
    );
    return best;
  }

  // 2. Fallback : aggregation multi-pages. Couvre les templates ou aucune
  // page seule n'a >= 3 keyCandidates (typiquement : 1-2 fiches produit par
  // page, beaucoup de pages d'identite/intercalaires). On agrège les spans
  // de toutes les pages echantillonnees pour atteindre le seuil et detecter
  // un pattern global.
  const aggregatedSpans: TextSpan[] = [];
  for (const page of candidates) {
    if (page.raw_spans) aggregatedSpans.push(...page.raw_spans);
  }
  if (aggregatedSpans.length >= 5 && candidates.length > 0) {
    // Page virtuelle : meme dimensions que la 1ere candidate (les ratios
    // bbox sont relatifs au pageW). On choisit la page avec le plus grand
    // pageW pour ne pas filtrer trop aggressivement par nameZoneGuess.
    const refPage = candidates.reduce((a, b) =>
      a.page_size.width >= b.page_size.width ? a : b,
    );
    const virtualPage: ExtractedPage = {
      page_number: -1,
      page_size: refPage.page_size,
      slots: [],
      raw_spans: aggregatedSpans,
      raw_images: [],
    };
    const profile = detectFromPage(virtualPage, aggregatedSpans);
    if (profile) return profile;
  }

  // 3. Pas de pattern trouve meme aggrege : retour defaults.
  // Le caller peut alors basculer sur detectProfileClaude.
  return { ...DEFAULT_PROFILE };
}

function detectFromPage(page: ExtractedPage, spans: TextSpan[]): TemplateProfile | null {
  const pageW = page.page_size.width;
  const nameZoneGuess = pageW * NAME_ZONE_GUESS_RATIO;
  const specsZoneGuess = pageW * SPECS_ZONE_GUESS_RATIO;

  // Detection cles (spans contenant ":" a droite de la page). Si moins de
  // MIN_KEY_CANDIDATES keys, ce n'est pas une page "fiche produit" — on
  // skip. Filtre essentiel pour eviter de prendre une page sommaire/
  // intercalaire comme reference (qui donnerait un name_size_range fausse
  // pour le reste du catalogue).
  let keyCandidates = spans.filter(
    (s) => hasKeyValueSeparator(s.text) && s.bbox[0] > specsZoneGuess,
  );
  // Flag layout : true si on a basculé sur le fallback tabulaire. Sur ce
  // layout, les noms produit sont distribués sur N colonnes à droite des
  // keys (X variés), donc nameXMax doit couvrir toute la largeur dispo.
  let tabularLayout = false;
  // Fallback layout tabulaire (catalogues type Catalogue C / Catalogue B) : keys
  // sans separateur ":" mais alignees Y avec ≥1 valeur(s) en colonnes a
  // droite. Ne se declenche QUE si le 1er passage echoue (compat Catalogue A).
  if (keyCandidates.length < MIN_KEY_CANDIDATES) {
    const tabular = detectTabularKeys(spans, pageW);
    if (tabular.length >= MIN_KEY_CANDIDATES) {
      keyCandidates = tabular;
      tabularLayout = true;
    } else {
      return null;
    }
  }

  const keyFont = mostCommon(keyCandidates.map((s) => s.font));
  const keySize = mostCommon(keyCandidates.map((s) => Math.round(s.size * 10) / 10));
  const keyPattern = extractFontSuffix(keyFont, DEFAULT_PROFILE.keyFontPattern);

  // Sur layout tabulaire (Catalogue C / Catalogue B), les noms produit sont
  // étalés sur N colonnes à droite des keys, donc nameZoneGuess (zone
  // gauche) ne les couvre pas. On élargit à pageW * 0.95 (toute la
  // largeur sauf marge droite).
  const nameZone = tabularLayout ? pageW * 0.95 : nameZoneGuess;

  // Detection nom : itere sur les candidats de pattern font
  let namePattern: string | null = null;
  let nameSizes: number[] = [];
  for (const candidate of DETECT_NAME_FONT_CANDIDATES) {
    const matches = spans.filter(
      (s) =>
        s.font.includes(candidate) &&
        s.size >= DEFAULT_PROFILE.nameMinSize &&
        s.bbox[0] < nameZone,
    );
    if (matches.length >= MIN_KEY_CANDIDATES) {
      namePattern = candidate;
      nameSizes = matches.map((s) => s.size);
      break;
    }
  }

  // Fallback : 1er span gros + dans la zone name
  if (!namePattern) {
    const bigLeft = spans.filter(
      (s) => s.size >= DEFAULT_PROFILE.nameMinSize && s.bbox[0] < nameZone,
    );
    if (bigLeft.length >= MIN_KEY_CANDIDATES) {
      const mostFont = mostCommon(bigLeft.map((s) => s.font));
      namePattern = extractFontSuffix(mostFont, DEFAULT_PROFILE.nameFontPattern);
      nameSizes = bigLeft.map((s) => s.size);
    }
  }
  if (!namePattern || nameSizes.length === 0) return null;

  const sizeMin = Math.max(
    DEFAULT_PROFILE.nameMinSize,
    Math.min(...nameSizes) - AUTO_DETECT_SIZE_PADDING,
  );
  const sizeMax = Math.min(
    DETECT_NAME_SIZE_MAX_CLAMP,
    Math.max(...nameSizes) + AUTO_DETECT_SIZE_PADDING,
  );
  const specsXMin =
    keyCandidates.length > 0
      ? Math.min(...keyCandidates.map((s) => s.bbox[0])) - DETECT_SPECS_X_OFFSET
      : DEFAULT_PROFILE.specsXMin;
  // Sur layout tabulaire : noms étalés sur N colonnes → nameXMax = pageW
  // (presque toute la largeur). Sur layout vertical Catalogue A : zone gauche
  // standard.
  const nameXMax = tabularLayout
    ? pageW * 0.95
    : Math.max(
        specsXMin - DETECT_NAME_X_MARGIN,
        nameZoneGuess * DETECT_NAME_X_FACTOR,
      );
  const lineHeight = Math.round(keySize * LINE_HEIGHT_RATIO * 10) / 10;

  // Detection valeur (font Light / Regular au meme Y que les cles)
  let valuePattern = DEFAULT_PROFILE.valueFontPattern;
  if (keyCandidates.length > 0) {
    const keysY = new Set(keyCandidates.map((s) => Math.round(s.bbox[1])));
    const valueCandidates = spans.filter(
      (s) =>
        s.bbox[0] > specsZoneGuess &&
        keysY.has(Math.round(s.bbox[1])) &&
        !hasKeyValueSeparator(s.text),
    );
    if (valueCandidates.length > 0) {
      const vFont = mostCommon(valueCandidates.map((s) => s.font));
      valuePattern = extractFontSuffix(vFont, DEFAULT_PROFILE.valueFontPattern);
    }
  }

  return {
    ...DEFAULT_PROFILE,
    nameFontPattern: namePattern,
    nameSizeRange: [sizeMin, sizeMax],
    keyFontPattern: keyPattern,
    keySize,
    valueFontPattern: valuePattern,
    valueSize: keySize,
    specsXMin,
    nameXMax,
    lineHeight,
    source: 'heuristic',
  };
}

// ─── Fallback Claude ─────────────────────────────────────────────────────────

export interface DetectProfileClaudeOptions {
  pages: ExtractedPage[];
  workDir: string;
  projectDir: string;
  claudeBin?: string;
  timeoutMs?: number;
}

/**
 * Demande a Claude de generer un TemplateProfile en analysant un echantillon
 * de raw_spans. Utile quand l'heuristique pure echoue (fonts custom, templates
 * exotiques sans suffixe typo lisible).
 *
 * Claude ecrit le profil dans workDir/profile.json via Edit. On le relit et
 * on valide les champs essentiels avant de fusionner avec DEFAULT_PROFILE.
 */
export async function detectProfileClaude(
  opts: DetectProfileClaudeOptions,
): Promise<TemplateProfile> {
  const samples = pickSamplePages(opts.pages, 5).filter(
    (p) => p.raw_spans && p.raw_spans.length > 5,
  );
  if (samples.length === 0) return { ...DEFAULT_PROFILE };

  const profilePath = path.join(opts.workDir, 'profile.json');
  // Pre-creer un stub vide que Claude doit Edit (sinon il devra Write, hors
  // allowedTools).
  await fs.writeFile(
    profilePath,
    JSON.stringify({ status: 'TODO_FILL_BELOW' }, null, 2),
    'utf8',
  );

  const prompt = buildProfilePrompt(samples, profilePath);
  const res = await callClaudeCli({
    prompt,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    timeoutMs: opts.timeoutMs ?? 120_000,
    allowedTools: 'Read,Edit',
  });
  if (!res.ok) return { ...DEFAULT_PROFILE };

  try {
    const raw = await fs.readFile(profilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TemplateProfile>;
    return mergeProfile(parsed, 'claude');
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function buildProfilePrompt(samples: ExtractedPage[], profilePath: string): string {
  const sampleStr = samples
    .map((p) => {
      const spans = (p.raw_spans ?? []).slice(0, 50).map((s) => ({
        text: s.text.length > 40 ? s.text.slice(0, 40) + '…' : s.text,
        bbox: s.bbox.map((n) => Math.round(n * 10) / 10),
        font: s.font,
        size: Math.round(s.size * 10) / 10,
      }));
      return `Page ${p.page_number} (${p.page_size.width}x${p.page_size.height}) :\n${JSON.stringify(spans, null, 1)}`;
    })
    .join('\n\n');
  return `Tu analyses un PDF catalogue produit. Identifie le profil typographique pour permettre la detection automatique des fiches produit.

Echantillon de spans (5 pages max, 50 spans/page) :

${sampleStr}

Determine :
- nameFontPattern : substring du font name pour le NOM PRODUIT (ex "SemiBold", "Bold"). Souvent le plus gros texte a gauche.
- nameSizeRange : [min, max] taille en pt du nom produit (ex [13, 18]).
- keyFontPattern : substring du font name pour les CLES de specs (ex "Medium"). Les cles contiennent ":".
- keySize : taille en pt des cles (ex 11).
- valueFontPattern : substring font pour les VALEURS de specs (ex "Light", "Regular").
- specsXMin : X (pt) ou commencent les cles de specs (colonne droite).
- nameXMax : X (pt) max pour les noms produit (colonne gauche).

Ecris ce JSON STRICTEMENT dans ${profilePath} via Edit. Garde les autres champs absents (ils prendront la valeur defaut). Format attendu :

{
  "nameFontPattern": "...",
  "nameSizeRange": [13.0, 18.0],
  "keyFontPattern": "...",
  "keySize": 11.0,
  "valueFontPattern": "...",
  "specsXMin": 280.0,
  "nameXMax": 250.0
}`;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export interface DetectProfileOptions {
  pages: ExtractedPage[];
  /** Si true, force l'appel Claude meme si l'heuristique trouve un profil. */
  forceClaude?: boolean;
  /** Si true, l'heuristique seule (pas de fallback Claude). Defaut false. */
  heuristicOnly?: boolean;
  workDir?: string;
  projectDir?: string;
  claudeBin?: string;
}

// P2.7 : cache module-level. Key = signature des pages (taille + sample
// spans). Sur run repete avec meme template (test ou batch), gain ~10ms.
// Max 32 entrees (eviction FIFO : on supprime la 1ere inseree a
// l'overflow — Map JS preserve l'ordre d'insertion). Pas un vrai LRU.
const PROFILE_CACHE = new Map<string, TemplateProfile>();
const PROFILE_CACHE_MAX = 32;

export function profileSignature(pages: ExtractedPage[]): string {
  // Signature robuste discriminante (faille review : signature precedente
  // collidait sur 2 templates partageant les 5 premiers fonts/sizes — cas
  // typique : 2 catalogues d'une meme marque avec cover identique).
  //
  // Dimensions discriminantes :
  //   - nombre total de pages (cat 30p vs cat 200p)
  //   - dimensions de page (A4 portrait vs A3 paysage)
  //   - 10 premiers spans (fonts + sizes) sur 6 pages
  //   - histogramme des sizes (top 5 distinct sizes triees)
  const totalPages = pages.length;
  const sample = pages.slice(0, 6);
  const parts: string[] = [`n=${totalPages}`];
  for (const p of sample) {
    const sp = p.raw_spans ?? [];
    const pw = Math.round(p.page_size.width);
    const ph = Math.round(p.page_size.height);
    const fonts = sp
      .slice(0, 10)
      .map((s) => `${s.font}/${s.size.toFixed(1)}`)
      .join(',');
    // Histogramme : top 5 sizes distinctes (triees)
    const uniqueSizes = Array.from(
      new Set(sp.slice(0, 50).map((s) => Math.round(s.size * 2) / 2)),
    )
      .sort((a, b) => b - a)
      .slice(0, 5)
      .join(',');
    parts.push(`${sp.length}:${pw}x${ph}:${fonts}:[${uniqueSizes}]`);
  }
  return parts.join('|');
}

/** Reset cache (tests). */
export function clearProfileCache(): void {
  PROFILE_CACHE.clear();
}

/**
 * Point d'entree : heuristique d'abord, Claude en fallback si l'heuristique
 * retombe sur defaults OU si forceClaude=true.
 */
export async function detectProfile(
  opts: DetectProfileOptions,
): Promise<TemplateProfile> {
  // Cache heuristique uniquement (Claude est intentionnellement re-evalue).
  if (opts.heuristicOnly && !opts.forceClaude) {
    const sig = profileSignature(opts.pages);
    const cached = PROFILE_CACHE.get(sig);
    if (cached) return cached;
    const heuristic = detectProfileHeuristic(opts.pages);
    if (PROFILE_CACHE.size >= PROFILE_CACHE_MAX) {
      const firstKey = PROFILE_CACHE.keys().next().value;
      if (firstKey !== undefined) PROFILE_CACHE.delete(firstKey);
    }
    PROFILE_CACHE.set(sig, heuristic);
    return heuristic;
  }

  const heuristic = detectProfileHeuristic(opts.pages);
  if (opts.heuristicOnly) return heuristic;
  if (!opts.forceClaude && heuristic.source === 'heuristic') return heuristic;

  if (!opts.workDir || !opts.projectDir) return heuristic;
  return detectProfileClaude({
    pages: opts.pages,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Détecte les spans "key" via alignement tabulaire (sans séparateur intra-span).
 *
 *  Cas typique : catalogues type Catalogue C / Catalogue B où les keys sont en
 *  colonne 1 à gauche, alignées Y avec ≥1 valeur(s) en colonnes 2..N à droite.
 *  Exemple : "Référence" | "002236" | "002281" | "002282" sur même Y.
 *
 *  Heuristique :
 *   1. Group spans par Y (tolerance ±2pt, modulo erreurs d'alignement PDF).
 *   2. Pour chaque ligne avec ≥2 spans triés par X :
 *      - 1ère span à gauche (bbox[0] < pageW * 0.5) — c'est la key
 *      - écart X entre 1ère et 2ème ≥ MIN_TAB_GAP — élimine les groupes mots
 *      - 1ère span texte non vide, sans séparateur (sinon comptée ailleurs)
 *   3. Retourne les 1ères spans qualifiées.
 *
 *  Garde-fous anti-faux-positif (paragraphe libre, intercalaire) :
 *   - Filtre nombres purs (1, 12, 002236) — pas des keys
 *   - Filtre lignes uniques (orphelines)
 *   - Exige texte de longueur ≥ 3 char et ≤ 60 char.
 */
function detectTabularKeys(spans: TextSpan[], pageW: number): TextSpan[] {
  const MIN_TAB_GAP = 100.0;
  const Y_TOLERANCE = 2.0;
  const MAX_KEY_LEFT_X_RATIO = 0.5;
  const MIN_TEXT_LEN = 3;
  const MAX_TEXT_LEN = 60;
  const X_CLUSTER_TOLERANCE = 15.0;
  const MIN_CLUSTER_SIZE = 3;
  // Group spans by quantized Y.
  const buckets = new Map<number, TextSpan[]>();
  for (const s of spans) {
    const text = s.text.trim();
    if (!text) continue;
    const yKey = Math.round(s.bbox[1] / Y_TOLERANCE);
    const list = buckets.get(yKey) ?? [];
    list.push(s);
    buckets.set(yKey, list);
  }
  const candidates: TextSpan[] = [];
  // Anti faux-positif TOC : pattern "[label] [p.XX]" très fréquent dans
  // sommaires (Catalogue A, Catalogue B, etc.). Exclu si ligne = exactement 2 spans
  // et 2ème = numéro de page (avec ou sans "p." préfixe).
  const TOC_PAGE_NUM_RE = /^p\.?\s*\d{1,4}\s*$/i;
  for (const line of buckets.values()) {
    if (line.length < 2) continue;
    const sorted = [...line].sort((a, b) => a.bbox[0] - b.bbox[0]);
    const first = sorted[0];
    const second = sorted[1];
    const txt = first.text.trim();
    if (txt.length < MIN_TEXT_LEN || txt.length > MAX_TEXT_LEN) continue;
    if (/^[\d.,\s]+$/.test(txt)) continue; // nombres purs
    if (hasKeyValueSeparator(txt)) continue; // déjà comptée
    if (first.bbox[0] > pageW * MAX_KEY_LEFT_X_RATIO) continue;
    if (second.bbox[0] - first.bbox[0] < MIN_TAB_GAP) continue;
    if (line.length === 2 && TOC_PAGE_NUM_RE.test(second.text.trim())) continue;
    candidates.push(first);
  }
  // Anti faux-positif : exiger que ≥3 keys partagent un X commun (= colonne
  // gauche d'une fiche produit tabulaire). Bandeaux d'intercalaires dispersés
  // sur des X différents échouent ce test.
  if (candidates.length < MIN_CLUSTER_SIZE) return [];
  const clusters: TextSpan[][] = [];
  for (const c of candidates) {
    let placed = false;
    for (const cluster of clusters) {
      if (Math.abs(cluster[0].bbox[0] - c.bbox[0]) <= X_CLUSTER_TOLERANCE) {
        cluster.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([c]);
  }
  const best = clusters.reduce(
    (a, b) => (a.length >= b.length ? a : b),
    [] as TextSpan[],
  );
  return best.length >= MIN_CLUSTER_SIZE ? best : [];
}

function pickSamplePages(pages: ExtractedPage[], n: number): ExtractedPage[] {
  if (pages.length === 0) return [];
  if (pages.length <= n) return pages;
  const step = Math.floor(pages.length / n);
  const result: ExtractedPage[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.min(pages.length - 1, i * step + Math.floor(step / 2));
    result.push(pages[idx]);
  }
  return result;
}

function mostCommon<T>(arr: T[]): T {
  const counts = new Map<T, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T = arr[0];
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

function extractFontSuffix(font: string, fallback: string): string {
  if (font.includes('-')) {
    const parts = font.split('-');
    return parts[parts.length - 1];
  }
  return font || fallback;
}

function mergeProfile(
  partial: Partial<TemplateProfile>,
  source: TemplateProfile['source'],
): TemplateProfile {
  return {
    ...DEFAULT_PROFILE,
    ...partial,
    source,
  };
}
