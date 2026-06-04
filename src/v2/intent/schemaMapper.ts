/**
 * Mapper ExtractedPage + ProductBlock → PageSchema.
 *
 * Reutilise les detections existantes (classify, blockDetector) plutot que
 * de re-extraire les zones depuis raw_spans. Le but est juste de PRESENTER
 * les zones deja identifiees sous une forme stable et lisible pour Claude
 * et pour le resolver d'intents.
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

/** Construit le PageSchema. Itere sur TOUS les ProductBlock detectes (le
 *  tableau `products` est la source de verite). Les champs top-level
 *  (`title`, `image_main`, `specs_block`...) reflètent product[0] pour
 *  rétro-compat des targets historiques `page_N.title`. */
export function buildPageSchema(input: BuildSchemaInput): PageSchema {
  const { page, kind, blocks } = input;
  const schema: PageSchema = {
    sourcePage: page.page_number,
    kind,
    pageSize: page.page_size,
    zones: {},
  };

  // Zones venant des slots typés (classify a deja identifie page_number,
  // section_banner, etc.). On prend le premier de chaque type.
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

  // Construit un ProductBlockZone par ProductBlock detecte.
  const products: ProductBlockZone[] = blocks.map(buildProductZone);
  if (products.length > 0) {
    schema.zones.products = products;
    // Rétro-compat : product[0] alimente aussi les champs top-level.
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
