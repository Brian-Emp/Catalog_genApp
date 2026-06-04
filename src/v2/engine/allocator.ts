/**
 * Phase 2 : allocation pages produit ↔ nouveaux produits.
 *
 * Calcule combien de pages produit du template garder selon le besoin par
 * section. Regle stricte : 1 page = 1 section. Une page template a N blocs
 * (1, 2 ou 3 selon le template), on remplit jusqu'a N produits depuis la
 * section assignee. Si moins, on garde les blocs vides effaces. Si plus,
 * on choisit une 2eme page template pour la meme section.
 *
 * Sortie : liste de PageAllocation (= pages produit a garder) + produits
 * non places + pages produit du template a drop.
 */

import type { PlanProduct } from '../types';
import type { PageClassification } from './classify';
import type { ProductsAnalysis } from './inputs';
import { normalizeSection } from './inputs';

/** Score multi-criteres pour evaluer la "qualite" d'une page produit
 *  candidate (Phase 3 scoring allocator).
 *
 *  Strategie : pondere blockCount + densite specs + presence images +
 *  presence refs. Plus le score est haut, plus la page est "riche" et
 *  candidate prioritaire pour substitution.
 *
 *  Branche optionnellement via feature flag (zero regression Catalogue A default).
 *
 *  Composantes :
 *   - blockCount : 30% (page riche en blocs > page 1-bloc)
 *   - avgSpecsPerBlock : 30% (specs nombreuses = vraies fiches)
 *   - imagesRatio : 20% (% blocs avec mainImageBbox)
 *   - refsRatio : 20% (% blocs avec refSpan)
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
  // Composantes normalisees [0, 1]
  // blockCount : sigmoid plateau a 3 (3 blocs ≈ score max)
  const blockComp = Math.min(1, blocks.length / 3);
  // avgSpecsPerBlock : plateau a 5 specs/bloc (au-dela = bonus tres modere)
  const totalSpecs = blocks.reduce((acc, b) => acc + b.specs.length, 0);
  const avgSpecs = totalSpecs / blocks.length;
  const specsComp = Math.min(1, avgSpecs / 5);
  // imagesRatio : % blocs avec mainImageBbox
  const withImg = blocks.filter((b) => b.mainImageBbox !== null).length;
  const imgComp = withImg / blocks.length;
  // refsRatio : % blocs avec refSpan
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
  /** source_page (index 0-based) du template. */
  sourcePage: number;
  /** Section assignee (string normalisee). */
  section: string;
  /** Label original de la section (pour le sommaire). */
  sectionLabel: string;
  /** Produits a placer dans les blocs de cette page (peut etre < blockCount). */
  products: PlanProduct[];
  /** Nombre de blocs sur la page template. */
  blockCount: number;
}

/** Raison du drop d'une page produit non utilisee (observabilite pour
 *  diagnostiquer le gaspillage de pages template - faille audit). */
export type DropReason =
  | 'no_section_match' // section template ne matche aucun produit du plan
  | 'section_overprovided' // section a assez de pages, smallest-fit a ignoré
  | 'no_active_section'; // page sans banner section detectee (ambigu)

export interface DroppedPageDetail {
  pageNumber: number;
  reason: DropReason;
  activeSection: string;
  blockCount: number;
}

export interface AllocationResult {
  allocations: PageAllocation[];
  /** Produits qui n'ont pas trouve de place (manque de pages produit). */
  unmatched: PlanProduct[];
  /** Pages produit du template a drop (non utilisees). */
  droppedProductPages: number[];
  /** Detail des drops avec raison (observabilite). */
  droppedPageDetails?: DroppedPageDetail[];
  /** Warnings de second pass (produits caseroles dans une page d'une autre
   *  section pour eviter qu'ils soient drop). */
  warnings?: string[];
}

/**
 * Strategie d'allocation :
 *  1. Pour chaque section avec produits, on cherche les pages produit du
 *     template qui matche (par activeSection ou similarite tokens) ET dont
 *     le pattern (nb blocs) est le plus adapte.
 *  2. On consomme les produits sur ces pages, sans melanger 2 sections sur
 *     une meme page (regle stricte).
 *  3. Si une page template matche aucune section, on la drop.
 */
export interface AllocateOptions {
  /** Si true : produits restants apres 2e pass sont overflowes sur la 1ere
   *  page allouee de leur section (downstream `gridLayout` les place via
   *  synthese de blocs). Si false (default) : drop dans unmatched. */
  allowGridOverflow?: boolean;
  /** Phase 3 scoring : remplace le smallest-fit par un sort multi-criteres
   *  via scoreProductPage. Default FALSE pour zero regression Catalogue A. Active
   *  sur catalogues denses (Catalogue C/Catalogue E) ou la richesse de blocs/specs
   *  importe plus que la "taille juste". */
  useRichnessScoring?: boolean;
}

