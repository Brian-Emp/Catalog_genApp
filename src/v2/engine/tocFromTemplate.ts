/**
 * Smart sommaire: reuses the template's ORIGINAL sommaire page (with its
 * decoration, title, typography) and substitutes the entries with the
 * sections of the generated catalog.
 *
 * Strategy:
 *   1. Find the first kind='toc' page that contains spans matching "p.\d+"
 *      (= a real sommaire with page references)
 *   2. Parse the original entries: for each "p.XX", find the label on the
 *      left on the same Y line
 *   3. Generate ops:
 *      - erase_rect on each label + page number
 *      - insert_text with the new label + new page number (template style
 *        preserved: same font / size / color / bbox)
 *   4. The caller positions this page just before the first product page
 */
import type { Bbox, ExtractedPage, Operation, TextSpan } from '../types';
import type { PageClassification } from './classify';
import type { PageAllocation } from './allocator';
import { padBbox } from '../utils/bbox';

/**
 * Matches a "TOC page number" span. Covers the common multi-language formats:
 *  - "12"               (bare number, modern design)
 *  - "12."              (with a trailing dot)
 *  - "p.12" / "p. 12" / "p 12"   (FR/EN abbreviated)
 *  - "page 12" / "Page 12"       (FR/EN long)
 *  - "pg 12" / "pgs 12"          (EN)
 *  - "pag. 12" / "pag 12"        (IT/ES abbreviated)
 *  - "pág. 12"                   (ES)
 *  - "pagina 12" / "página 12"   (IT/ES long)
 *  - "S. 12" / "S.12" / "Seite 12" (DE)
 *  - "→ 12" / "▸ 12" / "● 12"    (design TOC with a bullet)
 *
 * The span must be short (= optional prefix + digits + suffix nothing or a
 * dot). Additional filter afterwards: bbox position + label on the left.
 */
export const PAGE_NUM_RE = new RegExp(
  '^\\s*' +
    '(?:' +
      // Textual prefixes (FR/EN/DE/IT/ES). All optional.
      'p(?:age|ag|ág|gs?|agina|ágina)?\\.?\\s+|' +
      'p\\.?\\s*|' +
      'seite\\s+|s\\.\\s*|' +
      'pag(?:ina)?\\.?\\s+|pág(?:ina)?\\.?\\s+|' +
      // Design bullets / arrows (followed by a mandatory whitespace)
      '[→▸▶▷►●•‣]\\s+' +
    ')?' +
    '\\d{1,4}' +
    '\\.?' + // optional trailing dot
    '\\s*$',
  'i',
);
const Y_TOLERANCE_PT = 4;

/** Ops to apply on ONE sommaire page. If pages.length > 1, each page reuses
 *  the same tpl sourcePage as a background (= decoration + title for page 1,
 *  decoration without title for the following pages). */
export interface TocPage {
  /** Template sourcePage to reuse as the background. */
  sourcePage: number;
  /** Ops to apply (erase + insert) on this page. */
  ops: Operation[];
  /** Number of items rendered on this page (incl. family/subfamily headers). */
  itemsWritten: number;
  /** True if it is the first page (= with the SOMMAIRE title), false otherwise. */
  isFirstPage: boolean;
}

export interface TocFromTemplateResult {
  /** Sommaire pages (may be 0, 1 or several on overflow). */
  pages: TocPage[];
  /** Template sourcePage (first identified tpl page). null if not found. */
  sourcePage: number | null;
  /** Ops of the first page (existing compat). */
  ops: Operation[];
  /** Total number of section entries written (across all pages). */
  entriesWritten: number;
  /** Number of original entries erased (on the tpl page). */
  entriesErased: number;
  /** Debug: list of candidates with their entries count. */
  debug?: string;
}

interface TocEntryTemplate {
  labelSpan: TextSpan;
  pageSpan: TextSpan;
  /** Leader-dots spans between label and page number (to erase too). */
  dotsSpans: TextSpan[];
}

export interface NewEntry {
  label: string;
  pageNumber: number;
  /** Parent family (= majority family label of the section's products). Used
   *  for hierarchical grouping. Empty if no family is set. */
  family: string;
  /** Parent sub-family (= majority sfamily label). Intermediate level between
   *  family and section. Empty if no sub-family is set. */
  subFamily: string;
}

/** Item to render in the sommaire:
 *  - 'family'    : level-1 header (no page number, XL size)
 *  - 'subfamily' : level-2 header (no page number, L size, indented)
 *  - 'section'   : level-3 entry (with page number, indented further)
 *  - 'extra'     : free entry ADDED AT THE END OF THE SOMMAIRE (style =
 *                  section but with an extra gap above, no description).
 *                  Used for "Cahier technique" and other post-toc additions.
 *  The rendering decides the style based on kind. */
