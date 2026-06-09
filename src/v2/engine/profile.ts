/**
 * TemplateProfile: typographic and geometric profile of a PDF template.
 *
 * TS port of the TemplateProfile dataclass + auto_detect_template() from the
 * V1 engine (python/substitute.py). Used by the V2 pipeline (blockDetector,
 * substitutor) to identify product sheets in any template without hardcoded
 * per-template heuristics.
 *
 * Detection strategy:
 *  1. Pure heuristic (detectProfileHeuristic): samples the spans, finds the
 *     most probable font pattern for name/key/value. Works on conventional
 *     templates (named typo weights SemiBold/Medium/etc).
 *  2. Claude fallback (detectProfileClaude): if the heuristic returns
 *     defaults (= uncertain), we ask Claude to analyze a sample and produce
 *     the profile. Generalizes to exotic templates.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { callClaudeCli } from '../claudeCli';
import type { ExtractedPage, TextSpan } from '../types';
import { hasKeyValueSeparator } from './keyValueSeparator';

// ─── Type ────────────────────────────────────────────────────────────────────

export interface TemplateProfile {
  // === Typo ===
  /** Substring searched in the font name to identify the "product name" span. */
  nameFontPattern: string;
  /** Size range (pt) for a span to be a "name" candidate. */
  nameSizeRange: [number, number];
  /** Absolute minimum size for a span to be a "name" candidate (rejected below it). */
  nameMinSize: number;
  /** Font-name substring for the "spec key" span (e.g. "MECANISME:"). */
  keyFontPattern: string;
  /** Typical size (pt) of keys. */
  keySize: number;
  /** Font-name substring for spec values. */
  valueFontPattern: string;
  /** Typical size (pt) of values. */
  valueSize: number;
  /** Font substring for the product ref (often Regular with a digit). */
  headerRefFontPattern: string;
  /** Font substring for the main color (often Medium without a digit). */
  headerColorFontPattern: string;

  // === Geometry ===
  /** Max X for a span to be a "name" candidate (on the left of the page). */
  nameXMax: number;
  /** Min X at which the specs column starts. */
  specsXMin: number;
  /** Typical line height (pt). */
  lineHeight: number;

  // === Block bounds ===
  /** Y gap between 2 vertical product blocks (pt). */
  blockYGap: number;
  /** Y margin from the bottom of the page for the last product block (pt). */
  blockLastBottomMargin: number;
  /** Height of the header zone (under the name: ref + color). */
  blockHeaderZoneHeight: number;
  /** name_size multiplier ratio for the adaptive header zone. */
  blockHeaderZoneSizeRatio: number;
  /** Y offset from the bottom of the header to start the variants zone. */
  blockHeaderExcludeYOffset: number;

  // === Color / Ref ===
  /** Size range for color/ref spans. */
  colorRefSizeRange: [number, number];
  /** Horizontal spacing between color and ref (pt). */
  colorRefSpacing: number;

  // === Variants ===
  /** Size range of the square color-variant thumbnails. */
  variantCircleSizeRange: [number, number];
  /** w/h ratio to consider a bbox "square". */
  squareRatioRange: [number, number];
  /** Size range of pictograms (NF, made in France...) — to EXCLUDE from variants. */
  pictoSizeRange: [number, number];

  // === Name merge tolerances (multi-line wrapping) ===
  nameMergeXTolerance: number;
  nameMergeYTolerance: number;
  nameMergeSizeTolerance: number;

  // === Spec tolerances ===
  specInlineYTolerance: number;
  specInlineXTolerance: number;
  specContinuationYExtra: number;
  specContinuationXTolerance: number;

  // === Banner / Ribbon ===
  bannerMinSize: number;
  /** Right margin: the specs erase zone stops at (pageWidth - ribbonMargin)
   *  to preserve the vertical ribbons on the right (section ribbon, page
   *  number, etc.). The name is legacy (V1); it means "right margin". */
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

// ─── Detection constants ─────────────────────────────────────────────────────

