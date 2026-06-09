/**
 * Intent-driven substitute — hybrid approach.
 *
 * Generates a semantic plan (readable IntentOps) AND delegates low-level
 * Operations production to the battle-tested substitutor (reflowSpecs,
 * colorRef, computeImageBbox, polish...). The best of both worlds:
 *
 *  - plan_v2.json = readable description of WHAT WE WANT TO CHANGE
 *  - Operations = battle-tested substitutor code (correct layout)
 *  - The intent-loop uses the same IntentOp language to refine
 *  - The PageSchema is built and reused everywhere
 */
import type { PlanProduct, Operation, Bbox, TextSpan, ColorHex } from '../types';
import type { ProductBlock } from '../engine/blockDetector';
import type { TemplateProfile } from '../engine/profile';
import type { PageSchema } from './schema';
import type { IntentOp } from './intent';
import { buildPageSchema } from './schemaMapper';
import { substitutePage } from '../engine/substitutor';
import type { ExtractedPage } from '../types';
import { safeText } from '../engine/safeText';

export interface IntentSubstituteContext {
  page: ExtractedPage;
  blocks: ProductBlock[];
  products: PlanProduct[];
  kind: PageSchema['kind'];
  pageWidth: number;
  pageHeight: number;
  profile: TemplateProfile;
  /** section_banner spans for substituting the cartouche. */
  sectionBannerSpans?: TextSpan[];
  newSectionLabel?: string;
  /** Vertical ribbon (family) — see SubstituteContext.ribbonSpans. */
  ribbonSpans?: TextSpan[];
  newFamilyLabel?: string;
  /** Raw spans/images/paths for residue polish. */
  rawSpans?: TextSpan[];
  rawImages?: Bbox[];
  decorationVectors?: Bbox[];
  rawPaths?: { bbox: Bbox; fill_color: ColorHex }[];
}

export interface IntentSubstituteResult {
  /** Low-level Operations for the C++ binary (via the battle-tested substitutor). */
  operations: Operation[];
  /** Generated IntentOps (semantic plan for plan_v2.json + loop). */
  intents: IntentOp[];
  /** The built PageSchema (reused by the intent loop). */
  schema: PageSchema;
}

/**
 * Hybrid intent-driven pipeline:
 *   1. Build PageSchema from the template blocks
 *   2. Generate IntentOps as a semantic plan (readable, debuggable)
 *   3. Delegate to the battle-tested substitutor for the low-level Operations
 *      (correct specs layout, generous image bbox, residue polish...)
 *   4. Return both: intents (for plan_v2) + operations (for C++)
 */
export function intentSubstitutePage(ctx: IntentSubstituteContext): IntentSubstituteResult {
  // 1. Semantic PageSchema
  const schema = buildPageSchema({
    page: ctx.page,
    kind: ctx.kind,
    blocks: ctx.blocks,
  });

  // 2. Semantic plan (IntentOps) — readable description
  const intents = buildIntentsFromProducts(ctx, schema);

  // 3. Low-level Operations via the battle-tested substitutor
  const operations = substitutePage(ctx.blocks, ctx.products, {
    pageWidth: ctx.pageWidth,
    pageHeight: ctx.pageHeight,
    profile: ctx.profile,
    rawSpans: ctx.rawSpans,
    rawImages: ctx.rawImages,
    decorationVectors: ctx.decorationVectors,
    rawPaths: ctx.rawPaths,
    sectionBannerSpans: ctx.sectionBannerSpans,
    newSectionLabel: ctx.newSectionLabel,
    ribbonSpans: ctx.ribbonSpans,
    newFamilyLabel: ctx.newFamilyLabel,
  });

  return { operations, intents, schema };
}

// ─── Generation of the semantic plan (IntentOps) ────────────────────────────

function buildIntentsFromProducts(
  ctx: IntentSubstituteContext,
  schema: PageSchema,
): IntentOp[] {
  const pagePrefix = `page_${ctx.page.page_number}`;
  const intents: IntentOp[] = [];
  const isMulti = ctx.blocks.length > 1;

  for (let blockIdx = 0; blockIdx < ctx.blocks.length; blockIdx++) {
    const block = ctx.blocks[blockIdx];
    const product = ctx.products[blockIdx];
    const pfx = isMulti ? `${pagePrefix}.product_${blockIdx}` : pagePrefix;

    if (!product) {
      // Block with no product → erase everything
      intents.push({ op: 'remove_element', target: `${pfx}.title` });
      if (block.refSpan) intents.push({ op: 'remove_element', target: `${pfx}.reference` });
      if (block.colorSpan) intents.push({ op: 'remove_element', target: `${pfx}.color` });
      if (block.mainImageBbox) intents.push({ op: 'remove_element', target: `${pfx}.image_main` });
      if (block.specs.length > 0) {
        for (let si = 0; si < block.specs.length; si++) {
          intents.push({ op: 'remove_element', target: `${pfx}.specs_block.item_${si}` });
        }
      }
      continue;
    }

    // Title
    if (product.name) {
      intents.push({
        op: 'replace_text',
        target: `${pfx}.title`,
        text: safeText(product.name),
      });
    }

    // Reference
    if (product.ref) {
      intents.push({
        op: 'replace_text',
        target: `${pfx}.reference`,
        text: safeText(product.ref),
      });
    }

    // Color
    if (product.color) {
      intents.push({
        op: 'replace_text',
        target: `${pfx}.color`,
        text: safeText(product.color),
      });
    }

    // Main image
    if (product.image_path) {
      intents.push({
        op: 'swap_image',
        target: `${pfx}.image_main`,
        image_path: product.image_path,
        fit: 'contain',
      });
    } else if (block.mainImageBbox) {
      intents.push({
        op: 'remove_element',
        target: `${pfx}.image_main`,
      });
    }

    // Specs
    const newSpecs = product.specs ?? [];
    const n = Math.min(newSpecs.length, block.specs.length);
    for (let si = 0; si < n; si++) {
      const spec = newSpecs[si];
      const valueText = (spec.values ?? []).join(', ').trim();
      intents.push({
        op: 'update_spec',
        target: `${pfx}.specs_block.item_${si}`,
        key: safeText(spec.key),
        value: safeText(valueText),
      });
    }
    // Surplus template specs → remove
    for (let si = n; si < block.specs.length; si++) {
      intents.push({
        op: 'remove_element',
        target: `${pfx}.specs_block.item_${si}`,
      });
    }
  }

  // Section banner
  if (ctx.newSectionLabel && ctx.sectionBannerSpans && ctx.sectionBannerSpans.length > 0) {
    intents.push({
      op: 'replace_text',
      target: `${pagePrefix}.section_banner`,
      text: ctx.newSectionLabel.toUpperCase(),
    });
  }

  return intents;
}