export type ItemKind = 'family' | 'subfamily' | 'section' | 'extra';

export interface RenderedItem {
  kind: ItemKind;
  label: string;
  pageNumber?: number;
}

/** Free entry added at the end of the sommaire (after the product sections)
 *  with a small visual gap. Does not take part in the family/subfamily
 *  hierarchy. */
export interface TocExtraEntry {
  label: string;
  pageNumber: number;
}

export function buildTocFromTemplate(
  classifications: PageClassification[],
  allocations: PageAllocation[],
  pagePlans: { source_page: number; page_number: number | null }[],
  /** Map sectionLabel → marketing description (1-2 sentences). If provided,
   *  the sommaire's description zone is filled with these sentences instead of
   *  simply being erased. */
  descriptions: Record<string, string> = {},
  /** Free entries to add AT THE END of the sommaire (section style + top gap).
   *  Use case: "Cahier technique" which is not a real product section but must
   *  be listed in the sommaire. */
  extraEntries: TocExtraEntry[] = [],
): TocFromTemplateResult {
  // 1. Find a TEXT TOC page (not a visual icon-grid sommaire). We favor pages
  // whose labels are long (on average > 8 chars): a real text list ("Lavabos
  // bas mitigeurs") vs a grid of models ("Onari", "Ylus", "Joker"). Among the
  // valid candidates, we take the one with the most entries.
  const MIN_AVG_LABEL_LEN = 8;
  let tocPage: PageClassification | null = null;
  let entries: TocEntryTemplate[] = [];
  let bestScore = 0;
  for (const c of classifications) {
    if (c.kind !== 'toc') continue;
    const refs = (c.extracted.raw_spans ?? []).filter((s) =>
      PAGE_NUM_RE.test(s.text.trim()),
    ).length;
    if (refs < 3) continue;
    const candidateEntries = parseTocEntries(c.extracted);
    if (candidateEntries.length === 0) continue;
    const avgLen = candidateEntries.reduce((s, e) => s + e.labelSpan.text.trim().length, 0)
      / candidateEntries.length;
    if (avgLen < MIN_AVG_LABEL_LEN) continue; // visual grid sommaire → skip
    // Score: number of entries * avgLen (favors sommaires with rich labels)
    const score = candidateEntries.length * Math.min(avgLen, 25);
    if (score > bestScore) {
      bestScore = score;
      tocPage = c;
      entries = candidateEntries;
    }
  }
  if (!tocPage || entries.length === 0) {
    return { pages: [], sourcePage: null, ops: [], entriesWritten: 0, entriesErased: 0 };
  }

  // 3. Build the new entries from allocations + pagePlans
  const newEntries = buildNewEntries(allocations, pagePlans);
  if (newEntries.length === 0) {
    return { pages: [], sourcePage: null, ops: [], entriesWritten: 0, entriesErased: 0 };
  }

  // 4. Build the items to render (sections + family/sfamily headers)
  const items = groupIntoHierarchy(newEntries);
  const isHierarchical = items.some((it) => it.kind === 'family');
  // Add the free entries AT THE END OF THE LIST (after all sections). The
  // 'extra' kind triggers a gap above (section style + visual air).
  for (const extra of extraEntries) {
    if (!extra.label || !Number.isFinite(extra.pageNumber)) continue;
    items.push({
      kind: 'extra',
      label: extra.label,
      pageNumber: extra.pageNumber,
    });
  }

  // ── Spans to erase (common to all sommaire pages) ───────────────────────
  // These spans belong to the tpl page in the background and must be erased
  // on EVERY sommaire page (since we duplicate the tpl page as many times as
  // needed). The "SOMMAIRE" title is reinserted only on the first page
  // (continuation without a title on the following ones).
  const reusedCount = isHierarchical ? 0 : Math.min(newEntries.length, entries.length);
  const eraseEntriesOps: Operation[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    eraseEntriesOps.push({ op: 'erase_rect', bbox: padBbox(entry.labelSpan.bbox, 2) });
    eraseEntriesOps.push({ op: 'erase_rect', bbox: padBbox(entry.pageSpan.bbox, 2) });
    if (i >= reusedCount) {
      for (const dots of entry.dotsSpans) {
        eraseEntriesOps.push({ op: 'erase_rect', bbox: padBbox(dots.bbox, 2) });
      }
    }
  }

  // tpl title to erase + replace with "SOMMAIRE" (on page 1 only).
  const firstEntryY = entries[0].labelSpan.bbox[1];
  const pageWidth = tocPage.extracted.page_size.width;
  const pageHeight = tocPage.extracted.page_size.height;
  const titleAreaSpans = (tocPage.extracted.raw_spans ?? []).filter((s) => {
    if (s.bbox[3] >= firstEntryY - 5) return false;
    const t = s.text.trim();
    if (t.length < 2) return false;
    const w = s.bbox[2] - s.bbox[0];
    const h = s.bbox[3] - s.bbox[1];
    if (h > w * 1.5) return false;
    if (s.bbox[0] > pageWidth * 0.8) return false;
    return true;
  });
  const eraseTitleOps: Operation[] = titleAreaSpans.map((s) => ({
    op: 'erase_rect' as const, bbox: padBbox(s.bbox, 3),
  }));
  const biggestTitle = [...titleAreaSpans].sort((a, b) => b.size - a.size)[0];
  const insertTitleOp: Operation | null = biggestTitle ? {
    op: 'insert_text',
    bbox: biggestTitle.bbox,
    text: 'SOMMAIRE',
    font: biggestTitle.font,
    size: biggestTitle.size,
    color: biggestTitle.color,
  } : null;

  // Erase spans outside the entries (tpl marketing descriptions, etc.)
  const titleBottom = titleAreaSpans.length > 0
    ? Math.max(...titleAreaSpans.map((s) => s.bbox[3]))
    : 100;
  const entryBboxes = new Set<string>();
  for (const e of entries) {
    entryBboxes.add(JSON.stringify(e.labelSpan.bbox));
    entryBboxes.add(JSON.stringify(e.pageSpan.bbox));
    for (const d of e.dotsSpans) entryBboxes.add(JSON.stringify(d.bbox));
  }
  const otherSpansToErase = (tocPage.extracted.raw_spans ?? []).filter((s) => {
    if (entryBboxes.has(JSON.stringify(s.bbox))) return false;
    if (s.bbox[1] < titleBottom + 5) return false;
    if (s.bbox[3] > pageHeight - 25) return false;
    const t = s.text.trim();
    if (t.length < 2) return false;
    const w = s.bbox[2] - s.bbox[0];
    const h = s.bbox[3] - s.bbox[1];
    if (h > w * 1.5) return false;
    if (s.bbox[0] > pageWidth * 0.85) return false;
    return true;
  });
  const eraseOtherOps: Operation[] = otherSpansToErase.map((s) => ({
    op: 'erase_rect' as const, bbox: padBbox(s.bbox, 2),
  }));

  // 6. Render geometry: Y positions recomputed to support the hierarchical
  // items (family header + sections). The styles (font/size/color) are
  // preserved from the template entries.
  const refLabel = entries[0].labelSpan;
  const refPage = entries[0].pageSpan;
  const yFirst = refLabel.bbox[1];
  const lineH = refLabel.bbox[3] - refLabel.bbox[1];

  // Base yStep: median of the gaps between template entries (captures the
  // original visual rhythm). Fallback: lineH * 1.4.
  let yStepBase = lineH * 1.4;
  if (entries.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < entries.length; i++) {
      const gap = entries[i].labelSpan.bbox[1] - entries[i - 1].labelSpan.bbox[1];
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      yStepBase = gaps[Math.floor(gaps.length / 2)];
    }
  }

  // Available height in the TOC zone: from the first Y to the last Y of the
  // template entries + one line (= what the template uses visually).
  const lastEntryY = entries[entries.length - 1].labelSpan.bbox[1];
  const availableH = lastEntryY - yFirst + lineH;
  const MIN_STEP_RATIO = 1.10;
  const minStep = lineH * MIN_STEP_RATIO;

  // yStep + descriptions decision. NEW behavior: if there are too many items
  // for the zone, we PAGINATE instead of falling back to flat or overlapping.
  // Target yStep: comfortable (yStepBase) if possible, otherwise minStep.
  const renderItems = items;
  let yStep = yStepBase;

  // If Claude descriptions are provided, we aim for a wide yStep (label + 2
  // desc lines). If the zone is saturated, we drop the descriptions (priority
  // to the sommaire's readability).
  const hasAnyDescription = renderItems.some(
    (it) => it.kind === 'section' && it.label && !!descriptions[it.label]
  );
  const descSizeRef = refLabel.size * 0.5;
  const descLineHRef = descSizeRef * 1.35;
  const DESC_TOP_GAP = 5;
  const DESC_BOTTOM_GAP = 6;
  const minStepWithDesc = lineH + DESC_TOP_GAP + descLineHRef + DESC_BOTTOM_GAP;
  let renderDescriptions = hasAnyDescription;
  if (hasAnyDescription) {
    const DESC_LINES_TARGET = 2;
    const wantedStep = lineH + DESC_TOP_GAP + DESC_LINES_TARGET * descLineHRef + DESC_BOTTOM_GAP;
    yStep = wantedStep;
  }

  // Compute the capacity per page = number of items that fit in the TOC zone
  // at this yStep. The -1 comes from the fact that the first row is at
  // y=yFirst (no step) and each additional row adds yStep.
  let itemsPerPage = Math.max(1, Math.floor(availableH / yStep) + 1);

  // If even at minStep we cannot display renderItems on ≤2 pages, we accept a
  // tighter yStep (not below the absolute minStep). Beyond that, we will
  // create as many pages as needed.
  if (renderItems.length > itemsPerPage * 3) {
    yStep = Math.max(minStep, availableH / Math.max(1, Math.floor(renderItems.length / 3)));
    itemsPerPage = Math.max(1, Math.floor(availableH / yStep) + 1);
  }
  // If yStep has become insufficient for the descriptions → drop
  if (renderDescriptions && yStep < minStepWithDesc) {
    renderDescriptions = false;
  }

  // Chunking: split renderItems into pages of size itemsPerPage. Best-effort:
  // we try not to cut a family in the middle — if possible, we start a new
  // page on a family header.
  const chunks: RenderedItem[][] = [];
  {
    let start = 0;
    while (start < renderItems.length) {
      let end = Math.min(start + itemsPerPage, renderItems.length);
      // If we stop just after a family / subfamily header, we rewind by 1 to
      // place it on the next page (otherwise an orphan header at the bottom of
      // the page without its first section).
      if (end < renderItems.length) {
        const last = renderItems[end - 1];
        if (last.kind === 'family' || last.kind === 'subfamily') {
          end = Math.max(start + 1, end - 1);
        }
      }
      chunks.push(renderItems.slice(start, end));
      start = end;
    }
  }

  // Style constants for the hierarchical items (3 levels).
  // Strong visual hierarchy to better distinguish the levels:
  //   - family: +35% size, UPPERCASE, no indent, large gap above, thin
  //             separator line below
  //   - subfamily: +15% size, capitalize, indent +14pt, medium gap above
  //   - section: standard size, indent +26pt, page number on the right
  const FAMILY_SIZE_RATIO = 1.35;
  const SUBFAMILY_SIZE_RATIO = 1.15;
  const SUBFAMILY_INDENT_PT = 14;
  const SECTION_INDENT_PT = 26;
  // Extra gap BEFORE a header (= breathing room, visible structure).
  // Multiplied by yStep to scale with the overall density.
  const FAMILY_TOP_GAP_RATIO = 0.8;
  const SUBFAMILY_TOP_GAP_RATIO = 0.35;
  // Color of the line under family + grayed color for sfamily (visual contrast
  // with the black sections).
  const FAMILY_UNDERLINE_COLOR = '#cccccc';
  const FAMILY_UNDERLINE_HEIGHT = 0.6; // pt
  const SUBFAMILY_COLOR_LIGHTEN = 0.35; // 0=black, 1=white

  const hasSubFamilyHeaders = renderItems.some((it) => it.kind === 'subfamily');
  const sectionIndent = isHierarchical
    ? (hasSubFamilyHeaders ? SECTION_INDENT_PT : 14)
    : 0;
  const subFamIndent = SUBFAMILY_INDENT_PT;

  // ── Outer loop: 1 iteration = 1 sommaire page ────────────────────────
  const pages: TocPage[] = [];
  let totalWritten = 0;
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const isFirstPage = chunkIdx === 0;
    // Accumulated ops for this page:
    // 1) tpl erases (original entries, title, other spans)
    // 2) "SOMMAIRE" title if it is the first page
    // 3) chunk items with Y positions
    const ops: Operation[] = [
      ...eraseEntriesOps,
      ...eraseTitleOps,
      ...eraseOtherOps,
    ];
    if (isFirstPage && insertTitleOp) {
      ops.push(insertTitleOp);
    }
    let written = 0;
    // yCumulOffset: cumulative extra gaps added BEFORE the headers
    // (family/subfamily) to air out the visual hierarchy. Accumulates at each
    // header encountered in the chunk.
    let yCumulOffset = 0;
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];

      // Extra gap BEFORE a header (unless it is the first item of the page =
      // no gap, we start exactly at yFirst). The 'extra' kind (= "Cahier
      // technique" and other post-section additions) also receives a gap to
      // visually distinguish it from the last product-section item.
      if (i > 0) {
        if (item.kind === 'family') {
          yCumulOffset += yStep * FAMILY_TOP_GAP_RATIO;
        } else if (item.kind === 'subfamily') {
          yCumulOffset += yStep * SUBFAMILY_TOP_GAP_RATIO;
        } else if (item.kind === 'extra') {
          yCumulOffset += yStep * SUBFAMILY_TOP_GAP_RATIO;
        }
      }
      const y0 = yFirst + i * yStep + yCumulOffset;
      const y1 = y0 + lineH;

    if (item.kind === 'family') {
      // Level 1: +35% size, UPPERCASE, no indent, no page number.
      const famSize = refLabel.size * FAMILY_SIZE_RATIO;
      const famY1 = y0 + lineH * (famSize / refLabel.size);
      ops.push({
        op: 'insert_text',
        bbox: [refLabel.bbox[0], y0, refPage.bbox[2], famY1],
        text: item.label.toUpperCase(),
        font: refLabel.font,
        size: famSize,
        color: refLabel.color,
      });
      // Thin separator line under the family header (light gray color).
      const underlineY = famY1 + 2;
      ops.push({
        op: 'erase_rect',
        bbox: [refLabel.bbox[0], underlineY, refPage.bbox[2], underlineY + FAMILY_UNDERLINE_HEIGHT],
        color: FAMILY_UNDERLINE_COLOR,
      });
      written++;
      continue;
    }

    if (item.kind === 'subfamily') {
      // Level 2: +15% size, capitalize, indent +14pt, grayed color.
      const subSize = refLabel.size * SUBFAMILY_SIZE_RATIO;
      const styled = item.label.charAt(0).toUpperCase() + item.label.slice(1).toLowerCase();
      const subColor = lightenHex(refLabel.color, SUBFAMILY_COLOR_LIGHTEN);
      ops.push({
        op: 'insert_text',
        bbox: [refLabel.bbox[0] + subFamIndent, y0, refPage.bbox[2], y1],
        text: styled,
        font: refLabel.font,
        size: subSize,
        color: subColor,
      });
      written++;
      continue;
    }

    // Level 3 (section): max indent + page number on the right.
    ops.push({
      op: 'insert_text',
      bbox: [refLabel.bbox[0] + sectionIndent, y0, refLabel.bbox[2], y1],
      text: item.label,
      font: refLabel.font,
      size: refLabel.size,
      color: refLabel.color,
    });
    if (item.pageNumber != null) {
      ops.push({
        op: 'insert_text',
        bbox: [refPage.bbox[0], y0, refPage.bbox[2], y1],
        text: `p.${item.pageNumber}`,
        font: refPage.font,
        size: refPage.size,
        color: refPage.color,
      });
    }
    written++;

    // Claude description under the section entry. Available height = up to the
    // next row (family header or section). For the last one: extra headroom up
    // to the end of the TOC zone.
    if (!renderDescriptions) continue;
    const desc = descriptions[item.label];
    if (!desc) continue;
    const labelBottom = y1;
    const descSize = refLabel.size * 0.5;
    const lineHeight = descSize * 1.35;
    const x0 = refLabel.bbox[0] + sectionIndent + 4;
    // The description is UNDER the label: the page number column (on the
    // right, on the label's line) is empty here → we extend to the right edge
    // of the number (instead of stopping before), ~+30% width = fewer breaks.
    const x1 = Math.max(refPage.bbox[2], refPage.bbox[0] - 6, x0 + 50);
    const maxWidth = x1 - x0;
    const descColor = lightenHex(refLabel.color, 0.55);
    const isLastInChunk = i === chunk.length - 1;
    const nextRowTop = isLastInChunk
      ? entries[entries.length - 1].labelSpan.bbox[3] + 30
      : yFirst + (i + 1) * yStep;
    const availH = Math.max(0, nextRowTop - labelBottom - 6);
    // Round (not floor): if ~1.7 lines fit, we allow 2 lines — the step
    // between entries (yStep) is sized for 2 description lines, so no overlap
    // with the next entry.
    const maxLines = Math.max(1, Math.round(availH / lineHeight));
    const all = wrapToLines(desc, maxWidth, descSize);
    const lines = all.slice(0, maxLines);
    // ALWAYS clean the last line (not only when truncated): the model
    // sometimes produces an incomplete ending itself ("…, 60.", suspended
    // clause). trimToCompletePhrase guarantees a sentence ending on a fact.
    if (lines.length > 0) {
      const cleaned = trimToCompletePhrase(lines[lines.length - 1]);
      // If the cleanup empties the line (e.g. a single weak word), we keep the original.
      lines[lines.length - 1] = cleaned || lines[lines.length - 1].trimEnd();
    }
    let cy = labelBottom + 5;
    for (const line of lines) {
      ops.push({
        op: 'insert_text',
        bbox: [x0, cy, x1, cy + descSize + 1],
        text: line,
        font: refLabel.font,
        size: descSize,
        color: descColor,
      });
      cy += lineHeight;
    }
    }  // ← end of the inner loop over the chunk

    pages.push({
      sourcePage: tocPage.pageNumber,
      ops,
      itemsWritten: written,
      isFirstPage,
    });
    totalWritten += written;
  }  // ← end of the outer loop over chunks

  return {
    pages,
    sourcePage: tocPage.pageNumber,
    ops: pages[0]?.ops ?? [],
    entriesWritten: totalWritten,
    entriesErased: entries.length,
  };
}

