/**
 * V2 TypeScript types — mirrors of the JSON schemas in src/v2/schemas/.
 *
 * Convention: each interface here must stay aligned with the corresponding
 * JSON schema. If you change one, change the other.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Reused sub-types
// ─────────────────────────────────────────────────────────────────────────────

/** Rectangle [x0, y0, x1, y1] in PDF points, top-left origin. */
export type Bbox = [number, number, number, number];

/** Hex RGB color "#rrggbb". TS cannot validate the regex at the type level,
 *  so we just alias to string; runtime validation happens at parsing time. */
export type ColorHex = string;

/** Text fragment with position and style. */
export interface TextSpan {
  text: string;
  bbox: Bbox;
  font: string;
  size: number;
  color: ColorHex;
}

// ─────────────────────────────────────────────────────────────────────────────
// ExtractedPage — output of the C++ extractor (cf extracted-page.schema.json)
// ─────────────────────────────────────────────────────────────────────────────

/** Exhaustive list of slot types. `as const` = TS keeps the literals. */
export const SLOT_TYPES = [
  'section_banner',
  'section_ribbon',
  'product_slot',
  'toc_entry',
  'toc_title',
  'page_number',
  'running_header',
  'decoration',
  'keep_page_raw',
] as const;

export type SlotType = typeof SLOT_TYPES[number];

interface SlotBase {
  type: SlotType;
  id: string;
  bbox: Bbox;
}

export interface SlotSectionBanner extends SlotBase {
  type: 'section_banner';
  label: TextSpan;
  background?: ColorHex;
}

export interface SlotSectionRibbon extends SlotBase {
  type: 'section_ribbon';
  label: TextSpan;
  rotation?: 0 | 90 | 180 | 270;
  background?: ColorHex;
}

export interface ProductSpec {
  key: TextSpan;
  values: TextSpan[];
}

export interface ProductVariant {
  bbox: Bbox;
  color: ColorHex;
  label: TextSpan | null;
}

export interface SlotProduct extends SlotBase {
  type: 'product_slot';
  name: TextSpan;
  ref: TextSpan | null;
  color: TextSpan | null;
  image: { bbox: Bbox };
  specs: ProductSpec[];
  variants: ProductVariant[];
}

export interface SlotTocEntry extends SlotBase {
  type: 'toc_entry';
  label: TextSpan;
  page_number_text: TextSpan;
}

export interface SlotTocTitle extends SlotBase {
  type: 'toc_title';
  label: TextSpan;
}

export interface SlotPageNumber extends SlotBase {
  type: 'page_number';
  label: TextSpan;
  current_number?: number;
}

export interface SlotRunningHeader extends SlotBase {
  type: 'running_header';
  label: TextSpan;
}

export interface SlotDecoration extends SlotBase {
  type: 'decoration';
  kind: 'image' | 'vector';
}

export interface SlotKeepPageRaw extends SlotBase {
  type: 'keep_page_raw';
  reason?: string;
}

/** Discriminated union on `type`. TS narrows automatically based on the value. */
export type Slot =
  | SlotSectionBanner
  | SlotSectionRibbon
  | SlotProduct
  | SlotTocEntry
  | SlotTocTitle
  | SlotPageNumber
  | SlotRunningHeader
  | SlotDecoration
  | SlotKeepPageRaw;

