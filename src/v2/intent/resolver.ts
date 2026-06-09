/**
 * Resolver IntentOp + PageSchema → low-level Operation[].
 *
 * The C++ binary stays put: we take the readable IntentOps and produce the
 * same ops as before (erase_rect, insert_text, draw_image...).
 *
 * Target resolution happens via the PageSchema corresponding to the page:
 * each selector ("page_3.title", "page_3.specs_block.item_2.value") is
 * mapped onto a bbox + style.
 */
import type { Operation, Bbox } from '../types';
import type { PageSchema, ProductBlockZone, ResolvedTarget, TargetSelector, TextZone } from './schema';
import type { IntentOp } from './intent';
import { padBbox } from '../utils/bbox';
import { estimateTextWidth } from '../engine/reflow/fit';

export interface ResolverResult {
  /** Low-level ops ready for the binary. */
  operations: Operation[];
  /** Unresolved intents (invalid target, type mismatch, etc.). */
  unresolved: { intent: IntentOp; reason: string }[];
}

/** Resolves a selector "page_N.[product_K.]zone[.sub[.item_i][.key|value]]"
 *  against the schema. parts[0] = page_N (ignored). If parts[1] = product_K,
 *  we drill into products[K] and the zone is parts[2]+; otherwise we hit the
 *  top-level zones (backward-compat = product[0] OR page-level zones like
 *  page_number/section_banner). */
function resolveTarget(target: TargetSelector, schema: PageSchema): ResolvedTarget | null {
  const parts = target.split('.');
  if (parts.length < 2) return null;

  // Explicit multi-product case: page_N.product_K.<zone>...
  if (parts[1].startsWith('product_')) {
    const idx = parseInt(parts[1].slice('product_'.length), 10);
    const product = schema.zones.products?.[idx];
    if (!product) return null;
    return resolveZoneInProduct(parts.slice(2), product);
  }

  // Page-level zones (never inside product): page_number, section_banner.
  if (parts[1] === 'page_number') {
    const t = schema.zones.page_number;
    return t ? { bbox: t.bbox, style: t.style, isText: true } : null;
  }
  if (parts[1] === 'section_banner') {
    const t = schema.zones.section_banner;
    return t ? { bbox: t.bbox, style: t.style, isText: true } : null;
  }

  // Backward-compat: page_N.<zone> = product_0.<zone>. We fall back to
  // resolution in the 1st product (feeds the top-level via the mapper).
  const first = schema.zones.products?.[0];
  if (first) return resolveZoneInProduct(parts.slice(1), first);
  return null;
}

/** Resolves `<zone>[.sub[.item_i][.key|value]]` inside a ProductBlockZone. */
function resolveZoneInProduct(parts: string[], product: ProductBlockZone): ResolvedTarget | null {
  if (parts.length === 0) return null;
  const zone = parts[0];
  switch (zone) {
    case 'title': {
      const t = product.title;
      return t ? { bbox: t.bbox, style: t.style, isText: true } : null;
    }
    case 'reference': {
      const t = product.reference;
      return t ? { bbox: t.bbox, style: t.style, isText: true } : null;
    }
    case 'color': {
      const t = product.color;
      return t ? { bbox: t.bbox, style: t.style, isText: true } : null;
    }
    case 'image_main': {
      const t = product.image_main;
      return t ? { bbox: t.bbox, isText: false } : null;
    }
    case 'specs_block': {
      const sb = product.specs_block;
      if (!sb) return null;
      if (parts[1]?.startsWith('item_')) {
        const idx = parseInt(parts[1].slice('item_'.length), 10);
        const item = sb.items[idx];
        if (!item) return null;
        if (parts[2] === 'key') return { bbox: item.key.bbox, style: item.key.style, isText: true };
        if (parts[2] === 'value') return { bbox: item.value.bbox, style: item.value.style, isText: true };
        return { bbox: item.value.bbox, style: item.value.style, isText: true };
      }
      return { bbox: sb.bbox, isText: false };
    }
    default:
      return null;
  }
}

