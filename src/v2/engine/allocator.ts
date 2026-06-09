/**
 * Phase 2: allocation of product pages ↔ new products.
 *
 * Computes how many template product pages to keep based on the per-section
 * need. Strict rule: 1 page = 1 section. A template page has N blocks (1, 2
 * or 3 depending on the template); we fill up to N products from the assigned
 * section. If fewer, we keep the empty blocks erased. If more, we pick a 2nd
 * template page for the same section.
 *
 * Output: a list of PageAllocation (= product pages to keep) + unplaced
 * products + template product pages to drop.
 */

import type { PlanProduct } from '../types';
import type { PageClassification } from './classify';
import type { ProductsAnalysis } from './inputs';
import { normalizeSection } from './inputs';

/** Multi-criteria score to evaluate the "quality" of a candidate product
 *  page (Phase 3 allocator scoring).
 *
 *  Strategy: weights blockCount + spec density + image presence + ref
 *  presence. The higher the score, the "richer" the page and the higher
 *  its priority as a substitution candidate.
 *
 *  Wired optionally via a feature flag (zero regression on Catalogue A default).
 *
 *  Components:
 *   - blockCount: 30% (block-rich page > 1-block page)
 *   - avgSpecsPerBlock: 30% (numerous specs = real sheets)
 *   - imagesRatio: 20% (% of blocks with mainImageBbox)
 *   - refsRatio: 20% (% of blocks with refSpan)
 */
export interface PageScoreBreakdown {
  blockCount: number;
  avgSpecsPerBlock: number;
  imagesRatio: number;
  refsRatio: number;
  total: number;
}

export function scoreProductPage(page: PageClassification): PageScoreBreakdown {
  const blocks = page.blocks ?? [];
  if (blocks.length === 0) {
    return { blockCount: 0, avgSpecsPerBlock: 0, imagesRatio: 0, refsRatio: 0, total: 0 };
  }
  // Normalized components [0, 1]
  // blockCount: sigmoid plateau at 3 (3 blocks ≈ max score)
  const blockComp = Math.min(1, blocks.length / 3);
  // avgSpecsPerBlock: plateau at 5 specs/block (beyond = very modest bonus)
  const totalSpecs = blocks.reduce((acc, b) => acc + b.specs.length, 0);
  const avgSpecs = totalSpecs / blocks.length;
  const specsComp = Math.min(1, avgSpecs / 5);
  // imagesRatio: % of blocks with mainImageBbox
  const withImg = blocks.filter((b) => b.mainImageBbox !== null).length;
  const imgComp = withImg / blocks.length;
  // refsRatio: % of blocks with refSpan
  const withRef = blocks.filter((b) => b.refSpan !== null).length;
  const refComp = withRef / blocks.length;
  const total = blockComp * 0.30 + specsComp * 0.30 + imgComp * 0.20 + refComp * 0.20;
  return {
    blockCount: blockComp,
    avgSpecsPerBlock: specsComp,
    imagesRatio: imgComp,
    refsRatio: refComp,
    total,
  };
}

export interface PageAllocation {
  /** source_page (0-based index) of the template. */
  sourcePage: number;
  /** Assigned section (normalized string). */
  section: string;
  /** Original section label (for the sommaire). */
  sectionLabel: string;
  /** Products to place in this page's blocks (may be < blockCount). */
  products: PlanProduct[];
  /** Number of blocks on the template page. */
  blockCount: number;
}

/** Reason for dropping an unused product page (observability to diagnose
 *  template-page waste - audit flaw). */
export type DropReason =
  | 'no_section_match' // template section matches no product in the plan
  | 'section_overprovided' // section has enough pages, smallest-fit ignored it
  | 'no_active_section'; // page with no detected section banner (ambiguous)

export interface DroppedPageDetail {
  pageNumber: number;
  reason: DropReason;
  activeSection: string;
  blockCount: number;
}

export interface AllocationResult {
  allocations: PageAllocation[];
  /** Products that found no place (not enough product pages). */
  unmatched: PlanProduct[];
  /** Template product pages to drop (unused). */
  droppedProductPages: number[];
  /** Drop details with reason (observability). */
  droppedPageDetails?: DroppedPageDetail[];
  /** Second-pass warnings (products squeezed into a page of another section
   *  to avoid dropping them). */
  warnings?: string[];
}

