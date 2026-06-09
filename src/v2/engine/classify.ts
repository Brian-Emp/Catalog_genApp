/**
 * Phase 1.1: structural classification of each template page.
 *
 * Decides for each page: product / toc / glossaire / intercalaire / identity.
 * Output: 1 PageClassification per page, with a confidence score ∈ [0, 1].
 *
 * The score is INFORMATIVE — no hard threshold is applied in the pipeline
 * (no "if confidence < 0.7 then ..."): it is Claude (optional phase 1.2
 * audit) that can override a low-confidence classification. Without Claude,
 * we keep the heuristic kind even if confidence = 0.7.
 */

import type { ExtractedPage, Slot, SlotSectionBanner, TextSpan } from '../types';
import { findProductBlocks, type ProductBlock } from './blockDetector';
import type { TemplateProfile } from './profile';
import { hasKeyValueSeparator } from './keyValueSeparator';
import { stripAccents } from './textNormalize';

/**
 * Pattern for an inline page reference ("p.12", "page 12", "Seite 12",
 * "pag. 12", "pág. 12"). Used to heuristically detect TOC pages without a
 * toc_entry slot placed by the extractor (= non-Catalogue A templates).
 *
 * Deliberately strict (= mandatory textual prefix) so as NOT to match
 * variant values "30/35/38" on product sheets.
 *
 * Two alternations:
 *  - Long form with mandatory whitespace between prefix and number:
 *    `page 12`, `Page 12`, `pag 12`, `pag. 12`, `pagina 12`, `pág. 12`,
 *    `página 12`, `seite 12`, `Seite 12`.
 *  - Short form with a mandatory dot: `p.12`, `p. 12`, `S.12`, `S. 12`.
 */
export const PAGE_REF_INLINE_RE =
  /\b(?:page|pag(?:ina)?|pág(?:ina)?|seite)\.?\s+\d{1,4}\b|\b[ps]\.\s*\d{1,4}\b/i;

export type PageKind =
  | 'product'        // template product-sheet page (blocks detected)
  | 'toc'            // general sommaire OR section sommaire OR synopsis
  | 'glossaire'      // pictogram glossary / color index / alpha index
  | 'tech'           // cahier technique / technical sheet / datasheet (audit #8)
  | 'intercalaire'   // section intro (large title, no sheets)
  | 'identity';      // brand identity, neutral intro/outro, legal notices

export interface PageClassification {
  pageNumber: number;
  extracted: ExtractedPage;
  blocks: ProductBlock[];
  kind: PageKind;
  /** section_banner label detected on this page (real, post-filter). */
  sectionLabel: string | null;
  /** Active section = last sectionLabel encountered (propagated). */
  activeSection: string;
  /** Score [0..1]. Below 0.7 → borderline case, Claude should verify. */
  confidence: number;
}

export function classifyAllPages(
  pages: ExtractedPage[],
  profile: TemplateProfile,
): PageClassification[] {
  const result: PageClassification[] = [];
  let activeSection = '';
  for (const page of pages) {
    const cls = classifyPage(page, profile, activeSection);
    if (cls.sectionLabel) activeSection = cls.sectionLabel;
    result.push(cls);
  }
  return result;
}

/** Classifies ONE page in isolation. Exposed for unit tests. */
export function classifyPage(
  page: ExtractedPage,
  profile: TemplateProfile,
  activeSection = '',
): PageClassification {
  const blocks = findProductBlocks(page, profile);
  const sectionLabel = detectSectionLabel(page, profile);
  const { kind, confidence } = inferKind(page, blocks, sectionLabel);
  return {
    pageNumber: page.page_number,
    extracted: page,
    blocks,
    kind,
    sectionLabel,
    activeSection: sectionLabel || activeSection,
    confidence,
  };
}

// ─── Reliable section_banner detection (hard filter) ────────────────────────

