/**
 * Resolver IntentOp + PageSchema → Operation[] bas niveau.
 *
 * Le binaire C++ ne bouge pas : on prend les IntentOp lisibles et on
 * produit les memes ops qu'avant (erase_rect, insert_text, draw_image...).
 *
 * La resolution des targets se fait via le PageSchema correspondant a la
 * page : chaque selecteur ("page_3.title", "page_3.specs_block.item_2.value")
 * est mappe sur une bbox + style.
 */
import type { Operation, Bbox } from '../types';
import type { PageSchema, ProductBlockZone, ResolvedTarget, TargetSelector, TextZone } from './schema';
import type { IntentOp } from './intent';
import { padBbox } from '../utils/bbox';
import { estimateTextWidth } from '../engine/reflow/fit';

export interface ResolverResult {
  /** Ops bas niveau pretes pour le binaire. */
  operations: Operation[];
  /** Intents non resolus (target invalide, type mismatch, etc.). */
  unresolved: { intent: IntentOp; reason: string }[];
}

/** Resout un selecteur "page_N.[product_K.]zone[.sub[.item_i][.key|value]]"
 *  sur le schema. parts[0] = page_N (ignore). Si parts[1] = product_K, on
 *  drill dans products[K] et la zone est parts[2]+ ; sinon on tape les
 *  zones top-level (rétro-compat = product[0] OU zones page-niveau comme
 *  page_number/section_banner). */
function resolveTarget(target: TargetSelector, schema: PageSchema): ResolvedTarget | null {
  const parts = target.split('.');
  if (parts.length < 2) return null;

  // Cas explicite multi-produits : page_N.product_K.<zone>...
  if (parts[1].startsWith('product_')) {
    const idx = parseInt(parts[1].slice('product_'.length), 10);
    const product = schema.zones.products?.[idx];
    if (!product) return null;
    return resolveZoneInProduct(parts.slice(2), product);
  }

  // Zones niveau page (jamais dans product) : page_number, section_banner.
  if (parts[1] === 'page_number') {
    const t = schema.zones.page_number;
    return t ? { bbox: t.bbox, style: t.style, isText: true } : null;
  }
  if (parts[1] === 'section_banner') {
    const t = schema.zones.section_banner;
    return t ? { bbox: t.bbox, style: t.style, isText: true } : null;
  }

  // Rétro-compat : page_N.<zone> = product_0.<zone>. On retombe sur la
  // resolution dans le 1er produit (alimente le top-level via le mapper).
  const first = schema.zones.products?.[0];
  if (first) return resolveZoneInProduct(parts.slice(1), first);
  return null;
}

/** Resout `<zone>[.sub[.item_i][.key|value]]` dans un ProductBlockZone. */
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
            // 'contain' = ratio preserve, 'cover' = remplir
            fit: intent.fit ?? 'contain',
          },
        );
        break;
      }
      case 'update_spec': {
        // Resout d'abord le bloc item, puis traite key + value separement.
        const baseTarget = intent.target;
        if (intent.key !== undefined) {
          const keyTarget = `${baseTarget}.key`;
          const keyResolved = resolveTarget(keyTarget, schema);
          if (keyResolved && keyResolved.isText && keyResolved.style) {
            operations.push(...emitReplaceText(keyResolved.bbox, keyResolved.style, intent.key));
          } else {
            // Bug fix : ne plus dropper silencieusement si la key est demandee
            // mais introuvable — remonter en unresolved pour debug.
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
        // set_color sur une zone texte : on re-insere le texte avec la
        // nouvelle couleur (preserve font/size).
        if (!resolved.isText || !resolved.style) {
          unresolved.push({ intent, reason: 'target pas une zone texte (set_color non supporte sur image)' });
          continue;
        }
        // On a besoin du texte courant — pas dispo via ResolvedTarget.
        // Lookup direct dans le schema.
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

/** Produit une paire erase_rect + insert_text pour remplacer un texte. */
function emitReplaceText(bbox: Bbox, style: { font: string; size: number; color: string }, text: string): Operation[] {
  // Faille Catalogue C P6 "DIAMÈTREÈTRE" : si le nouveau text est plus large
  // que la bbox template (ex template "Diamètre :" 70pt vs nouveau "DIAMÈTRE
  // MAXIMUM DES PARTICULES :" 250pt), padBbox(bbox, 2) ne couvre que la zone
  // template originale → le nouveau text deborde a droite par-dessus le
  // template "Diamètre :" non efface dans la zone debordement.
  // Solution : etendre l'erase a droite pour couvrir au moins la longueur
  // du nouveau text.
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

/** Lookup direct du TextZone pour un selecteur. Sert quand on a besoin du
 *  texte courant (ex set_color qui doit re-emit avec le meme texte). */
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
