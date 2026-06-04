/**
 * Intent-driven substitute — approche hybride.
 *
 * Genere un plan semantique (IntentOps lisibles) ET delegue la production
 * des Operations bas niveau au substitutor eprouve (reflowSpecs, colorRef,
 * computeImageBbox, polish...). Le meilleur des deux mondes :
 *
 *  - plan_v2.json = description lisible de CE QU'ON VEUT CHANGER
 *  - Operations = code battle-tested du substitutor (layout correct)
 *  - La boucle intent-loop utilise le meme langage IntentOp pour raffiner
 *  - Le PageSchema est construit et reutilise partout
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
  /** Spans section_banner pour substitution du cartouche. */
  sectionBannerSpans?: TextSpan[];
  newSectionLabel?: string;
  /** Ruban vertical (famille) — voir SubstituteContext.ribbonSpans. */
  ribbonSpans?: TextSpan[];
  newFamilyLabel?: string;
  /** Raw spans/images/paths pour polish residus. */
  rawSpans?: TextSpan[];
  rawImages?: Bbox[];
  decorationVectors?: Bbox[];
  rawPaths?: { bbox: Bbox; fill_color: ColorHex }[];
}

export interface IntentSubstituteResult {
  /** Operations bas niveau pour le binaire C++ (via substitutor eprouve). */
  operations: Operation[];
  /** IntentOps generes (plan semantique pour plan_v2.json + boucle). */
  intents: IntentOp[];
  /** Le PageSchema construit (reutilise par la boucle intent). */
  schema: PageSchema;
}

/**
 * Pipeline intent-driven hybride :
 *   1. Build PageSchema depuis les blocks du template
 *   2. Genere IntentOps comme plan semantique (lisible, debuggable)
 *   3. Delegue au substitutor eprouve pour les Operations bas niveau
 *      (layout specs correct, image bbox genereuse, polish residus...)
 *   4. Retourne les deux : intents (pour plan_v2) + operations (pour C++)
 */
export function intentSubstitutePage(ctx: IntentSubstituteContext): IntentSubstituteResult {
  // 1. PageSchema semantique
  const schema = buildPageSchema({
    page: ctx.page,
    kind: ctx.kind,
    blocks: ctx.blocks,
  });

  // 2. Plan semantique (IntentOps) — description lisible
  const intents = buildIntentsFromProducts(ctx, schema);

  // 3. Operations bas niveau via substitutor eprouve
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

// ─── Generation du plan semantique (IntentOps) ──────────────────────────────

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
      // Bloc sans produit → tout effacer
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

    // Image principale
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
    // Specs template en surplus → remove
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