function detectSectionLabel(
  page: ExtractedPage,
  profile: TemplateProfile,
): string | null {
  // Priority 1: classic horizontal section_banner (Catalogue A, Catalogue E, etc.)
  for (const s of page.slots) {
    if (s.type !== 'section_banner') continue;
    if (!isRealSectionBanner(s, profile)) continue;
    return s.label.text.trim();
  }
  // Priority 2: section_banner AT THE TOP OF THE PAGE (Y < 50) AND all caps OR
  // in a vertical ribbon (X < 30 and high bbox). Catalogue C case where the
  // "POMPES D'ÉVACUATION" banners are 15pt = max nameSize → rejected by the
  // strict filter above. The positional criterion discriminates unambiguously
  // vs product names that are in the middle of the page (Y > 100).
  for (const s of page.slots) {
    if (s.type !== 'section_banner') continue;
    const text = s.label?.text?.trim();
    if (!text || text.length < 2 || text.length > 80) continue;
    if (hasKeyValueSeparator(text)) continue;
    const y0 = s.bbox?.[1] ?? 1e9;
    const x0 = s.bbox?.[0] ?? 1e9;
    const size = s.label?.size ?? 0;
    // Top-of-page header: Y < 50 AND size >= bannerMinSize AND all-caps
    const isAllCaps = text === text.toUpperCase() && /[A-ZÀ-Ý]/.test(text);
    if (y0 < 50 && size >= profile.bannerMinSize && isAllCaps) {
      return text;
    }
    // Vertical ribbon (X < 30, high bbox + edge): tolerant on size
    if (x0 < 30 && size >= 8 && isAllCaps) {
      return text;
    }
  }
  // Priority 3: vertical section_ribbon (Catalogue C, Catalogue D, catalogs
  // where the family label is a vertical ribbon on the edge). Without this
  // fallback, Catalogue C product pages are NEVER matched to a product (root
  // cause of "94% pages dropped / no_section_match").
  for (const s of page.slots) {
    if (s.type !== 'section_ribbon') continue;
    const label = s.label?.text?.trim();
    if (label && label.length >= 2 && label.length <= 80) {
      return label;
    }
  }
  return null;
}

function isRealSectionBanner(
  s: SlotSectionBanner,
  profile: TemplateProfile,
): boolean {
  return isRealSectionBannerLabel(s.label, profile);
}

/**
 * Variant that works directly on a TextSpan. Used by the substitutor to
 * avoid duplicating the same thresholds (size >= bannerMinSize, no ':', size
 * > nameSizeRange[1], length 4-80) in the orchestrator.
 *
 * Exception length < 6: accepts VERY short labels ("WC", "SDB", "SPA") IF the
 * text is all uppercase AND the size is clearly larger than that of a product
 * name (ratio > 1.5x). This condition discriminates real "WC" section banners
 * in large type from "Noir"/"Inox" colors written at a product name's
 * standard size (12-16pt).
 */
export function isRealSectionBannerLabel(
  label: TextSpan,
  profile: TemplateProfile,
): boolean {
  const size = label.size;
  const text = label.text;
  if (size < profile.bannerMinSize) return false;
  if (hasKeyValueSeparator(text)) return false;
  if (size <= profile.nameSizeRange[1]) return false;
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;
  if (trimmed.length < 6) {
    // Conditional acceptance for short labels (>= 2 chars): must be all caps
    // AND have a size well above the max product name.
    const SHORT_LABEL_SIZE_RATIO = 1.5;
    if (trimmed.length < 2) return false;
    const isAllCaps =
      trimmed === trimmed.toUpperCase() && /[A-ZÀ-Ý]/.test(trimmed);
    if (!isAllCaps) return false;
    if (size < profile.nameSizeRange[1] * SHORT_LABEL_SIZE_RATIO) return false;
  }
  return true;
}

// ─── Kind inference ─────────────────────────────────────────────────────────

