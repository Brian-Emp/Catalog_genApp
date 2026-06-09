/**
 * PageSchema — approach B: a STRUCTURED view of an extracted page, with
 * named zones (title, image_main, specs_block, page_number...) instead of
 * raw raw_spans + bbox.
 *
 * Serves two purposes:
 *  1. Give Claude a readable/reasonable representation of a page (instead of
 *     dumping 200 spans with bbox).
 *  2. Resolve readable "targets" (e.g. "page_3.title") into concrete bbox to
 *     generate the low-level ops.
 */
import type { Bbox, ColorHex } from '../types';

/** Typographic style of a text zone (taken from the template, used by the
 *  resolver to reproduce the right font/size/color). */
export interface ZoneStyle {
  font: string;
  size: number;
  color: ColorHex;
}

/** A simple text zone (title, page number, banner label, etc.). */
export interface TextZone {
  /** Current content (template) — helps Claude understand the nature. */
  text: string;
  bbox: Bbox;
  style: ZoneStyle;
}

/** Image zone (main product image, variant swatch, lifestyle photo). */
export interface ImageZone {
  bbox: Bbox;
  /** Image ID extracted from the PDF (cf raw_images), if relevant. */
  imageId?: string;
}

/** Specifications block (key : value). Each item has its own bbox so we can
 *  target `specs_block.item_2.value` precisely. */
export interface SpecsItem {
  key: TextZone;
  value: TextZone;
}

export interface SpecsBlockZone {
  /** Global bbox of the specs block (useful for layout and erase). */
  bbox: Bbox;
  items: SpecsItem[];
}

/** Zones of ONE product block (multi-product-per-page case: 1 ProductBlockZone
 *  per detected block). Targets are written `page_N.product_K.title`. */
export interface ProductBlockZone {
  title?: TextZone;
  reference?: TextZone;
  color?: TextZone;
  image_main?: ImageZone;
  specs_block?: SpecsBlockZone;
  variants?: { bbox: Bbox; images: ImageZone[]; labels: TextZone[] };
}

/** Complete schema of a product page. Optional fields: not every page has a
 *  title / image_main / specs (e.g. brand identity pages).
 *
 *  Backward-compat: `title`, `reference`, `color`, `image_main`, `specs_block`,
 *  `variants` at the zones level reflect the 1st product (= `products[0]`).
 *  The `products` array is the SOURCE OF TRUTH for multi-block pages; the
 *  legacy targets `page_N.title` stay valid and point to product[0].
 */
export interface PageSchema {
  sourcePage: number;
  kind: 'product' | 'toc' | 'glossaire' | 'tech' | 'intercalaire' | 'identity' | 'unknown';
  pageSize: { width: number; height: number };
  zones: {
    title?: TextZone;
    reference?: TextZone;
    color?: TextZone;
    image_main?: ImageZone;
    specs_block?: SpecsBlockZone;
    variants?: { bbox: Bbox; images: ImageZone[]; labels: TextZone[] };
    page_number?: TextZone;
    section_banner?: TextZone;
    /** List of ALL product blocks detected on the page (>= 1). */
    products?: ProductBlockZone[];
  };
}

/** Type of the target selectors understood by the resolver.
 *  Format: `page_<N>.[product_<K>.]<zone>[.<sub>[.item_<i>][.key|value]]`
 *
 *  Examples:
 *    page_3.title                                 (legacy = product_0.title)
 *    page_3.product_0.title                       (explicit)
 *    page_3.product_2.specs_block.item_1.value    (multi-product)
 *    page_3.image_main                            (legacy = product_0.image_main)
 *    page_3.page_number                           (always page-level)
 *    page_3.section_banner                        (always page-level)
 */
export type TargetSelector = string;

/** Result of a target resolution → bbox + style. */
export interface ResolvedTarget {
  bbox: Bbox;
  style?: ZoneStyle;
  /** True if the target is a text zone (vs image). */
  isText: boolean;
}