/** For each "p.XX" span of the template, finds the left-aligned label AND the
 *  leader-dots spans between them (to erase too for a clean render). */
function parseTocEntries(page: ExtractedPage): TocEntryTemplate[] {
  const spans = page.raw_spans ?? [];
  const pageSpans = spans.filter((s) => PAGE_NUM_RE.test(s.text.trim()));
  const entries: TocEntryTemplate[] = [];
  for (const pageSpan of pageSpans) {
    const yCenter = (pageSpan.bbox[1] + pageSpan.bbox[3]) / 2;
    const sameLineSpans = spans.filter((s) => {
      if (s === pageSpan) return false;
      const sY = (s.bbox[1] + s.bbox[3]) / 2;
      if (Math.abs(sY - yCenter) > Y_TOLERANCE_PT) return false;
      // must be to the left of the page number
      if (s.bbox[0] >= pageSpan.bbox[0]) return false;
      const t = s.text.trim();
      if (t.length < 1) return false;
      return true;
    });
    if (sameLineSpans.length === 0) continue;
    // Separate labels (alphabetic text) vs leader dots
    const isDotsOnly = (s: TextSpan) => /^[.\s]+$/.test(s.text.trim());
    const labels = sameLineSpans.filter((s) => !isDotsOnly(s) && s.text.trim().length >= 3);
    const dotsSpans = sameLineSpans.filter(isDotsOnly);
    if (labels.length === 0) continue;
    labels.sort((a, b) => a.bbox[0] - b.bbox[0]);
    entries.push({
      labelSpan: labels[0],
      pageSpan,
      dotsSpans,
    });
  }
  entries.sort((a, b) => a.labelSpan.bbox[1] - b.labelSpan.bbox[1]);
  return entries;
}