function inferKind(
  page: ExtractedPage,
  blocks: ProductBlock[],
  sectionLabel: string | null,
): { kind: PageKind; confidence: number } {
  // 1. Product page: we have at least 1 detected block
  // Additional filter: "cover design" page (large visuals + blocks with no
  // real content) → we reject the product classification so the allocator
  // does not place products on a cover. Catalogue C "NOS MARQUES" / "JARDIN
  // PISCINE" / Catalogue E covers.
  //
  // Additional "intro/marketing page" filter: a real product sheet ALWAYS has
  // a refSpan (SKU code). If no block has a ref, it is probably an
  // intro/marketing page (LA NORME NF, Catalogue A P4 brand intro, Catalogue C
  // "NOS MARQUES"...).
  //
  // Exception: if the block has many specs (>= 5 total), it is probably a B2B
  // datasheet without a ref → we keep product.
  // Catalogue A P4 NORME NF case: 2 blocks without ref + 0-3 paragraphs
  // detected as specs → marketing intro → identity → pictos preserved.
  const anyRef = blocks.some((b) => b.refSpan !== null);
  const totalSpecs = blocks.reduce((s, b) => s + b.specs.length, 0);
  const isMarketingIntro = blocks.length > 0 && !anyRef && totalSpecs < 5;
  // Cartography filter: comparison page with >= 6 TINY product names
  // (size <= 8pt) scattered across the page. Catalogue C P29 case
  // ("Cartographie selon le débit") where ECOP/ECL/JE-* names appear tiny as
  // table cells and NOT as sheets. The page typically has 3 detected "blocks"
  // (large category titles) but also contains 10+ names at size=7.
  const tinyProductNames = (page.raw_spans ?? []).filter(
    (s) => s.size <= 8 && /^(?:[A-Z]{2,}[\s-]?\d+|\d{4,6})\b/.test(s.text.trim()),
  ).length;
  const isCartographie = tinyProductNames >= 6;
  if (blocks.length > 0 && !isCoverDesign(page, blocks) && !isMarketingIntro && !isCartographie) {
    return { kind: 'product', confidence: 0.95 };
  }

  // 2. Sommaire: toc_entry/toc_title slots OR a page rich in "p.NN" refs
  const hasTocSlot = page.slots.some(
    (s) => s.type === 'toc_entry' || s.type === 'toc_title',
  );
  if (hasTocSlot) return { kind: 'toc', confidence: 0.9 };
  // TOC heuristic: counts the spans containing a formal page reference. We
  // accept the most common multi-language conventions:
  //   "p.12" / "p. 12"            FR/EN abbreviated (legacy Catalogue A)
  //   "page 12" / "Page 12"       FR/EN long
  //   "pag. 12" / "pagina 12"     IT
  //   "pág. 12" / "página 12"     ES
  //   "S. 12" / "Seite 12"        DE
  // We do NOT match a bare number ("12"), too ambiguous on product sheets
  // (cf. variant values "30","35","38"). The threshold stays >= 8 spans.
  const pageRefs = (page.raw_spans ?? []).filter((s) =>
    PAGE_REF_INLINE_RE.test(s.text),
  ).length;
  if (pageRefs >= 8) return { kind: 'toc', confidence: 0.85 };

  // 2bis. Explicit keywords (sommaire/glossaire/cahier tech) FR/EN/ES/DE/IT.
  // V1 port (`unwanted_keywords` + `tech_page_keywords`). On match: we
  // classify as toc/glossaire depending on the bucket, which drops them from
  // the product zone via the productZoneIdxs logic.
  const kw = matchUnwantedKeyword(page);
  if (kw) return { kind: kw, confidence: 0.85 };

  // 3. Pictogram glossary: dense vector paths + many short labels
  if (isGlossairePictos(page)) return { kind: 'glossaire', confidence: 0.8 };

  // 4. Section intercalaire vs brand intro page (GENERIC heuristic)
  //
  // A page with a detected sectionLabel is typically a section intercalaire.
  // BUT some brand-intro pages (variant covers, "NOS MARQUES", identity
  // logos, RSE...) also have a banner detected by the C++ binary even though
  // they are not really navigable section intercalaires. Reliable
  // discriminator: the surface covered by images.
  //
  // A real intercalaire (Catalogue A: "BARRES DE DOUCHES" + 1 square photo)
  // has moderate image coverage (~15-25%). A brand-intro page (Catalogue C: 3
  // large landscape photos + logos) covers ≥40% of the page with images.
  // Beyond that, we classify as identity → keep_raw rather than attempt to
  // revive it with a section label.
  if (sectionLabel) {
    const imgCoverage = computeImageCoverageRatio(page);
    if (imgCoverage < INTRO_BRAND_IMAGE_RATIO) {
      return { kind: 'intercalaire', confidence: 0.85 };
    }
    // Otherwise: fall-through to identity
  }

  // 5. Brand identity (catch-all)
  return { kind: 'identity', confidence: 0.7 };
}