export function resolveIntents(
  intents: IntentOp[],
  schema: PageSchema,
): ResolverResult {
  const operations: Operation[] = [];
  const unresolved: { intent: IntentOp; reason: string }[] = [];

  for (const intent of intents) {
    const resolved = resolveTarget(intent.target, schema);
    if (!resolved) {
      unresolved.push({ intent, reason: `target introuvable: ${intent.target}` });
      continue;
    }

    switch (intent.op) {
      case 'replace_text': {
        if (!resolved.isText || !resolved.style) {
          unresolved.push({ intent, reason: 'target pas une zone texte' });
          continue;
        }
        operations.push(...emitReplaceText(resolved.bbox, resolved.style, intent.text));
        break;
      }
      case 'swap_image': {
        operations.push(
          { op: 'erase_rect', bbox: padBbox(resolved.bbox, 2) },
          {
            op: 'draw_image',
            bbox: resolved.bbox,
            image_path: intent.image_path,
            // 'contain' = preserve ratio, 'cover' = fill
            fit: intent.fit ?? 'contain',
          },
        );
        break;
      }
      case 'update_spec': {
        // First resolve the item block, then handle key + value separately.
        const baseTarget = intent.target;
        if (intent.key !== undefined) {
          const keyTarget = `${baseTarget}.key`;
          const keyResolved = resolveTarget(keyTarget, schema);
          if (keyResolved && keyResolved.isText && keyResolved.style) {
            operations.push(...emitReplaceText(keyResolved.bbox, keyResolved.style, intent.key));
          } else {
            // Bug fix: no longer silently drop when the key is requested but
            // not found — surface it as unresolved for debugging.
            unresolved.push({ intent, reason: 'spec key cible introuvable' });
          }
        }
        const valTarget = `${baseTarget}.value`;
        const valResolved = resolveTarget(valTarget, schema);
        if (valResolved && valResolved.isText && valResolved.style) {
          operations.push(...emitReplaceText(valResolved.bbox, valResolved.style, intent.value));
        } else {
          unresolved.push({ intent, reason: 'spec value cible introuvable' });
        }
        break;
      }
      case 'set_color': {
        // set_color on a text zone: we re-insert the text with the new
        // color (preserves font/size).
        if (!resolved.isText || !resolved.style) {
          unresolved.push({ intent, reason: 'target pas une zone texte (set_color non supporte sur image)' });
          continue;
        }
        // We need the current text — not available via ResolvedTarget.
        // Direct lookup in the schema.
        const zone = lookupTextZone(intent.target, schema);
        if (!zone) {
          unresolved.push({ intent, reason: 'zone texte introuvable' });
          continue;
        }
        const newStyle = { ...resolved.style, color: intent.color };
        operations.push(...emitReplaceText(resolved.bbox, newStyle, zone.text));
        break;
      }
      case 'remove_element': {
        operations.push({ op: 'erase_rect', bbox: padBbox(resolved.bbox, 2) });
        break;
      }
    }
  }

  return { operations, unresolved };
}

/** Produces an erase_rect + insert_text pair to replace a text. */
function emitReplaceText(bbox: Bbox, style: { font: string; size: number; color: string }, text: string): Operation[] {
  // Catalogue C P6 "DIAMÈTREÈTRE" bug: if the new text is wider than the
  // template bbox (e.g. template "Diamètre :" 70pt vs new "DIAMÈTRE MAXIMUM
  // DES PARTICULES :" 250pt), padBbox(bbox, 2) only covers the original
  // template zone → the new text overflows to the right over the unerased
  // template "Diamètre :" in the overflow zone.
  // Solution: extend the erase to the right to cover at least the length of
  // the new text.
  const newWidth = estimateTextWidth(text, style.size);
  const bboxWidth = bbox[2] - bbox[0];
  const eraseBbox: Bbox =
    newWidth > bboxWidth
      ? [bbox[0] - 2, bbox[1] - 2, bbox[0] + newWidth + 4, bbox[3] + 2]
      : padBbox(bbox, 2);
  return [
    { op: 'erase_rect', bbox: eraseBbox },
    {
      op: 'insert_text',
      bbox,
      text,
      font: style.font,
      size: style.size,
      color: style.color,
    },
  ];
}

/** Direct lookup of the TextZone for a selector. Used when we need the
 *  current text (e.g. set_color which must re-emit with the same text). */
function lookupTextZone(target: TargetSelector, schema: PageSchema): TextZone | null {
  const parts = target.split('.');
  if (parts.length < 2) return null;

  if (parts[1].startsWith('product_')) {
    const idx = parseInt(parts[1].slice('product_'.length), 10);
    const product = schema.zones.products?.[idx];
    if (!product) return null;
    return lookupInProduct(parts.slice(2), product);
  }
  if (parts[1] === 'page_number') return schema.zones.page_number ?? null;
  if (parts[1] === 'section_banner') return schema.zones.section_banner ?? null;
  const first = schema.zones.products?.[0];
  if (first) return lookupInProduct(parts.slice(1), first);
  return null;
}

function lookupInProduct(parts: string[], product: ProductBlockZone): TextZone | null {
  if (parts.length === 0) return null;
  switch (parts[0]) {
    case 'title': return product.title ?? null;
    case 'reference': return product.reference ?? null;
    case 'color': return product.color ?? null;
    case 'specs_block': {
      const sb = product.specs_block;
      if (!sb || !parts[1]?.startsWith('item_')) return null;
      const idx = parseInt(parts[1].slice('item_'.length), 10);
      const item = sb.items[idx];
      if (!item) return null;
      if (parts[2] === 'key') return item.key;
      return item.value;
    }
    default: return null;
  }
}
