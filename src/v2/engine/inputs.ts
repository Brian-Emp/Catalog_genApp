/**
 * Phase 0: analysis of the input products (xlsx parse).
 *
 * Counts products by section, provides the stats the allocator (Phase 2)
 * needs to decide how many product pages to keep. The section is normalized
 * (lowercase + accent-free) to robustly match the template section_banner
 * label.
 */

import type { PlanProduct } from '../types';

export interface ProductsAnalysis {
  /** Map normalized_section → products in input order. */
  bySection: Map<string, PlanProduct[]>;
  /** Original "human" label per normalized_section (first occurrence). */
  sectionLabels: Map<string, string>;
  /** Total products, across all sections. */
  total: number;
  /** Number of distinct sections (incl '' = unassigned). */
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

/** Normalization to match product.section <-> detected section_banner.
 *  Pipeline: transliterate (non-NFD chars: ß/ø/þ/ł) → NFKD + strip
 *  diacritics → lowercase → strip non-alphanum → trim. */
export function normalizeSection(s: string): string {
  return transliterate(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