/** Detects a "cover design" page: large visuals cover a big surface AND the
 *  detected blocks are poor in real content (no refs, few specs). Catalogue C
 *  "NOS MARQUES" / "JARDIN PISCINE" case: blockDetector finds "blocks" on the
 *  large titles but they are not real substitutable product sheets.
 *
 *  Hardened criterion (review flaw: a cover with 2 random specs
 *  "Edition 2025" + "Version: 1.0" escaped the old test):
 *    - imgCoverage > 0.5 (really a design, a Catalogue A product is ~20-30%)
 *    - AND no block has a ref (no refSpan found)
 *    - AND total specs on the page < 3 (a cover may have 1-2 marketing labels
 *      but a real product page has >= 3 specs total)
 *    - AND no block has an identified main image (on a cover, the images are
 *      decorative, not detected as mainImageBbox)
 *
 *  On Catalogue A: each block has a refSpan + 4-6 specs → false (not cover design).
 *  On a Catalogue C cover: 0 refs + 0-1 specs total + 0 mainImage → true.
 */
export function isCoverDesign(
  page: ExtractedPage,
  blocks: ProductBlock[],
): boolean {
  // Special case: pages with giant marketing headlines (size > 30pt) that
  // exceed the profile's nameSizeRange → 0 detected blocks. If the page is
  // very visual (imgCoverage > 0.7) AND contains ≥ 1 headline > 30pt, it is a
  // cover design (NOS MARQUES & NOS GAMMES, NOTRE VISIBILITÉ...).
  if (blocks.length === 0) {
    const imgCoverage = computeImageCoverageRatio(page);
    if (imgCoverage > 0.7) {
      const hasGiantHeadline = (page.raw_spans ?? []).some(
        (s) => s.size > 30 && s.text.trim().length > 3,
      );
      if (hasGiantHeadline) return true;
    }
    return false;
  }
  // Criterion 1: total image coverage > 50% (sum)
  // Criterion 2 (alternative): a SINGLE image covers > 35% pageArea (full-bleed cover)
  // Criterion 3 (alternative): all blocks have nameSpan.size > 24pt (large
  // marketing title/headline = Catalogue C cover "NOS MARQUES" / "JARDIN PISCINE")
  const imgCoverage = computeImageCoverageRatio(page);
  const largestImgRatio = computeLargestImageRatio(page);
  const allHeadlineSize = blocks.every((b) => b.nameSpan.size > 24);
  const isVisuallyDominant =
    imgCoverage > 0.5 || largestImgRatio > 0.35 || allHeadlineSize;
  if (!isVisuallyDominant) return false;
  // No block with a ref
  const anyHasRef = blocks.some((b) => b.refSpan !== null);
  if (anyHasRef) return false;
  // No block with an identified main image
  const anyHasMainImage = blocks.some((b) => b.mainImageBbox !== null);
  if (anyHasMainImage) return false;
  // Total specs on the page < 3 (before: per-block < 2 = too lax)
  const totalSpecs = blocks.reduce((sum, b) => sum + b.specs.length, 0);
  return totalSpecs < 3;
}

/** Ratio of the largest individual image / page area.
 *  Detects full-bleed covers like Catalogue C "NOS MARQUES" (1 large image +
 *  design text). On Catalogue A: 40+ small variant images → max ~5%. */
export function computeLargestImageRatio(page: ExtractedPage): number {
  const pageArea = page.page_size.width * page.page_size.height;
  if (pageArea <= 0) return 0;
  const images = page.raw_images ?? [];
  let maxArea = 0;
  for (const bbox of images) {
    const w = Math.max(0, bbox[2] - bbox[0]);
    const h = Math.max(0, bbox[3] - bbox[1]);
    const area = w * h;
    if (area > maxArea) maxArea = area;
  }
  return Math.min(1, maxArea / pageArea);
}

/** Ratio of the surface covered by images on the page. Approximation: sum of
 *  the (bbox) areas divided by the total page area. Caps at 1 if bboxes
 *  overlap (we do not do a geometric union, just a capped sum for
 *  performance). */
export function computeImageCoverageRatio(page: ExtractedPage): number {
  const pageArea = page.page_size.width * page.page_size.height;
  if (pageArea <= 0) return 0;
  const images = page.raw_images ?? [];
  let totalImgArea = 0;
  for (const bbox of images) {
    const w = Math.max(0, bbox[2] - bbox[0]);
    const h = Math.max(0, bbox[3] - bbox[1]);
    totalImgArea += w * h;
  }
  return Math.min(1, totalImgArea / pageArea);
}

const INTRO_BRAND_IMAGE_RATIO = 0.4;

// ─── Multilingual sommaire/glossaire/tech keywords ────────────────────────