/** Font patterns to look for in the font file name to identify "strong" text
 *  (= product name, usually the largest on the left).
 *
 *  Extended lists:
 *   - EN: SemiBold, Bold, Black, Heavy, Demibold, ExtraBold, UltraBold
 *   - FR: Gras, Demi-Gras
 *   - DE: Fett, Halbfett
 *   - ES: Negrita
 *   - PostScript weight names: 700, 800, 900 (sometimes embedded in font name)
 *   - Display fonts often used in titles: Display, Title, Headline, Heading
 *
 *  Case-insensitive substring match via .includes() on the caller side. */
const DETECT_NAME_FONT_CANDIDATES = [
  // EN bold weights
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
  // Display / Title fonts (often used for product titles)
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
/** Minimum candidate threshold (spec keys OR name spans) to consider a page
 *  a "standard product sheet" usable for typo profile detection. 3 = a
 *  compromise between:
 *   - avoiding pages with 1-2 specs (intercalaires/cover wrongly seen as product)
 *   - accepting sheets with few specs (compact view / simple product).
 *  Minor audit: factored out from 4 inline occurrences. */
const MIN_KEY_CANDIDATES = 3;

// ─── Pure heuristic (V1 auto_detect_template port) ──────────────────────────

/**
 * Detects a template's profile via a pure heuristic on the raw_spans of one
 * (or several) sample page(s). Equivalent to the V1 auto_detect_template() in
 * Python.
 *
 * We sample several pages and take the first that produces a convincing name
 * pattern (>= 3 candidates). Otherwise we fall back to defaults.
 */
export function detectProfileHeuristic(pages: ExtractedPage[]): TemplateProfile {
  // Broad sample: we look for a "standard product sheet" page (with ":" spec
  // keys + large names on the left). Intercalaires/sommaires are skipped
  // since they have no keys.
  const candidates = pickSamplePages(pages, 12);

  // 1. Collect ALL valid profiles among the sample pages.
  // On a homogeneous catalog (Catalogue A, Catalogue E), all profiles are
  // equivalent → we take the first. On a heterogeneous catalog (Catalogue C =
  // some multi-col tabular pages + other vertical ones), we prefer the
  // profile with the largest nameXMax (= tabular detected), which covers both
  // layouts (a widened zone does not prevent matching narrow names).
  const allProfiles: TemplateProfile[] = [];
  for (const page of candidates) {
    const spans = page.raw_spans;
    if (!spans || spans.length < 5) continue;
    const profile = detectFromPage(page, spans);
    if (profile) allProfiles.push(profile);
  }
  if (allProfiles.length > 0) {
    // Prefer the profile with the largest nameXMax (= tabular profile if it
    // exists, otherwise any equivalent vertical profile).
    //
    // Anti-outlier validation: if a SINGLE "extra-large" profile stands out
    // (>= 90% pageW while the others are at 50-60% pageW), it is suspicious
    // (index page, footer table, watermark) → we ignore it and take the
    // majority. Threshold: best > 1.5x median AND best is isolated (a single
    // profile in the top bracket).
    if (allProfiles.length >= 3) {
      const xMaxValues = allProfiles.map((p) => p.nameXMax).sort((a, b) => a - b);
      const median = xMaxValues[Math.floor(xMaxValues.length / 2)];
      const topCandidate = allProfiles.reduce((a, b) =>
        b.nameXMax > a.nameXMax ? b : a,
      );
      // How many profiles are "close" to the top (>= 90% of its nameXMax)?
      const closeToTop = allProfiles.filter(
        (p) => p.nameXMax >= topCandidate.nameXMax * 0.9,
      ).length;
      if (topCandidate.nameXMax > median * 1.5 && closeToTop === 1) {
        // Outlier detected: we reject the top and take the 2nd best.
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

  // 2. Fallback: multi-page aggregation. Covers templates where no single
  // page has >= 3 keyCandidates (typically: 1-2 product sheets per page, many
  // identity/intercalaire pages). We aggregate the spans of all sampled pages
  // to reach the threshold and detect a global pattern.
  const aggregatedSpans: TextSpan[] = [];
  for (const page of candidates) {
    if (page.raw_spans) aggregatedSpans.push(...page.raw_spans);
  }
  if (aggregatedSpans.length >= 5 && candidates.length > 0) {
    // Virtual page: same dimensions as the first candidate (the bbox ratios
    // are relative to pageW). We pick the page with the largest pageW so as
    // not to filter too aggressively by nameZoneGuess.
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

  // 3. No pattern found even aggregated: return defaults.
  // The caller can then fall back to detectProfileClaude.
  return { ...DEFAULT_PROFILE };
}

function detectFromPage(page: ExtractedPage, spans: TextSpan[]): TemplateProfile | null {
  const pageW = page.page_size.width;
  const nameZoneGuess = pageW * NAME_ZONE_GUESS_RATIO;
  const specsZoneGuess = pageW * SPECS_ZONE_GUESS_RATIO;

  // Key detection (spans containing ":" on the right of the page). If fewer
  // than MIN_KEY_CANDIDATES keys, this is not a "product sheet" page — we
  // skip. Essential filter to avoid taking a sommaire/intercalaire page as a
  // reference (which would give a wrong name_size_range for the rest of the
  // catalog).
  let keyCandidates = spans.filter(
    (s) => hasKeyValueSeparator(s.text) && s.bbox[0] > specsZoneGuess,
  );
  // Layout flag: true if we switched to the tabular fallback. On this layout,
  // the product names are distributed across N columns to the right of the
  // keys (varied X), so nameXMax must cover the entire available width.
  let tabularLayout = false;
  // Tabular layout fallback (catalogs like Catalogue C / Catalogue B): keys
  // without a ":" separator but Y-aligned with ≥1 value(s) in columns on the
  // right. Triggers ONLY if the first pass fails (Catalogue A compat).
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

  // On a tabular layout (Catalogue C / Catalogue B), the product names are
  // spread across N columns to the right of the keys, so nameZoneGuess (left
  // zone) does not cover them. We widen to pageW * 0.95 (the whole width
  // except the right margin).
  const nameZone = tabularLayout ? pageW * 0.95 : nameZoneGuess;

  // Name detection: iterate over the font-pattern candidates
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

  // Fallback: first large span within the name zone
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
  // On tabular layout: names spread across N columns → nameXMax = pageW
  // (almost the whole width). On Catalogue A vertical layout: standard left
  // zone.
  const nameXMax = tabularLayout
    ? pageW * 0.95
    : Math.max(
        specsXMin - DETECT_NAME_X_MARGIN,
        nameZoneGuess * DETECT_NAME_X_FACTOR,
      );
  const lineHeight = Math.round(keySize * LINE_HEIGHT_RATIO * 10) / 10;

  // Value detection (font Light / Regular at the same Y as the keys)
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
 * Asks Claude to generate a TemplateProfile by analyzing a sample of
 * raw_spans. Useful when the pure heuristic fails (custom fonts, exotic
 * templates with no readable typo suffix).
 *
 * Claude writes the profile to workDir/profile.json via Edit. We read it back
 * and validate the essential fields before merging with DEFAULT_PROFILE.
 */
export async function detectProfileClaude(
  opts: DetectProfileClaudeOptions,
): Promise<TemplateProfile> {
  const samples = pickSamplePages(opts.pages, 5).filter(
    (p) => p.raw_spans && p.raw_spans.length > 5,
  );
  if (samples.length === 0) return { ...DEFAULT_PROFILE };

  const profilePath = path.join(opts.workDir, 'profile.json');
  // Pre-create an empty stub that Claude must Edit (otherwise it would have
  // to Write, which is outside allowedTools).
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
  /** If true, forces the Claude call even if the heuristic finds a profile. */
  forceClaude?: boolean;
  /** If true, heuristic only (no Claude fallback). Default false. */
  heuristicOnly?: boolean;
  workDir?: string;
  projectDir?: string;
  claudeBin?: string;
}

// P2.7: module-level cache. Key = page signature (size + sample spans). On a
// repeated run with the same template (test or batch), saves ~10ms. Max 32
// entries (FIFO eviction: we remove the first inserted on overflow — JS Map
// preserves insertion order). Not a true LRU.
const PROFILE_CACHE = new Map<string, TemplateProfile>();
const PROFILE_CACHE_MAX = 32;

export function profileSignature(pages: ExtractedPage[]): string {
  // Robust discriminating signature (review flaw: the previous signature
  // collided on 2 templates sharing the first 5 fonts/sizes — a typical case:
  // 2 catalogs from the same brand with an identical cover).
  //
  // Discriminating dimensions:
  //   - total page count (30p cat vs 200p cat)
  //   - page dimensions (A4 portrait vs A3 landscape)
  //   - first 10 spans (fonts + sizes) over 6 pages
  //   - size histogram (top 5 distinct sizes, sorted)
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
    // Histogram: top 5 distinct sizes (sorted)
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

/** Reset the cache (tests). */
export function clearProfileCache(): void {
  PROFILE_CACHE.clear();
}

/**
 * Entry point: heuristic first, Claude as fallback if the heuristic falls
 * back to defaults OR if forceClaude=true.
 */
export async function detectProfile(
  opts: DetectProfileOptions,
): Promise<TemplateProfile> {
  // Heuristic-only cache (Claude is intentionally re-evaluated).
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

/** Detects "key" spans via tabular alignment (without an intra-span separator).
 *
 *  Typical case: catalogs like Catalogue C / Catalogue B where the keys are in
 *  column 1 on the left, Y-aligned with ≥1 value(s) in columns 2..N on the
 *  right. Example: "Référence" | "002236" | "002281" | "002282" on the same Y.
 *
 *  Heuristic:
 *   1. Group spans by Y (tolerance ±2pt, modulo PDF alignment errors).
 *   2. For each line with ≥2 spans sorted by X:
 *      - first span on the left (bbox[0] < pageW * 0.5) — that is the key
 *      - X gap between first and second ≥ MIN_TAB_GAP — eliminates word groups
 *      - first span non-empty text, without a separator (else counted elsewhere)
 *   3. Returns the qualified first spans.
 *
 *  Anti-false-positive guards (free paragraph, intercalaire):
 *   - Filters pure numbers (1, 12, 002236) — not keys
 *   - Filters single (orphan) lines
 *   - Requires text of length ≥ 3 chars and ≤ 60 chars.
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
  // TOC anti-false-positive: the "[label] [p.XX]" pattern is very common in
  // sommaires (Catalogue A, Catalogue B, etc.). Excluded if the line = exactly
  // 2 spans and the 2nd is a page number (with or without "p." prefix).
  const TOC_PAGE_NUM_RE = /^p\.?\s*\d{1,4}\s*$/i;
  for (const line of buckets.values()) {
    if (line.length < 2) continue;
    const sorted = [...line].sort((a, b) => a.bbox[0] - b.bbox[0]);
    const first = sorted[0];
    const second = sorted[1];
    const txt = first.text.trim();
    if (txt.length < MIN_TEXT_LEN || txt.length > MAX_TEXT_LEN) continue;
    if (/^[\d.,\s]+$/.test(txt)) continue; // pure numbers
    if (hasKeyValueSeparator(txt)) continue; // already counted
    if (first.bbox[0] > pageW * MAX_KEY_LEFT_X_RATIO) continue;
    if (second.bbox[0] - first.bbox[0] < MIN_TAB_GAP) continue;
    if (line.length === 2 && TOC_PAGE_NUM_RE.test(second.text.trim())) continue;
    candidates.push(first);
  }
  // Anti-false-positive: require ≥3 keys to share a common X (= left column
  // of a tabular product sheet). Intercalaire bands scattered across
  // different X fail this test.
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