/** Builds the list of new entries: 1 per section with products, sorted in
 *  their order of appearance in the final PDF. The family and sub-family are
 *  deduced from the allocation's products (majority). */
function buildNewEntries(
  allocations: PageAllocation[],
  pagePlans: { source_page: number; page_number: number | null }[],
): NewEntry[] {
  const sourceToFinal = new Map<number, number>();
  for (const pp of pagePlans) {
    if (pp.page_number != null && !sourceToFinal.has(pp.source_page)) {
      sourceToFinal.set(pp.source_page, pp.page_number);
    }
  }
  const seen = new Set<string>();
  const collected: { label: string; page: number; order: number; family: string; subFamily: string }[] = [];
  for (const alloc of allocations) {
    const label = (alloc.sectionLabel || '').trim();
    if (!label || seen.has(label)) continue;
    const finalPage = sourceToFinal.get(alloc.sourcePage);
    if (finalPage == null) continue;
    seen.add(label);
    // Majority family + sub-family of the allocation's products
    const famCounts = new Map<string, number>();
    const subFamCounts = new Map<string, number>();
    for (const p of alloc.products) {
      const f = (p.family ?? '').trim();
      if (f) famCounts.set(f, (famCounts.get(f) ?? 0) + 1);
      const sf = (p.subFamily ?? '').trim();
      if (sf) subFamCounts.set(sf, (subFamCounts.get(sf) ?? 0) + 1);
    }
    const family = famCounts.size > 0
      ? [...famCounts.entries()].sort((x, y) => y[1] - x[1])[0][0]
      : '';
    const subFamily = subFamCounts.size > 0
      ? [...subFamCounts.entries()].sort((x, y) => y[1] - x[1])[0][0]
      : '';
    collected.push({ label, page: finalPage, order: finalPage, family, subFamily });
  }
  // Sort: group by family then sub-family (order = first appearance of each),
  // then by page number within each group. Avoids the visual "alternation"
  // effect when pages come out in a non-hierarchical order.
  const familyFirstPage = new Map<string, number>();
  const subFamilyFirstPage = new Map<string, number>();
  for (const c of collected) {
    const fk = c.family || '';
    const sfk = `${fk}::${c.subFamily || ''}`;
    if (!familyFirstPage.has(fk)) familyFirstPage.set(fk, c.page);
    if (!subFamilyFirstPage.has(sfk)) subFamilyFirstPage.set(sfk, c.page);
  }
  collected.sort((a, b) => {
    const fa = familyFirstPage.get(a.family || '') ?? Number.MAX_SAFE_INTEGER;
    const fb = familyFirstPage.get(b.family || '') ?? Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    const sfa = subFamilyFirstPage.get(`${a.family || ''}::${a.subFamily || ''}`) ?? Number.MAX_SAFE_INTEGER;
    const sfb = subFamilyFirstPage.get(`${b.family || ''}::${b.subFamily || ''}`) ?? Number.MAX_SAFE_INTEGER;
    if (sfa !== sfb) return sfa - sfb;
    return a.page - b.page;
  });
  return collected.map((c) => ({
    label: c.label, pageNumber: c.page, family: c.family, subFamily: c.subFamily,
  }));
}

