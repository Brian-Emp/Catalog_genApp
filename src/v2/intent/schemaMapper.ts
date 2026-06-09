/**
 * Mapper ExtractedPage + ProductBlock → PageSchema.
 *
 * Reuses the existing detections (classify, blockDetector) rather than
 * re-extracting the zones from raw_spans. The goal is just to PRESENT the
 * already-identified zones in a stable, readable form for Claude and for the
 * intent resolver.
 */
import type { ExtractedPage, TextSpan, Bbox } from '../types';
import type { ProductBlock } from '../engine/blockDetector';
import type { PageSchema, ProductBlockZone, TextZone, SpecsItem, ImageZone } from './schema';

function spanToZone(span: TextSpan): TextZone {
  return {
    text: span.text,
    bbox: span.bbox,
    style: { font: span.font, size: span.size, color: span.color },
  };
}

interface BuildSchemaInput {
  page: ExtractedPage;
  kind: PageSchema['kind'];
  blocks: ProductBlock[];
}

/** Builds the PageSchema. Iterates over ALL detected ProductBlocks (the
 *  `products` array is the source of truth). The top-level fields
 *  (`title`, `image_main`, `specs_block`...) reflect product[0] for
 *  backward-compat of the legacy targets `page_N.title`. */
export function buildPageSchema(input: BuildSchemaInput): PageSchema {
  const { page, kind, blocks } = input;
  const schema: PageSchema = {
    sourcePage: page.page_number,
    kind,
    pageSize: page.page_size,
    zones: {},
  };

  // Zones coming from the typed slots (classify already identified
  // page_number, section_banner, etc.). We take the first of each type.
  for (const slot of page.slots) {
    if (slot.type === 'page_number' && !schema.zones.page_number) {
      const lbl = (slot as { label: TextSpan }).label;
      schema.zones.page_number = spanToZone(lbl);
    }
    if (slot.type === 'section_banner' && !schema.zones.section_banner) {
      const lbl = (slot as { label: TextSpan }).label;
      schema.zones.section_banner = spanToZone(lbl);
    }
  }

  // Build one ProductBlockZone per detected ProductBlock.
  const products: ProductBlockZone[] = blocks.map(buildProductZone);
  if (products.length > 0) {
    schema.zones.products = products;
    // Backward-compat: product[0] also feeds the top-level fields.
    const first = products[0];
    if (first.title) schema.zones.title = first.title;
    if (first.reference) schema.zones.reference = first.reference;
    if (first.color) schema.zones.color = first.color;
    if (first.image_main) schema.zones.image_main = first.image_main;
    if (first.specs_block) schema.zones.specs_block = first.specs_block;
    if (first.variants) schema.zones.variants = first.variants;
  }

  return schema;
}

function buildProductZone(block: ProductBlock): ProductBlockZone {
  const zone: ProductBlockZone = {};
  zone.title = spanToZone(block.nameSpan);
  if (block.refSpan) zone.reference = spanToZone(block.refSpan);
  if (block.colorSpan) zone.color = spanToZone(block.colorSpan);
  if (block.mainImageBbox) {
    zone.image_main = { bbox: block.mainImageBbox };
  }
  if (block.specs.length > 0) {
    const items: SpecsItem[] = block.specs.map((s) => ({
      key: spanToZone(s.key),
      value: s.values[0] ? spanToZone(s.values[0]) : spanToZone({
        text: '',
        bbox: s.key.bbox,
        font: s.key.font,
        size: s.key.size,
        color: s.key.color,
      }),
    }));
    const allBboxes = items.flatMap((i) => [i.key.bbox, i.value.bbox]);
    const bbox: Bbox = [
      Math.min(...allBboxes.map((b) => b[0])),
      Math.min(...allBboxes.map((b) => b[1])),
      Math.max(...allBboxes.map((b) => b[2])),
      Math.max(...allBboxes.map((b) => b[3])),
    ];
    zone.specs_block = { bbox, items };
  }
  if (block.variantImages.length > 0 || block.variantSpans.length > 0) {
    const allBboxes: Bbox[] = [
      ...block.variantImages,
      ...block.variantSpans.map((s) => s.bbox),
    ];
    if (allBboxes.length > 0) {
      const bbox: Bbox = [
        Math.min(...allBboxes.map((b) => b[0])),
        Math.min(...allBboxes.map((b) => b[1])),
        Math.max(...allBboxes.map((b) => b[2])),
        Math.max(...allBboxes.map((b) => b[3])),
      ];
      const images: ImageZone[] = block.variantImages.map((b) => ({ bbox: b }));
      const labels: TextZone[] = block.variantSpans.map(spanToZone);
      zone.variants = { bbox, images, labels };
    }
  }
  return zone;
}