// Note: we prefer MULTI-WORD phrases rather than single, overly generic words
// ("contents", "legende", "symbols") that would match common phrases on
// product pages (false positives).
const TOC_KEYWORDS = [
  // FR
  'table des matieres', 'sommaire', 'index alphabetique', 'index par couleur',
  'index general', 'index produits',
  // EN
  'table of contents', 'alphabetical index', 'color index', 'colour index',
  'product index', 'general index',
  // ES
  'indice alfabetico', 'indice de colores', 'tabla de contenidos',
  'indice general', 'indice de productos',
  // DE
  'inhaltsverzeichnis', 'farbindex', 'produktindex', 'gesamtindex',
  // IT
  'indice alfabetico', 'indice dei colori', 'sommario',
  'indice generale', 'indice prodotti',
  // PT
  'sumario', 'indice de cores', 'tabela de conteudos', 'indice geral',
];

const GLOSSAIRE_KEYWORDS = [
  // FR
  'glossaire des pictogrammes', 'glossaire pictogrammes',
  'legende des pictogrammes', 'legende des symboles',
  // EN
  'pictogram glossary', 'index of pictograms', 'key to symbols',
  'symbol legend', 'icon legend',
  // DE
  'piktogramm', 'piktogramme', 'zeichenerklarung', 'symbolerklarung',
  'symbollegende',
  // ES
  'leyenda de pictogramas', 'leyenda de simbolos', 'glosario de pictogramas',
  // IT
  'legenda dei pittogrammi', 'legenda dei simboli',
  // PT
  'legenda dos pictogramas', 'legenda dos simbolos',
];

const TECH_KEYWORDS = [
  // FR
  'cahier technique', 'aide technique', 'fiche technique', 'synoptique',
  'notice technique', 'donnees techniques', 'caracteristiques techniques',
  // EN
  'technical sheet', 'technical guide', 'technical data',
  'technical specifications', 'data sheet', 'datasheet', 'spec sheet',
  // ES
  'ficha tecnica', 'datos tecnicos', 'guia tecnica',
  'especificaciones tecnicas',
  // DE
  'technisches datenblatt', 'technische daten',
  'technische spezifikationen', 'datenblatt',
  // IT
  'scheda tecnica', 'dati tecnici', 'specifiche tecniche',
  // PT
  'ficha tecnica', 'dados tecnicos', 'especificacoes tecnicas',
];

/**
 * Searches the page for a keyword identifying a sommaire / glossaire / cahier
 * tech. On match: returns the corresponding PageKind. Accent- and
 * case-insensitive (template pages may have "Sommaire" or "SOMMAIRE").
 */
function matchUnwantedKeyword(page: ExtractedPage): PageKind | null {
  const spans = page.raw_spans ?? [];
  if (spans.length === 0) return null;
  // Concat top + bottom spans to match the typical titles of a tech page. We
  // normalize once to avoid costly N*M comparisons.
  const normalized = spans
    .map((s) => stripAccents(s.text).toLowerCase())
    .join(' | ');
  for (const kw of TOC_KEYWORDS) if (normalized.includes(kw)) return 'toc';
  for (const kw of GLOSSAIRE_KEYWORDS) if (normalized.includes(kw)) return 'glossaire';
  // Cahier technique → 'tech' (correct semantics, audit #8). Handled as a
  // drop by engineOrchestrator just like 'glossaire'.
  for (const kw of TECH_KEYWORDS) if (normalized.includes(kw)) return 'tech';
  return null;
}

// stripAccents: see textNormalize.ts (factored out from 4 copies, audit #6).

function isGlossairePictos(page: ExtractedPage): boolean {
  const spans = page.raw_spans ?? [];
  if (spans.length < 25) return false;
  const shortLabels = spans.filter((s) => {
    const t = s.text.trim();
    return t.length >= 3 && t.length < 40 && !t.includes('.') && !hasKeyValueSeparator(t);
  });
  if (shortLabels.length < 12) return false;
  if (shortLabels.length / spans.length < 0.45) return false;
  const decoVector = page.slots.filter(
    (s) =>
      s.type === 'decoration' &&
      (s as { kind?: string }).kind === 'vector',
  ).length;
  // P1.6: relative threshold. A pictogram glossary typically has 5-20 paths
  // per label. < 5x = a sommaire page with normal decoration, not a glossary.
  // The absolute threshold 150 keeps a minimum floor (case of very many spans
  // but few pictograms).
  if (decoVector < 50) return false;
  return decoVector >= shortLabels.length * 5;
}