/** Groups the entries into hierarchical items. Supported levels:
 *  - 1 level  : sections only (no family/sub-family provided)
 *  - 2 levels : family > sections (sub-family absent)
 *  - 3 levels : family > sub-family > sections (the richest case)
 *
 *  Behavior: we materialize ALL levels that have at least ONE provided value
 *  (even if single-valued). This always exposes the catalog's structure in
 *  the table of contents, regardless of how diverse the families are.
 *  Preserves appearance order (no alphabetical sort). */
export function groupIntoHierarchy(entries: NewEntry[]): RenderedItem[] {
  const hasAnyFamily = entries.some((e) => !!e.family);
  const hasAnySubFamily = entries.some((e) => !!e.subFamily);

  // No hierarchical level provided → sections only
  if (!hasAnyFamily && !hasAnySubFamily) {
    return entries.map((e) => ({ kind: 'section', label: e.label, pageNumber: e.pageNumber }));
  }

  const items: RenderedItem[] = [];
  let currentFamily: string | null = null;
  let currentSubFamily: string | null = null;

  for (const e of entries) {
    const fam = e.family || '';
    const subFam = e.subFamily || '';

    // Level 1 (family): emit a header when the family changes
    if (hasAnyFamily) {
      if (fam && fam !== currentFamily) {
        items.push({ kind: 'family', label: fam });
        currentFamily = fam;
        currentSubFamily = null; // reset sub-family when the family changes
      } else if (!fam && currentFamily !== null) {
        items.push({ kind: 'family', label: 'Autres' });
        currentFamily = null;
        currentSubFamily = null;
      }
    }

    // Level 2 (subfamily): emit a header when the sub-family changes
    if (hasAnySubFamily && subFam && subFam !== currentSubFamily) {
      items.push({ kind: 'subfamily', label: subFam });
      currentSubFamily = subFam;
    }

    // Level 3 (section): always emitted
    items.push({ kind: 'section', label: e.label, pageNumber: e.pageNumber });
  }
  return items;
}