/**
 * Allocation strategy:
 *  1. For each section with products, we look for the template product pages
 *     that match (by activeSection or token similarity) AND whose pattern
 *     (block count) is the most suitable.
 *  2. We consume the products on those pages, without mixing 2 sections on the
 *     same page (strict rule).
 *  3. If a template page matches no section, we drop it.
 */
export interface AllocateOptions {
  /** If true: products remaining after the 2nd pass overflow onto the first
   *  allocated page of their section (downstream `gridLayout` places them via
   *  block synthesis). If false (default): dropped into unmatched. */
  allowGridOverflow?: boolean;
  /** Phase 3 scoring: replaces smallest-fit with a multi-criteria sort via
   *  scoreProductPage. Default FALSE for zero regression on Catalogue A.
   *  Enabled on dense catalogs (Catalogue C/Catalogue E) where block/spec
   *  richness matters more than the "right size". */
  useRichnessScoring?: boolean;
}

export function allocatePages(
  classifications: PageClassification[],
  analysis: ProductsAnalysis,
  options: AllocateOptions = {},
): AllocationResult {
  // Guards: degenerate inputs
  if (analysis.total === 0) {
    return { allocations: [], unmatched: [], droppedProductPages: [] };
  }
  const productPages = classifications.filter(
    (c) => c.kind === 'product' && c.blocks.length > 0,
  );
  if (productPages.length === 0) {
    const allProducts: PlanProduct[] = [];
    for (const list of analysis.bySection.values()) allProducts.push(...list);
    return { allocations: [], unmatched: allProducts, droppedProductPages: [] };
  }

  const allocations: PageAllocation[] = [];
  const unmatched: PlanProduct[] = [];

  // Sections with products, sorted by decreasing size (the large ones first
  // to avoid a small section monopolizing a rich page).
  const sectionsToFill = Array.from(analysis.bySection.entries())
    .filter(([, list]) => list.length > 0)
    .sort(([, a], [, b]) => b.length - a.length);

  const allocatedPageNumbers = new Set<number>();

  for (const [sectionKey, products] of sectionsToFill) {
    const sectionLabel = analysis.sectionLabels.get(sectionKey) ?? sectionKey;
    const N = products.length;

    // Pool of available pages (section-matching filter if possible)
    const availablePages = productPages.filter(
      (p) => !allocatedPageNumbers.has(p.pageNumber),
    );
    if (availablePages.length === 0) {
      unmatched.push(...products);
      continue;
    }
    const matching = availablePages.filter((p) =>
      sectionMatches(p.activeSection, sectionKey),
    );
    const pool = matching.length > 0 ? matching : availablePages;

    // Compute NP = minimum number of pages to absorb N products, based on the
    // max block count among the available pages. BALANCED split of N into NP
    // parts (the first parts may have +1 if N % NP > 0).
    const maxBlocks = Math.max(...pool.map((p) => p.blocks.length), 1);
    const NP = Math.min(pool.length, Math.max(1, Math.ceil(N / maxBlocks)));
    const base = Math.floor(N / NP);
    const rest = N % NP;
    const parts: number[] = [];
    for (let i = 0; i < NP; i++) parts.push(base + (i < rest ? 1 : 0));

    // For each part, pick a page with blockCount >= part. Smallest fit
    // (= a page with just enough blocks) so as not to waste capacity.
    let queue = [...products];
    for (const part of parts) {
      const remainingPool = pool.filter(
        (p) => !allocatedPageNumbers.has(p.pageNumber),
      );
      if (remainingPool.length === 0) {
        unmatched.push(...queue);
        break;
      }
      // Sort: 1) pages with blockCount >= part first, 2) among those, either
      // smallest-fit (default) or multi-criteria scoring (Phase 3).
      const sorted = [...remainingPool].sort((a, b) => {
        const ax = a.blocks.length >= part ? 0 : 1;
        const bx = b.blocks.length >= part ? 0 : 1;
        if (ax !== bx) return ax - bx;
        // both same eligibility
        if (options.useRichnessScoring) {
          // Sort by richness score desc (rich pages prioritized)
          const scoreA = scoreProductPage(a).total;
          const scoreB = scoreProductPage(b).total;
          return scoreB - scoreA;
        }
        // Legacy: both >= part → smallest fit; both < part → largest first
        if (ax === 0) return a.blocks.length - b.blocks.length;
        return b.blocks.length - a.blocks.length;
      });
      const chosen = sorted[0];
      const take = Math.min(chosen.blocks.length, part, queue.length);
      allocations.push({
        sourcePage: chosen.pageNumber,
        section: sectionKey,
        sectionLabel,
        products: queue.slice(0, take),
        blockCount: chosen.blocks.length,
      });
      allocatedPageNumbers.add(chosen.pageNumber);
      queue = queue.slice(take);
    }
    if (queue.length > 0) unmatched.push(...queue);
  }

  // P2.6: second pass. We try to fit the unmatched into pages allocated to
  // ANOTHER section but that have residual capacity. Trade-off: the
  // "1 page = 1 section" rule is preserved while there are enough pages, but
  // relaxed to avoid dropping products. The section banner will display the
  // page's MAJORITY section.
  const allocWarnings: string[] = [];
  const leftover = [...unmatched];
  unmatched.length = 0;
  for (const product of leftover) {
    // Look for an allocation with residual capacity. Priority: the same
    // preferred section (e.g. EVIER / EVIERS) then any.
    const candidate = allocations.find(
      (a) => a.products.length < a.blockCount,
    );
    if (candidate) {
      candidate.products.push(product);
      const productSec = (product.section ?? '').trim();
      if (productSec && productSec !== candidate.sectionLabel) {
        allocWarnings.push(
          `produit "${product.name}" (section "${productSec}") place sur page ` +
            `dediee a "${candidate.sectionLabel}" — sections mixtes`,
        );
      }
    } else if (options.allowGridOverflow) {
      // No residual capacity left, but grid overflow is allowed: push onto the
      // first page of the same section (downstream gridLayout will synthesize
      // an extra block if the zone allows). Fall back to the first available
      // alloc if no page of the section exists.
      const productSec = (product.section ?? '').trim();
      const sameSection = allocations.find(
        (a) => productSec && a.sectionLabel === productSec,
      );
      const target = sameSection ?? allocations[0];
      if (target) {
        target.products.push(product);
        allocWarnings.push(
          `produit "${product.name}" en overflow grille sur page tpl ` +
            `${target.sourcePage} (${target.sectionLabel})`,
        );
      } else {
        unmatched.push(product);
      }
    } else {
      unmatched.push(product);
    }
  }

  // Unallocated product pages → DROP with a reason annotation.
  const unallocated = productPages.filter(
    (p) => !allocatedPageNumbers.has(p.pageNumber),
  );
  const droppedProductPages = unallocated.map((p) => p.pageNumber);
  // Sections that had products in the plan (to distinguish no_section_match
  // vs section_overprovided)
  const sectionsWithProducts = new Set(sectionsToFill.map(([k]) => k));
  const droppedPageDetails: DroppedPageDetail[] = unallocated.map((p) => {
    const activeSection = p.activeSection ?? '';
    let reason: DropReason;
    // Empty section (no banner detected on the template page): distinct from
    // "section present but no product matches"
    if (!activeSection) {
      reason = 'no_active_section';
    } else {
      const matchesAnyProductSection = Array.from(sectionsWithProducts).some(
        (k) => sectionMatches(activeSection, k),
      );
      reason = matchesAnyProductSection
        ? 'section_overprovided'
        : 'no_section_match';
    }
    return {
      pageNumber: p.pageNumber,
      reason,
      activeSection,
      blockCount: p.blocks.length,
    };
  });

  return {
    allocations,
    unmatched,
    droppedProductPages,
    droppedPageDetails,
    warnings: allocWarnings.length > 0 ? allocWarnings : undefined,
  };
}

/** Match template section (raw label) vs product section (normalized). */
function sectionMatches(activeSection: string, sectionKey: string): boolean {
  if (!activeSection || !sectionKey) return false;
  const tplNorm = normalizeSection(activeSection);
  if (tplNorm === sectionKey) return true;
  // Token Jaccard
  const tplToks = tplNorm.split(' ').filter((t) => t.length >= 3);
  const prodToks = sectionKey.split(' ').filter((t) => t.length >= 3);
  if (tplToks.length === 0 || prodToks.length === 0) return false;
  const inter = tplToks.filter((t) => prodToks.includes(t)).length;
  if (inter === 0) return false;
  const minLen = Math.min(tplToks.length, prodToks.length);
  return inter / minLen >= 0.5;
}