export interface ExtractedPage {
  page_number: number;
  page_size: { width: number; height: number };
  slots: Slot[];
  /** All the text spans of the page, with no type inference. Source of
   *  truth for the V2 pipeline that carries the V1 logic (auto_detect_template,
   *  find_product_blocks). Optional for backward-compat with 0.1.x extracts. */
  raw_spans?: TextSpan[];
  /** Bbox of every bitmap image (color variants + main image). */
  raw_images?: Bbox[];
  /** Colored paths (non white/transparent) with their fillColor. Lets us
   *  recover the tint of a section_banner cartouche to substitute the
   *  text while preserving the template background. */
  raw_paths?: { bbox: Bbox; fill_color: ColorHex }[];
  extractor_version?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan — output of Claude (cf plan.schema.json)
// ─────────────────────────────────────────────────────────────────────────────

export const OPERATION_TYPES = [
  'set_text',
  'insert_text',
  'fill_product_slot',
  'erase_rect',
  'remove_paths_in_bbox',
  'remove_text_in_bbox',
  'draw_circle',
  'draw_image',
] as const;

export type OperationType = typeof OPERATION_TYPES[number];

export interface OpSetText {
  op: 'set_text';
  slot_id: string;
  text: string;
}

/**
 * Standalone text insertion (no dependency on a pre-extracted slot).
 * Used by the V2 engine pipeline (substitutor) which detects its own
 * blocks in TS from raw_spans. The caller provides bbox + full style.
 *
 * Note: the bbox positions the text origin. Clearing the area must be
 * done via a separate erase_rect before the insert (PASS 1 / 2).
 */
export interface OpInsertText {
  op: 'insert_text';
  bbox: Bbox;
  text: string;
  font: string;
  size: number;
  color: ColorHex;
  /** Skip the PASS 1 white auto-erase. Useful when the caller just wants to
   *  rewrite a glyph over the old one (page renum on a photo background)
   *  without leaving a white smudge. */
  no_erase?: boolean;
  /** Rotation in degrees (90 = vertical bottom-to-top, 270 = top-to-bottom).
   *  Default 0 = horizontal. Used for vertical ribbons. */
  rotation?: number;
}

export interface PlanProductSpec {
  key: string;
  values: string[];
}

export interface PlanProductVariant {
  color: ColorHex;
  label: string | null;
}

export interface PlanProduct {
  name: string;
  ref: string | null;
  color: string | null;
  image_path: string | null;
  specs: PlanProductSpec[];
  variants: PlanProductVariant[];
  /** Section/sub-sub-family = deepest level (XLSX "Libellé SSFamille",
   *  e.g. "BARRES DE DOUCHES"). Used for the section banner + allocator sort. */
  section?: string | null;
  /** Top-level family (XLSX "Libellé Famille", e.g. "SANITAIRE"). Used to
   *  substitute the template's vertical ribbon (e.g. "salle de bains" →
   *  "SANITAIRE"). If absent, the ribbon is not substituted. */
  family?: string | null;
  /** Sub-family = intermediate level between family and section (XLSX
   *  "Libellé SFamille", e.g. "Robinetterie"). Used for the 3-level table of
   *  contents: if provided, the hierarchy becomes family > subFamily > section. */
  subFamily?: string | null;
  /** Absolute path to the product's technical-schematic PDF (asset *_SC.pdf
   *  matched by productsAdapter). If present, the pipeline adds the schematic
   *  to the "technical handbook" grid at the end of the PDF. */
  schema_path?: string | null;
}

export interface OpFillProductSlot {
  op: 'fill_product_slot';
  slot_id: string;
  product: PlanProduct;
}

export interface OpEraseRect {
  op: 'erase_rect';
  bbox: Bbox;
  /** Fill color. Default = white "#ffffff". Used to paint the area of a
   *  section_banner cartouche with the original template tint
   *  (orange / green / etc.) instead of erasing it to white. */
  color?: ColorHex;
  /** If true, the engine samples the local background color (band just
   *  above the rect) and erases with that tint instead of white. For page
   *  numbers on a LIGHT photo background: avoids a visible white block. */
  sample_bg?: boolean;
}

/** Physically removes the template's vector paths whose bbox is entirely
 *  contained in this area, AND with area < max_area. Useful when a white
 *  erase_rect is not enough because PDFium draws some paths on top. */
export interface OpRemovePathsInBbox {
  op: 'remove_paths_in_bbox';
  bbox: Bbox;
  /** Max area (pt²) below which a path is a candidate for removal.
   *  Default on the render.cpp side: 1500. Prevents removing the
   *  structural cartouches/ribbons (typically > 1500 pt²). */
  max_area?: number;
}

/** Physically removes the template's TEXT objects whose bbox is entirely
 *  within this area. Useful to erase a page number on a photo background
 *  without leaving a smudge (a white erase_rect would be visible). */
export interface OpRemoveTextInBbox {
  op: 'remove_text_in_bbox';
  bbox: Bbox;
}

export interface OpDrawCircle {
  op: 'draw_circle';
  center: [number, number];
  radius: number;
  color: ColorHex;
}

export interface OpDrawImage {
  op: 'draw_image';
  bbox: Bbox;
  image_path: string;
  fit?: 'contain' | 'cover' | 'stretch';
}

export type Operation =
  | OpSetText
  | OpInsertText
  | OpFillProductSlot
  | OpEraseRect
  | OpRemovePathsInBbox
  | OpRemoveTextInBbox
  | OpDrawCircle
  | OpDrawImage;

export type PageRender =
  | { mode: 'keep_raw' }
  | { mode: 'operations'; operations: Operation[] };

export interface PagePlan {
  source_page: number;
  page_number: number | null;
  render: PageRender;
}

export interface PlanStats {
  products_used?: number;
  products_remaining?: number;
  pages_kept?: number;
  pages_deleted?: number;
}

export interface Plan {
  version: '1';
  template_pdf_hash?: string;
  pages: PagePlan[];
  warnings?: string[];
  stats?: PlanStats;
}