export function allocatePages(
  classifications: PageClassification[],
  analysis: ProductsAnalysis,
  options: AllocateOptions = {},
): AllocationResult {
  // Guards : entrees degenerees
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

  // Sections avec produits, triees par taille decroissante (les grosses
  // d'abord pour eviter qu'une petite section monopolise une page riche).
  const sectionsToFill = Array.from(analysis.bySection.entries())
    .filter(([, list]) => list.length > 0)
    .sort(([, a], [, b]) => b.length - a.length);

  const allocatedPageNumbers = new Set<number>();

  for (const [sectionKey, products] of sectionsToFill) {
    const sectionLabel = analysis.sectionLabels.get(sectionKey) ?? sectionKey;
    const N = products.length;

    // Pool de pages disponibles (filtre matching section si possible)
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

    // Calcul NP = nombre minimum de pages pour absorber N produits, base
    // sur le max block count parmi les pages dispo. Split EQUILIBRE de N
    // en NP parts (les premieres parts peuvent avoir +1 si N % NP > 0).
    const maxBlocks = Math.max(...pool.map((p) => p.blocks.length), 1);
    const NP = Math.min(pool.length, Math.max(1, Math.ceil(N / maxBlocks)));
    const base = Math.floor(N / NP);
    const rest = N % NP;
    const parts: number[] = [];
    for (let i = 0; i < NP; i++) parts.push(base + (i < rest ? 1 : 0));

    // Pour chaque part, choisir une page avec blockCount >= part. Smallest
    // fit (= page avec juste assez de blocs) pour ne pas gacher de capacite.
    let queue = [...products];
    for (const part of parts) {
      const remainingPool = pool.filter(
        (p) => !allocatedPageNumbers.has(p.pageNumber),
      );
      if (remainingPool.length === 0) {
        unmatched.push(...queue);
        break;
      }
      // Trie : 1) pages avec blockCount >= part en 1er, 2) parmi celles-ci,
      // soit smallest-fit (default), soit scoring multi-criteres (Phase 3).
      const sorted = [...remainingPool].sort((a, b) => {
        const ax = a.blocks.length >= part ? 0 : 1;
        const bx = b.blocks.length >= part ? 0 : 1;
        if (ax !== bx) return ax - bx;
        // both same eligibility
        if (options.useRichnessScoring) {
          // Tri par score richness desc (pages riches prioritaires)
          const scoreA = scoreProductPage(a).total;
          const scoreB = scoreProductPage(b).total;
          return scoreB - scoreA;
        }
        // Legacy : both >= part → smallest fit ; both < part → largest first
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

  // P2.6 : second pass. On tente de caser les unmatched dans des pages
  // allouees a une AUTRE section mais qui ont de la capacite residuelle.
  // Compromis : la regle "1 page = 1 section" est preservee tant qu'il y a
  // assez de pages, mais relachee pour eviter de drop des produits. Le
  // banner section affichera la section MAJORITAIRE de la page.
  const allocWarnings: string[] = [];
  const leftover = [...unmatched];
  unmatched.length = 0;
  for (const product of leftover) {
    // Cherche une allocation avec capacite residuelle. Priorite : meme
    // section preferentielle (ex EVIER / EVIERS) puis n'importe quelle.
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
      // Plus aucune capacite residuelle, mais l'overflow grille est autorise :
      // pousser sur la 1ere page de la meme section (gridLayout downstream
      // synthetisera un bloc supplementaire si la zone le permet). Fallback
      // sur la 1ere alloc dispo si aucune page de la section n'existe.
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

  // Pages produit non allouees → DROP avec annotation de raison.
  const unallocated = productPages.filter(
    (p) => !allocatedPageNumbers.has(p.pageNumber),
  );
  const droppedProductPages = unallocated.map((p) => p.pageNumber);
  // Sections qui ont eu des produits dans le plan (pour distinguer
  // no_section_match vs section_overprovided)
  const sectionsWithProducts = new Set(sectionsToFill.map(([k]) => k));
  const droppedPageDetails: DroppedPageDetail[] = unallocated.map((p) => {
    const activeSection = p.activeSection ?? '';
    let reason: DropReason;
    // Section vide (pas de banner detecte sur la page template) :
    // distinct de "section presente mais aucun produit ne matche"
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

/** Match section du template (label brut) vs section produit (normalisee). */
function sectionMatches(activeSection: string, sectionKey: string): boolean {
  if (!activeSection || !sectionKey) return false;
  const tplNorm = normalizeSection(activeSection);
  if (tplNorm === sectionKey) return true;
  // Jaccard tokens
  const tplToks = tplNorm.split(' ').filter((t) => t.length >= 3);
  const prodToks = sectionKey.split(' ').filter((t) => t.length >= 3);
  if (tplToks.length === 0 || prodToks.length === 0) return false;
  const inter = tplToks.filter((t) => prodToks.includes(t)).length;
  if (inter === 0) return false;
  const minLen = Math.min(tplToks.length, prodToks.length);
  return inter / minLen >= 0.5;
}

