/**
 * Detects product blocks on an extracted page, using a TemplateProfile.
 *
 * TS port of python/substitute.py:find_product_blocks (L1494). The logic is
 * 100% typographic + geometric heuristic, no LLM.
 *
 * Output: an array of ProductBlock describing each product sheet detected on
 * the page (often 2-4 per page depending on the template).
 */

import type { Bbox, ExtractedPage, TextSpan } from '../types';
import type { TemplateProfile } from './profile';
import { hasKeyValueSeparator } from './keyValueSeparator';
import { isCommonColor } from './colorPalette';

export interface ProductSpecBlock {
  key: TextSpan;
  values: TextSpan[];
}

export interface ProductBlock {
  pageNumber: number;
  nameSpan: TextSpan;
  /** Number of spans merged to form nameSpan (multi-line wrapping case). */
  nameWrappedCount: number;
  refSpan: TextSpan | null;
  colorSpan: TextSpan | null;
  specs: ProductSpecBlock[];
  /** Bbox of the square variant thumbnails (extracted from raw_images). */
  variantImages: Bbox[];
  /** Label spans associated with the variants (under the header, in the product column). */
  variantSpans: TextSpan[];
  /** Main product image (the largest, to the left of the specs). */
  mainImageBbox: Bbox | null;
  yTop: number;
  yBottom: number;
  specsYTop: number;
  specsYBottom: number;
  specsXLeft: number;
  /** Horizontal layout (multi-col mode like Catalogue C/Catalogue B) detected
   *  on this page. When true, the blocks share their keys (common left
   *  column) and their values in parallel columns. Downstream (reflowSpecsV2)
   *  must handle this case specifically, otherwise the visual ops overlap. */
  isHorizontalLayout?: boolean;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Computes the Y tolerance for grouping nameSpans into rows (horizontal
 *  mode). Adapted to the font size to avoid being too strict at a large
 *  format. Floor 4pt (Catalogue A 16pt case). */
export function computeYRowTolerance(nameSize: number): number {
  return Math.max(4, nameSize * 0.30);
}

/** Detects section titles (CHECK-LIST, LES + PRODUITS, ACCESSOIRES...) that
 *  may look like product names (all-caps, medium size, bold-condensed font)
 *  but are NOT substitutable sheets.
 *
 *  Catalogue C P14 flaw: "CHECK-LIST ACCESSOIRES" detected as a 4th product
 *  block → the pipeline tries to substitute it with a Catalogue D product.
 *
 *  Criterion: all-caps text containing a recognizable section-header keyword.
 *  Multi-language: FR, EN, DE, ES (international catalogs). */
function looksLikeSectionHeader(text: string): boolean {
  const t = text.trim().toUpperCase();
  // FR: check-list, les + produits, accessoires...
  // Note: no trailing \b because patterns ending in a symbol ("LES +") are
  // followed by non-word spaces that invalidate \b.
  const FR_RE = /^(?:CHECK-?LIST|LES\s*\+|OPTIONS?|ACCESSOIRES?|CARACT[ÉE]RISTIQUES|GAMMES?|NOS\s+(?:MARQUES|GAMMES|PRODUITS|SOLUTIONS)|BIEN\s+CHOISIR|COMMENT\s+CHOISIR|CONSEILS?|RÉCAPITULATIF|FOURNIS|CONSEILL[ÉE]S|INFOS?\s+PRODUITS?|DESCRIPTION)(?=$|\s|[^A-Z])/i;
  const EN_RE = /^(?:CHECKLIST|ACCESSORIES|OPTIONS?|FEATURES?|PRODUCT\s+(?:HIGHLIGHTS|INFO|DETAILS)|HOW\s+TO\s+CHOOSE|CHOOSE\s+YOUR|TIPS?|SPECIFICATIONS?|INCLUDED|SUPPLIED|HIGHLIGHTS)(?=$|\s|[^A-Z])/i;
  const DE_RE = /^(?:ZUBEHÖR|OPTIONEN?|EIGENSCHAFTEN|TIPPS?|MERKMALE|PRODUKTINFO|TECHNISCHE\s+DATEN)(?=$|\s|[^A-Z])/i;
  const ES_RE = /^(?:ACCESORIOS?|OPCIONES?|CARACTER[ÍI]STICAS|VENTAJAS|CONSEJOS?|DETALLES|INCLUIDO)(?=$|\s|[^A-Z])/i;
  // Catalogue C catalog subtitles: "POMPES D'ÉVACUATION POUR EAUX CLAIRES",
  // "POMPES D'ARROSAGE MANUELLES", "AUTRE POMPE 12V", "APRÈS-VENTE",
  // "FORMATIONS", "SERVICE", "AGRÉÉ", "EAUX CLAIRES/CHARGÉES/...".
  // Apostrophe: uses \S to match ALL quotes/apostrophes (ASCII ' U+0027,
  // smart ’ U+2019, etc.) without a Unicode-codepoint dependency.
  // These patterns do NOT match Catalogue A product names (a plumbing catalog
  // does not start with "POMPES" and does not include these service terms).
  const CATALOGC_SUBTITLES_RE = /^(?:POMPES?\s+(?:D\S|DE\s+|POUR\s+|À\s+)|AUTRE\s+POMPES?|APR[ÉE]S[-\s]VENTE|FORMATIONS?|AGR[ÉE]+|EAUX\s+(?:CLAIRES?|CHARG[ÉE]ES?|GRISES?|NOIRES?|US[ÉE]ES?)|GROUPES?\s+DE\s+(?:SURPRESSION|FILTRATION))/i;
  return FR_RE.test(t) || EN_RE.test(t) || DE_RE.test(t) || ES_RE.test(t) || CATALOGC_SUBTITLES_RE.test(t);
}

/** Detects legal notices / copyright / marketing notices that can
 *  contaminate the specs zone (review flaw: a span "© 2024 Marque, tous
 *  droits réservés" in Regular font in the specs zone was attributed to a
 *  spec as a value).
 *
 *  Criteria (any one suffices):
 *   - contains a typographic notice marker (©, ®, ™)
 *   - very long sentence (> 80 chars) with multiple words (≥ 8 words)
 *   - starts with a notice marker: "Crédit", "Photo", "Document non"
 *
 *  Conservative: NEVER touches a real product value (short, without ©). */
export function looksLikeLegalNotice(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // Typographic markers
  if (/[©®™]/.test(t)) return true;
  // Common legal-notice patterns
  if (/^(Cr[ée]dit\s+photo|Photo\s+credit|Document\s+non\s+contractuel|Tous\s+droits\s+r[ée]serv[ée]s|All\s+rights\s+reserved)/i.test(t)) {
    return true;
  }
  // Very long sentence with many words = notice/disclaimer
  if (t.length > 80) {
    const words = t.split(/\s+/).filter((w) => w.length > 1);
    if (words.length >= 8) return true;
  }
  return false;
}

/** Generic heuristic: detects whether a text looks like a barcode or printed
 *  pictogram.
 *
 *  Criteria (any one suffices):
 *   - 100% digits + spaces (bare ref like EAN-13 "3325310022366")
 *   - >30% special symbols (printed barcode "&:DCPNLA=UWWX[[:")
 *   - letter ratio < 50% AND not alphanum-pure
 *
 *  Exception (review flaw #): an alphanum-pure text (letters+digits >= 80%)
 *  that is short (<= 30 chars) is considered a legitimate name/ref, even if
 *  the letter ratio is low (Catalogue E "DN50 PN16" case, short alphanum
 *  refs "AB12345"). */
export function looksLikeBarcode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const nonWs = trimmed.replace(/\s/g, '');
  if (nonWs.length === 0) return false;
  // 100% digits (spaces allowed) = bare ref or EAN, BUT only if long enough
  // (>= 5 digits) — otherwise "100", "250", "400", which are legitimate
  // suffixes of product names (ECOP 100, ECL 250), would be wrongly excluded
  // (Catalogue C P14 flaw).
  if (/^[\d\s]+$/.test(trimmed) && nonWs.length >= 5) return true;
  const letters = (nonWs.match(/[a-zA-ZÀ-ÿœŒæÆ]/g) ?? []).length;
  const digits = (nonWs.match(/\d/g) ?? []).length;
  const symbols = nonWs.length - letters - digits;
  // Alphanum-pure (letters + digits >= 80%): legit product name / ref. Capped
  // at 30 chars: beyond that we are probably facing a long technical
  // identifier (URL, hash) that should not be a product name.
  if (nonWs.length <= 30 && (letters + digits) / nonWs.length >= 0.8) {
    return false;
  }
  // Strong symbol presence (>30%) = printed barcode/pictogram
  if (symbols / nonWs.length > 0.3) return true;
  // Conservative: letter ratio < 50%
  return letters / nonWs.length < 0.5;
}