// padBbox: see utils/bbox.ts (audit #12 refactor).

/** Lightens a hex color by mixing it toward white. amount=0 returns the
 *  original color, amount=1 returns white. Used to create a secondary/greyed
 *  variant of a primary text color. */
function lightenHex(hex: string, amount: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/** Weak linking words (prepositions/articles/determiners): a truncated
 *  sentence must not end on one. Includes elided forms (d', l'…) handled via
 *  the split on the apostrophe. */
const TRUNC_WEAK_WORDS = new Set([
  'a', 'à', 'de', 'du', 'des', 'en', 'et', 'ou', 'le', 'la', 'les', 'un', 'une',
  'au', 'aux', 'par', 'pour', 'sur', 'sous', 'avec', 'dans', 'que', 'qui', 'dont',
  'son', 'sa', 'ses', 'leur', 'leurs', 'ce', 'ces', 'cet', 'cette', 'mon', 'ma',
  'mes', 'notre', 'nos', 'votre', 'vos', 'd', 'l', 'qu', 'n', 's', 'm', 't', 'j', 'c',
]);

/** Empty filler words: a sentence must not END on one (forbidden by the
 *  prompt but the model produces them sometimes). Compared without
 *  accents. */
const TRUNC_FILLER = new Set([
  'disponible', 'disponibles', 'varie', 'varies', 'divers', 'diverse', 'diverses',
  'different', 'differents', 'differente', 'differentes', 'plusieurs', 'multiple',
  'multiples', 'assortis', 'variees', 'variee',
]);
const deaccent = (s: string): string => s.normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Cleans the end of a TRUNCATED sentence so it does not end on a dangling
 *  fragment (punctuation, linking word, elision "d'une"/"l'…"). Iteratively
 *  removes trailing punctuation + weak words, then adds a period.
 *  Ex: "Une barre de douche en Inox, d'une" → "Une barre de douche en Inox." */
export function trimToCompletePhrase(line: string): string {
  let t = (line ?? '').trimEnd();
  // 1. Open but unclosed parenthesis/quote → cut the incomplete fragment
  //    (ex: "…en Inox (dont" → "…en Inox").
  if ((t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length) {
    const idx = t.lastIndexOf('(');
    if (idx >= 0) t = t.slice(0, idx).trimEnd();
  }
  // OUTER LOOP: removing one fragment often reveals another (ex
  // "…en 60 à" → remove "à", which exposes a bare "60", which exposes "en",
  // which exposes "disponibles"…). We repeat ALL the cleanup until stable.
  const MEASURE_LEAD = /\b(ø|diam[eè]tre|longueur|largeur|hauteur|profondeur|d[ée]bit|puissance|garantie|capacit)/i;
  const TAIL_PUNCT = /[\s,;:.…–—\-(«»"'’]+$/u;
  let outerPrev = '';
  while (t !== outerPrev && t.length > 0) {
    outerPrev = t;
    // a. BARE number at the end (a measurement cut off before its unit):
    //    "…longueurs 60" → drop the orphan digit. We do NOT touch "…60 cm."
    //    (unit present).
    t = t.replace(/[\s,;:.…]*\b\d+(?:[.,]\d+)?[\s.…]*$/u, '').trimEnd();
    // b. Incomplete measurement CLAUSE at the end (lead-in cut off before its
    //    value): "…, longueurs" / "…, Ø" → drop the clause (segment after the
    //    last comma) if no digit AND (measurement lead-in OR ≤2 characters).
    for (let guard = 0; guard < 4; guard++) {
      const ci = t.lastIndexOf(',');
      if (ci < 0) break;
      const clause = t.slice(ci + 1).trim().replace(/[.…\s]+$/u, '');
      if (!clause) { t = t.slice(0, ci).trimEnd(); continue; }
      const hasDigit = /\d/.test(clause);
      const isMeasureLead = MEASURE_LEAD.test(clause) && !hasDigit;
      const isShortSymbol = !hasDigit && clause.replace(/[^\p{L}\p{N}]/gu, '').length <= 2;
      if (isMeasureLead || isShortSymbol) { t = t.slice(0, ci).trimEnd(); } else break;
    }
    // c. "preposition/conjunction + quantity WITHOUT its noun": "…en deux", "…ou 2".
    t = t.replace(
      /[\s,;:.…]*\b(?:en|ou|et|de|du|des|à|a|avec)\s+(?:\d+|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s*$/iu,
      '',
    ).trimEnd();
    // d. Trailing punctuation/openers + linking words + filler + elisions.
    let prev = '';
    while (t !== prev && t.length > 0) {
      prev = t;
      t = t.replace(TAIL_PUNCT, '');
      const m = t.match(/(\S+)$/u);
      if (!m) break;
      const token = m[1];
      const cleanTok = token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}'’]+$/u, '');
      const segs = cleanTok.replace(/[’']/g, "'").toLowerCase().split("'");
      const lastSeg = segs[segs.length - 1];
      const isWeak = cleanTok === ''
        || TRUNC_WEAK_WORDS.has(lastSeg)
        || TRUNC_FILLER.has(deaccent(lastSeg));
      if (!isWeak) break;
      t = t.slice(0, t.length - token.length).trimEnd();
    }
  }
  t = t.replace(TAIL_PUNCT, '');
  if (t.length > 0 && !/[.!?]$/.test(t)) t += '.';
  return t;
}

/** Simple word-based wrap with width estimation. Not pixel-precise but avoids
 *  overflow for standard proportional fonts. */
function wrapToLines(text: string, maxWidth: number, fontSize: number): string[] {
  // Average char width for Almanach Regular ~0.5 * fontSize (mixed-case body
  // text). We pad to 0.55 to avoid overflow on dense lines.
  const avgCharWidth = fontSize * 0.55;
  const charsPerLine = Math.max(20, Math.floor(maxWidth / avgCharWidth));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    // Word too long for a whole line → forced break
    if (w.length > charsPerLine) {
      if (current.length > 0) lines.push(current);
      for (let i = 0; i < w.length; i += charsPerLine) {
        lines.push(w.slice(i, i + charsPerLine));
      }
      current = '';
      continue;
    }
    const candidate = current.length === 0 ? w : current + ' ' + w;
    if (candidate.length <= charsPerLine) {
      current = candidate;
    } else {
      if (current.length > 0) lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
