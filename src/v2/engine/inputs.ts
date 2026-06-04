/**
 * Phase 0 : analyse des produits en entree (xlsx parse).
 *
 * Compte les produits par section, donne les stats utiles a l'allocator
 * (Phase 2) pour decider combien de pages produit garder. La section est
 * normalisee (lowercase + sans accents) pour matcher robustement le label
 * des section_banner du template.
 */

import type { PlanProduct } from '../types';

export interface ProductsAnalysis {
  /** Map section_normalisee → produits dans l'ordre de l'input. */
  bySection: Map<string, PlanProduct[]>;
  /** Label "humain" original par section_normalisee (la 1re occurrence). */
  sectionLabels: Map<string, string>;
  /** Total produits, tous sections confondues. */
  total: number;
  /** Nombre de sections distinctes (incl '' = non-assignees). */
  sectionCount: number;
}

export function analyzeProducts(products: PlanProduct[]): ProductsAnalysis {
  const bySection = new Map<string, PlanProduct[]>();
  const sectionLabels = new Map<string, string>();
  for (const p of products) {
    const original = (p.section ?? '').trim();
    const key = normalizeSection(original);
    if (!sectionLabels.has(key) && original.length > 0) {
      sectionLabels.set(key, original);
    }
    const list = bySection.get(key) ?? [];
    list.push(p);
    bySection.set(key, list);
  }
  return {
    bySection,
    sectionLabels,
    total: products.length,
    sectionCount: bySection.size,
  };
}

import { transliterate } from './textNormalize';

/** Normalisation pour matcher product.section <-> section_banner detecte.
 *  Pipeline : transliterate (chars non-NFD : ß/ø/þ/ł) → NFKD + strip
 *  diacritiques → lowercase → strip non-alphanum → trim. */
export function normalizeSection(s: string): string {
  return transliterate(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