export function findProductBlocks(
  page: ExtractedPage,
  profile: TemplateProfile,
): ProductBlock[] {
  const spans = page.raw_spans ?? [];
  const images = page.raw_images ?? [];
  if (spans.length === 0) return [];

  // ─── 1. Find all "product name" candidate spans ───────────────────────────
  // Additional GENERIC filter: exclude strings that look like barcodes or
  // printed symbols (non-letter character ratio > 50%). Known cases: EAN-13
  // "&:DCPNLA=UWWX[[:" (Catalogue C), printed pictograms "■▶◀●" (design
  // catalogs), bare refs "3325310022366" (all digits). A real product brand
  // has a majority of letters.
  // Fuzzy font matching: on some catalogs the profile detects an
  // "overly specific" pattern (e.g. Catalogue C detects "MdCn" because the
  // chapter headers are often there, but the REAL product names are in plain
  // "Cn"). Strategy: strict match first; on total failure (<2 candidates
  // after the size/X filter), retry with a DISCRIMINATING TYPO TOKEN present
  // in the pattern, chosen from a conservative whitelist (the standard
  // PostScript/Adobe typographic suffixes).
  //
  // SAFETY: only kicks in if the pattern contains a known typo token. Avoid
  // "ld" extracted from "SemiBold" which would match "Bold"/"OldStyle"/etc.
  // → potential Catalogue A breakage (nameFontPattern="SemiBold" → strict stays).
  const TYPO_TOKENS = ['Cn', 'Bd', 'Lt', 'Th', 'Rg', 'It', 'Md', 'Sm', 'Ult', 'Hv', 'Bk'];
  const matchFontStrict = (s: TextSpan) => s.font.includes(profile.nameFontPattern);
  const fuzzyToken = TYPO_TOKENS.find((tok) => profile.nameFontPattern.includes(tok));
  const matchFontFuzzy = fuzzyToken
    ? (s: TextSpan) => s.font.includes(fuzzyToken)
    : matchFontStrict;
  // Pre-pass: strict matching. If <2 hits, switch to fuzzy (if it exists).
  const strictHits = spans.filter(
    (s) =>
      matchFontStrict(s) &&
      s.size >= profile.nameSizeRange[0] &&
      s.size <= profile.nameSizeRange[1] &&
      s.bbox[0] < profile.nameXMax &&
      !looksLikeBarcode(s.text) &&
      !looksLikeSectionHeader(s.text),
  );
  const useFuzzy = strictHits.length < 2 && fuzzyToken !== undefined;
  const matchFont = useFuzzy ? matchFontFuzzy : matchFontStrict;
  const rawNameSpans = spans
    .filter(
      (s) =>
        matchFont(s) &&
        s.size >= profile.nameSizeRange[0] &&
        s.size <= profile.nameSizeRange[1] &&
        s.bbox[0] < profile.nameXMax &&
        !looksLikeBarcode(s.text) &&
        !looksLikeSectionHeader(s.text),
    )
    // Sort by ascending Y then ascending X: critical for the horizontal
    // merge (same Y) or vertical merge (same X), which iterates over
    // consecutive spans.
    .sort((a, b) => {
      const dy = a.bbox[1] - b.bbox[1];
      if (Math.abs(dy) > 1) return dy;
      return a.bbox[0] - b.bbox[0];
    });

  // ─── 2. Merge names wrapped across multiple lines ──────────────────────────
  // Two merge modes:
  //  - VERTICAL: same X start + consecutive Y (= name wrapped over 2 lines)
  //  - HORIZONTAL: same Y + X end ≈ next X start (small gap < 10pt)
  //    Catalogue C P14 case: "ECOP" + " 100" are 2 separate but adjacent spans.
  //    Horizontal merge ONLY if the gap is small (otherwise "ECOP 100" and
  //    "ECL 250" would wrongly merge, they are 69pt apart).
  const HORIZONTAL_MERGE_MAX_GAP = 10;
  const nameSpans: { span: TextSpan; wrapped: number }[] = [];
  let i = 0;
  while (i < rawNameSpans.length) {
    const s = rawNameSpans[i];
    let mergedText = s.text.replace(/\s+$/, '');
    const mergedBbox: Bbox = [s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]];
    let j = i + 1;
    while (j < rawNameSpans.length) {
      const t = rawNameSpans[j];
      const sizeOk = Math.abs(t.size - s.size) < profile.nameMergeSizeTolerance;
      const verticalMerge =
        Math.abs(t.bbox[0] - s.bbox[0]) < profile.nameMergeXTolerance &&
        t.bbox[1] - mergedBbox[3] < profile.nameMergeYTolerance;
      const horizontalMerge =
        Math.abs(t.bbox[1] - s.bbox[1]) < profile.nameMergeYTolerance &&
        t.bbox[0] - mergedBbox[2] >= -2 &&
        t.bbox[0] - mergedBbox[2] < HORIZONTAL_MERGE_MAX_GAP;
      if (sizeOk && (verticalMerge || horizontalMerge)) {
        mergedText += ' ' + t.text.trim();
        mergedBbox[2] = Math.max(mergedBbox[2], t.bbox[2]);
        mergedBbox[3] = Math.max(mergedBbox[3], t.bbox[3]);
        j++;
      } else {
        break;
      }
    }
    nameSpans.push({
      span: { ...s, text: mergedText, bbox: mergedBbox },
      wrapped: j - i,
    });
    i = j;
  }

  // ─── 2bis. Layout mode detection (vertical vs horizontal) ─────────────────
  //
  // For each page, we check whether several nameSpans are at the same Y
  // (= header row of N product columns, layout like Catalogue C / Catalogue
  // B). Otherwise = classic vertical layout (1 product per Y row).
  //
  // Criterion: the dominant Y row (= the one with the most names) must have
  // ≥ 2 names AND ≥ 50% of the page's names. Avoids false positives where 2
  // names are accidentally aligned.
  //
  // Conservative: Catalogue A stays in vertical mode (each row has a single name).
  //
  // Tolerance adapted to the font size (review flaw: absolute 4pt was too
  // strict at a large format 24pt+ where baseline jitter can exceed 4pt).
  // Formula: max(4, nameSize_median * 0.30). On Catalogue A (16pt) → 4.8,
  // practically unchanged. At a large format (24pt) → 7.2, more tolerant.
  const yRowTolBase =
    nameSpans.length > 0
      ? nameSpans
          .map((ns) => ns.span.size)
          .sort((a, b) => a - b)[Math.floor(nameSpans.length / 2)]
      : profile.nameSizeRange[1];
  const Y_ROW_TOL = computeYRowTolerance(yRowTolBase);
  const rowGroups: { y: number; count: number }[] = [];
  for (const ns of nameSpans) {
    const y = ns.span.bbox[1];
    const existing = rowGroups.find((g) => Math.abs(g.y - y) <= Y_ROW_TOL);
    if (existing) existing.count++;
    else rowGroups.push({ y, count: 1 });
  }
  const maxRowCount = rowGroups.reduce((m, g) => Math.max(m, g.count), 0);
  // Relaxed thresholds (Catalogue C flaw: the old 3/0.4 missed the 2-col or
  // 3-col cases with residual Y jitter). New: 2/0.4 OR 3/0.33.
  // Conservative Catalogue A: 3 products on 3 distinct rows → maxRowCount=1,
  // ratio 1/3=0.33 → 1 < 2 → stays vertical. OK.
  const isHorizontalLayout =
    nameSpans.length >= 2 &&
    ((maxRowCount >= 2 && maxRowCount / nameSpans.length >= 0.4) ||
      (maxRowCount >= 3 && maxRowCount / nameSpans.length >= 0.33));

  // ─── 3. For each name: delimit the block + extract ref/color/specs ────────
  const blocks: ProductBlock[] = [];
  const pageH = page.page_size.height;

  /** Horizontal mode: returns yBottom = top of the NEXT Y row (≠ same row). */
  const findNextRowY = (currentY: number): number => {
    let minNext = Infinity;
    for (const ns of nameSpans) {
      const y = ns.span.bbox[1];
      if (y - currentY > Y_ROW_TOL && y < minNext) minNext = y;
    }
    return minNext;
  };

  /** Horizontal mode: xRightBound = X of the next name in the SAME row. */
  const findXRightBound = (currentX: number, currentY: number): number => {
    let minRight = Infinity;
    for (const ns of nameSpans) {
      const y = ns.span.bbox[1];
      const x = ns.span.bbox[0];
      if (Math.abs(y - currentY) > Y_ROW_TOL) continue;
      if (x > currentX && x < minRight) minRight = x;
    }
    return minRight;
  };

  for (let bi = 0; bi < nameSpans.length; bi++) {
    const { span: nameSpan, wrapped } = nameSpans[bi];
    const yTop = nameSpan.bbox[1];
    let yBottom: number;
    let xLeftBound = -Infinity;
    let xRightBound = Infinity;
    if (isHorizontalLayout) {
      // yBottom = next ROW Y (not next nameSpan Y, which would be the same row)
      const nextRow = findNextRowY(yTop);
      yBottom = nextRow < Infinity
        ? nextRow - profile.blockYGap
        : pageH - profile.blockLastBottomMargin;
      // xBounds: xLeft = 0 to include the shared KEYS (left column common to
      // all blocks in the row). xRight = X of the next name in the SAME row
      // to isolate the values of this column.
      xLeftBound = 0;
      xRightBound = findXRightBound(nameSpan.bbox[0], yTop);
    } else {
      // Vertical mode (Catalogue A, Catalogue E, etc.) — legacy behavior
      yBottom =
        bi + 1 < nameSpans.length
          ? nameSpans[bi + 1].span.bbox[1] - profile.blockYGap
          : pageH - profile.blockLastBottomMargin;
    }

    const blockSpans = spans.filter(
      (s) =>
        s.bbox[1] >= yTop &&
        s.bbox[1] < yBottom &&
        s.bbox[0] >= xLeftBound &&
        s.bbox[0] < xRightBound,
    );

    // ─── Header: ref + color under the name ──────────────────────────────────
    const headerZoneH = Math.max(
      profile.blockHeaderZoneHeight,
      nameSpan.size * profile.blockHeaderZoneSizeRatio,
    );
    const headerXMax = isHorizontalLayout
      ? Math.min(xRightBound, Math.max(profile.nameXMax, profile.specsXMin))
      : Math.max(profile.nameXMax, profile.specsXMin);
    const [crMin, crMax] = profile.colorRefSizeRange;

    let refSpan: TextSpan | null = null;
    let colorSpan: TextSpan | null = null;
    const headerCandidates: TextSpan[] = [];

    for (const s of blockSpans) {
      if (s === nameSpan) continue;
      if (s.bbox[1] >= yTop + headerZoneH || s.bbox[0] >= headerXMax) continue;
      // Horizontal multi-cols FIX: restrict the header zone to the COLUMN of
      // the current block (X >= nameSpan.X) and UNDER the name (Y >
      // nameSpan.Y3). Otherwise, on templates like Catalogue C where the 3
      // names share the Y row, the sub-spans that make up the merged virtual
      // nameSpan (e.g. "ECOP" + "100" → "ECOP 100") stay in blockSpans and
      // become header/color/ref candidates for blocks 2/3, which thus take
      // block 1's color/ref by mistake (botched Insert_text positioning).
      if (isHorizontalLayout) {
        if (s.bbox[0] < nameSpan.bbox[0]) continue;
        if (s.bbox[1] < nameSpan.bbox[3]) continue;
      }
      // Exclude barcode fonts (EanT30L, Ean13, ITF, etc.): these are opaque
      // glyphs that pass the color/ref filters (no visible digit in the text)
      // but are NOT human content. On Catalogue C the EANs under each name
      // polluted the colorSpan via tier 3.
      const fontLower = s.font.toLowerCase();
      if (fontLower.includes('ean') || fontLower.includes('barcode') ||
          fontLower.includes('code128') || fontLower.includes('code39')) {
        continue;
      }
      headerCandidates.push(s);
      const hasDigit = /\d/.test(s.text);
      // Strict rules: ref = ref font + digit, color = color font + no digit
      if (!refSpan && s.font.includes(profile.headerRefFontPattern) && hasDigit) {
        refSpan = s;
      } else if (
        !colorSpan &&
        s.font.includes(profile.headerColorFontPattern) &&
        s.size >= crMin &&
        s.size <= crMax &&
        !hasDigit
      ) {
        colorSpan = s;
      }
    }
    // Tier 2: if no color span found, try the palette of common color/finish
    // names (multi-language). Much more reliable than "first span without a
    // digit" when the template has a non-standard color font, because the
    // palette discriminates semantically.
    if (!colorSpan && headerCandidates.length > 0) {
      for (const s of headerCandidates) {
        if (s === refSpan) continue;
        if (isCommonColor(s.text)) {
          colorSpan = s;
          break;
        }
      }
    }
    // Tier 3 (permissive fallback): first span with a digit = ref, first
    // without = color. Final guard for color names outside the palette (RAL
    // codes, commercial names, exotic finishes).
    if ((!refSpan || !colorSpan) && headerCandidates.length > 0) {
      const sorted = [...headerCandidates].sort(
        (a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0],
      );
      for (const s of sorted) {
        const hasDigit = /\d/.test(s.text);
        if (!refSpan && hasDigit) refSpan = s;
        else if (!colorSpan && !hasDigit) colorSpan = s;
      }
    }

    // ─── Specs: keys + values ────────────────────────────────────────────────
    const specsZone = blockSpans.filter((s) => s.bbox[0] > profile.specsXMin);
    let keys = specsZone
      .filter(
        (s) => s.font.includes(profile.keyFontPattern) && hasKeyValueSeparator(s.text),
      )
      .sort((a, b) => a.bbox[1] - b.bbox[1]);
    // Tabular fallback (horizontal multi-cols mode): keys without `:` but
    // Y-aligned with ≥1 value in the block's X zone (on the right).
    // Catalogue C / Catalogue B case: "Référence" / "Puissance" in a shared
    // left column, values in parallel columns.
    //
    // In horizontal mode, we ALWAYS PREFER the tabular fallback over the
    // inline "X : value" keys (which are actually VALUES wrongly detected).
    // Catalogue C P29 surface sheets case: "19 mm : 2 sur 25 m" (= dimension
    // specs) was captured as a key. With keys.length>0 the fallback did not
    // kick in → reflow placed the new specs at Y=476 (wrong line) instead of
    // Y=305 (Puissance). So in horizontal mode we FORCE the fallback.
    if (isHorizontalLayout) {
      // Strict keyXMax: the COMMON left column is typically at X ≈ specsXMin
      // (~50pt). Beyond that we enter a neighboring block's column and risk
      // capturing its VALUES as keys (Catalogue C case: "600 W" value of
      // block 0 at X=237 was captured as a key of block 1 at X=337 because
      // keyXMax=block1.X-4=333 was too wide). We cap at specsXMin + 20.
      const keyXMax = Math.min(nameSpan.bbox[0] - 4, profile.specsXMin + 20);
      const valueXMin = nameSpan.bbox[0];
      keys = blockSpans
        .filter((s) => {
          if (s === nameSpan) return false;
          const txt = s.text.trim();
          if (txt.length < 3) return false;
          if (looksLikeBarcode(txt)) return false;
          if (s.bbox[0] >= keyXMax) return false;
          if (s.size > profile.keySize * 1.5) return false; // not a large title
          if (Math.abs(s.size - profile.keySize) > 2) return false;
          // At least one same-Y value in the block's X zone
          const hasValue = blockSpans.some(
            (v) =>
              v !== s &&
              Math.abs(v.bbox[1] - s.bbox[1]) <= profile.specInlineYTolerance &&
              v.bbox[0] >= valueXMin,
          );
          return hasValue;
        })
        .sort((a, b) => a.bbox[1] - b.bbox[1]);
    }
    // Accept the profile's value font (typically "Light") OR the Regular font
    // which is a common fallback on short values. Do not hardcode only
    // valueFontPattern: some Catalogue A specs mix the two families in the
    // same zone (e.g. a value in Regular amidst Light) and would otherwise be
    // ignored.
    //
    // Anti-contamination filter (review flaw): we exclude spans containing
    // typographic legal-notice markers (©®™) or long notice/copyright-style
    // sentences. Never touches a real product value (which has no © and is
    // short).
    const lights = specsZone.filter((s) => {
      const fontMatch =
        s.font.includes(profile.valueFontPattern)
        || s.font.includes(profile.headerRefFontPattern);
      if (!fontMatch) return false;
      // Exclude typographic legal-notice markers
      if (looksLikeLegalNotice(s.text)) return false;
      return true;
    });

    const specs: ProductSpecBlock[] = [];
    const attributed = new Set<TextSpan>();
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki];
      attributed.add(key);
      const keyY0 = key.bbox[1];
      const keySize = key.size ?? profile.keySize;
      const keyBaselineBottom = keyY0 + keySize;
      const keyX0 = key.bbox[0];
      const keyX1 = key.bbox[2];
      // Lower bound for the current value: Y of the next key (or the block's
      // yBottom if it is the last key). Prevents absorbing the next spec's
      // value during multi-line continuation.
      const nextKeyY = ki + 1 < keys.length ? keys[ki + 1].bbox[1] : yBottom;

      const inline = lights.filter(
        (v) =>
          Math.abs(v.bbox[1] - keyY0) <= profile.specInlineYTolerance &&
          v.bbox[0] >= keyX1 - profile.specInlineXTolerance,
      );
      // MULTI-LINE continuation: we iteratively collect the X-aligned and
      // Y-consecutive lines. Stop criteria:
      //   - we reach the Y of the next key
      //   - a candidate line is too far (gap > keySize + extra) from the last
      //     accepted line → the value has finished wrapping
      // Lets us capture long descriptions/specs that span 3+ lines
      // ("Garantie : 5 ans piece et main d'oeuvre dans le reseau Catalogue A
      // partenaire" → 3 wrapped lines).
      const continuationCandidates = lights
        .filter((v) => {
          if (v.bbox[1] < keyBaselineBottom) return false;
          if (v.bbox[1] >= nextKeyY) return false;
          if (Math.abs(v.bbox[0] - keyX0) > profile.specContinuationXTolerance)
            return false;
          return true;
        })
        .sort((a, b) => a.bbox[1] - b.bbox[1]);

      const continuation: TextSpan[] = [];
      let lastBottom = keyBaselineBottom;
      const maxGap = keySize + profile.specContinuationYExtra;
      // Guard (review flaw): strict limit on the number of accepted
      // continuation lines. Beyond 5 lines after the key, we have probably
      // absorbed content from another spec or section.
      //   Catalogue A reference: "Garantie : 5 ans piece et main d'oeuvre dans
      //   le reseau Catalogue A partenaire" wraps over 3 lines. So 5 is
      //   conservative (leaves margin without breaking).
      const MAX_CONTINUATION_LINES = 5;
      // Absolute max Y = keyY0 + 5 lines (avoid descending into a neighboring
      // key's zone when nextKeyY is far - case of the block's last spec with a
      // poorly calibrated yBottom).
      const yMaxContinuation = keyY0 + MAX_CONTINUATION_LINES * (keySize + 2);
      for (const v of continuationCandidates) {
        // Consecutive line: the top of v is close to the bottom of the last
        // accepted line (or of the key).
        if (v.bbox[1] - lastBottom > maxGap) break;
        if (continuation.length >= MAX_CONTINUATION_LINES) break;
        if (v.bbox[1] > yMaxContinuation) break;
        continuation.push(v);
        lastBottom = v.bbox[3];
      }

      const vals = [...inline, ...continuation];
      vals.forEach((v) => attributed.add(v));
      specs.push({ key, values: vals });
    }
    // If no specs detected (template without a "key:value" pattern), we
    // still accept the block IF the name is confirmed + at least one signal:
    // header (ref/color) OR a bitmap image in the block zone.
    if (specs.length === 0) {
      const hasHeader = refSpan !== null || colorSpan !== null;
      const hasImage = images.some(
        (b) => b[0] < profile.specsXMin && b[1] >= yTop && b[1] < yBottom,
      );
      if (!hasHeader && !hasImage) continue;
    }

    const specsYTop = specs.length > 0 ? specs[0].key.bbox[1] : nameSpan.bbox[3] + 4;
    const allYBottoms: number[] = [];
    for (const { key, values } of specs) {
      allYBottoms.push(key.bbox[3]);
      for (const v of values) {
        if (v.text.trim()) allYBottoms.push(v.bbox[3]);
      }
    }
    const specsYBottom =
      allYBottoms.length > 0 ? Math.max(...allYBottoms) : yBottom - 10;
    const specsXLeft =
      specs.length > 0
        ? Math.min(...specs.map((s) => s.key.bbox[0]))
        : profile.specsXMin;

    // ─── Variants: square images + label spans ────────────────────────────────
    const headerBottom =
      (colorSpan ? colorSpan.bbox[3] : refSpan ? refSpan.bbox[3] : nameSpan.bbox[3]) +
      profile.blockHeaderExcludeYOffset;
    const [vcMin, vcMax] = profile.variantCircleSizeRange;
    const [sqMin, sqMax] = profile.squareRatioRange;
    const variantImages = images.filter((b) => {
      const w = b[2] - b[0];
      const h = b[3] - b[1];
      return (
        b[0] < profile.specsXMin &&
        b[1] >= headerBottom &&
        b[1] < yBottom &&
        w >= vcMin &&
        w <= vcMax &&
        h >= vcMin &&
        h <= vcMax &&
        w / Math.max(h, 1) >= sqMin &&
        w / Math.max(h, 1) <= sqMax
      );
    });

    const attributedHeader = new Set<TextSpan>();
    if (colorSpan) attributedHeader.add(colorSpan);
    if (refSpan) attributedHeader.add(refSpan);
    attributedHeader.add(nameSpan);
    // Variants: color labels in the zone under the header, size similar to
    // the colorSpan. The font filter is permissive (color OR ref OR text
    // recognized as a palette color): some templates use an alternative font
    // for the variant labels that profile detection does not catch.
    const variantSpans = blockSpans.filter(
      (s) =>
        s.bbox[0] < profile.specsXMin &&
        s.bbox[1] >= headerBottom &&
        s.bbox[1] < yBottom &&
        !attributedHeader.has(s) &&
        s.size >= crMin &&
        s.size <= crMax &&
        (s.font.includes(profile.headerColorFontPattern) ||
          s.font.includes(profile.headerRefFontPattern) ||
          isCommonColor(s.text)),
    );

    // ─── Main product image ───────────────────────────────────────────────────
    const mainImageBbox = findMainProductImage(yTop, yBottom, page.page_size.width, images, profile);

    // Anti-false-positive filter: a "product block" must have at least one
    // real-sheet signal (ref, ≥1 spec, or a main image). Otherwise it is
    // probably a paragraph / section title that matches the font/size pattern
    // but is not a sheet. Without this filter, intro pages (like "Un
    // savoir-faire logistique", "Notre mission") become product → confused
    // allocator → bad substitution.
    const hasRealContent =
      refSpan !== null || specs.length > 0 || mainImageBbox !== null;
    if (!hasRealContent) continue;

    blocks.push({
      pageNumber: page.page_number,
      nameSpan,
      nameWrappedCount: wrapped,
      refSpan,
      colorSpan,
      specs,
      variantImages,
      variantSpans,
      mainImageBbox,
      yTop,
      yBottom,
      specsYTop,
      specsYBottom,
      specsXLeft,
      isHorizontalLayout,
    });
  }
  // Track pages with a detected horizontal layout: downstream (reflowSpecsV2)
  // does not yet handle it perfectly → observability lets us quantify the
  // impact before coding the S6.5 fix.
  if (isHorizontalLayout && blocks.length > 0) {
    recordHorizontalLayout(page.page_number, blocks.length);
  }

  // GENERIC page quality filter: if the page has many name candidates but few
  // become valid blocks, it is probably a complex page (multi-dim table,
  // unhandled multi-column layout, page with permanent content like a spec
  // table) that the pipeline cannot substitute cleanly. Better to drop
  // (return []) and let the allocator look for another page, rather than
  // substituting 1 block out of 5+ and leaving the rest as parasitic original
  // content.
  //
  // Conservatively calibrated thresholds:
  //   - rawNameSpans ≥ 5 (reliable signal of candidate richness)
  //   - valid blocks / candidates < 0.4 (< 40% conversion)
  //
  // On Catalogue A: product pages have 3 candidates = 3 blocks (100%, < 5 → no-op).
  // On Catalogue C p13: 8 candidates, 1-2 blocks (12-25% < 40% → drop).
  if (rawNameSpans.length >= 5 && blocks.length / rawNameSpans.length < 0.4) {
    recordDroppedPage(page.page_number, rawNameSpans.length, blocks.length);
    return [];
  }
  return blocks;
}

// ─── Silent-drop stats (debug / monitoring) ─────────────────────────────────
/** Counter of pages dropped by the quality filter.
 *  Lets the downstream (orchestrator) audit how many pages are silently
 *  eliminated. Reset between runs if needed via resetDroppedPages(). */
export interface DroppedPageInfo {
  pageNumber: number;
  rawNameSpans: number;
  blocks: number;
  ratio: number;
}
const droppedPages: DroppedPageInfo[] = [];
function recordDroppedPage(pageNumber: number, rawNameSpans: number, blocks: number) {
  droppedPages.push({
    pageNumber,
    rawNameSpans,
    blocks,
    ratio: rawNameSpans === 0 ? 0 : blocks / rawNameSpans,
  });
  // In a DEBUG_BLOCKS env, log explicitly (otherwise silent but inspectable).
  if (process.env.DEBUG_BLOCKS) {
    console.warn(
      `[blockDetector] page=${pageNumber} dropped: ${blocks}/${rawNameSpans} blocs (ratio=${(blocks / rawNameSpans).toFixed(2)} < 0.4)`,
    );
  }
}
export function getDroppedPages(): readonly DroppedPageInfo[] {
  return droppedPages;
}
export function resetDroppedPages(): void {
  droppedPages.length = 0;
}

// ─── Stats for pages with a horizontal layout (audit S6.5) ──────────────────
export interface HorizontalLayoutInfo {
  pageNumber: number;
  blockCount: number;
}
const horizontalLayoutPages: HorizontalLayoutInfo[] = [];
function recordHorizontalLayout(pageNumber: number, blockCount: number) {
  horizontalLayoutPages.push({ pageNumber, blockCount });
  if (process.env.DEBUG_BLOCKS) {
    console.warn(
      `[blockDetector] page=${pageNumber} layout horizontal (${blockCount} blocs) — reflowSpecsV2 mode horizontal pas encore implemente`,
    );
  }
}
export function getHorizontalLayoutPages(): readonly HorizontalLayoutInfo[] {
  return horizontalLayoutPages;
}
export function resetHorizontalLayoutPages(): void {
  horizontalLayoutPages.length = 0;
}

// ─── Main product image ───────────────────────────────────────────────────────

/**
 * Looks for the "main image" bitmap within a product block.
 * Criteria:
 *  - position: to the left of the specs, within the Y block
 *  - minimum size: > picto max (excludes NF/quality/labels)
 *  - exclusions: very tight round pictos (strict square ratio), decorative
 *    bands touching 2 opposite edges of the block
 *
 * If multiple candidates: takes the largest but penalizing extreme formats
 * (width >> height or vice-versa = likely a decorative band).
 */
function findMainProductImage(
  yTop: number,
  yBottom: number,
  pageWidth: number,
  images: Bbox[],
  profile: TemplateProfile,
): Bbox | null {
  const pictoMax = profile.pictoSizeRange[1];
  const blockH = yBottom - yTop;
  const candidates = images.filter((b) => {
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    if (b[0] >= profile.specsXMin) return false;
    if (b[1] < yTop || b[1] >= yBottom) return false;
    if (w < pictoMax || h < pictoMax) return false;
    // Reject decorative bands: touches both edges of the block
    const touchesTop = b[1] - yTop < 2;
    const touchesBottom = yBottom - b[3] < 2;
    if (touchesTop && touchesBottom) return false;
    // Reject full-height OR full-width bands over the block
    if (h > blockH * 0.9 && w > pageWidth * 0.6) return false;
    // Reject a full-width lateral band (horizontal collection logo)
    if (w > pageWidth * 0.5 && h < pictoMax * 2) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  // Score = area + bonus if the ratio is close to square (1:1 to 1:2).
  candidates.sort((a, b) => {
    const aW = a[2] - a[0], aH = a[3] - a[1];
    const bW = b[2] - b[0], bH = b[3] - b[1];
    const aRatio = Math.max(aW / aH, aH / aW);
    const bRatio = Math.max(bW / bH, bH / bW);
    // Penalty: for each unit beyond 1.0 we remove 5% of the area.
    const aScore = aW * aH * (1 - Math.min(0.5, (aRatio - 1) * 0.05));
    const bScore = bW * bH * (1 - Math.min(0.5, (bRatio - 1) * 0.05));
    return bScore - aScore;
  });
  return candidates[0];
}
