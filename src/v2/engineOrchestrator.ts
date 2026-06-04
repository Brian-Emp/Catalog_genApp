/**
 * Orchestrator V2 engine — pipeline complet.
 *
 * Phases (dans l'ordre strict du cahier des charges) :
 *   Phase 0 — inputs : extract C++ + parse produits par section
 *   Phase 1.1 — classify : kind par page (product/toc/glossaire/intercalaire/identity)
 *   Phase 2 — allocate : choix pages produit selon besoin (1 section = 1 page)
 *   Phase 1.2 — claudeAudit : Claude valide + corrige + ajoute des drops
 *   Phase 3 — substitute : ops par bloc (style emprunte du template)
 *   Phase final — assemblage Plan + renumerotation + render C++ (le sommaire
 *     sur mesure ex-Phase 4 est desactive : trop fragile sur sommaires
 *     design — voir tocBuilder.ts dans l'historique git pour reactivation).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { runBinary } from './binaryRunner';
import { allocatePages, type PageAllocation } from './engine/allocator';
import { classifyAllPages, isRealSectionBannerLabel } from './engine/classify';
import { applyAuditCorrections, claudeAudit } from './engine/claudeAudit';
import { analyzeProducts } from './engine/inputs';
import { inferProductSection, shouldInferSections } from './engine/inferSection';
import { detectProfile } from './engine/profile';
import { dominantOrientation, type PageOrientation } from './engine/orientation';
import { generateDescriptions } from './engine/descriptionWriter';
import { normalizeSpecs } from './engine/specNormalizer';
import {
  substitutePage,
  TEXT_WIDTH_COEFS,
  getMissingProductImages,
  resetMissingProductImages,
} from './engine/substitutor';
import { intentSubstitutePage } from './intent/intentSubstitute';
import { buildPageSchema } from './intent/schemaMapper';
import { runIntentLoop } from './intent/intentLoop';
import type { PageSchema } from './intent/schema';
import type { ProductBlock } from './engine/blockDetector';
import { resetDroppedPages, resetHorizontalLayoutPages } from './engine/blockDetector';
import { buildTocFromTemplate } from './engine/tocFromTemplate';
import { formatSpecValues } from './engine/valueFormatter';
import { visualAudit, type VisualAuditIssue } from './engine/visualAudit';
import { appendCahiersTechniques } from './engine/cahierTechnique';
import type {
  ExtractedPage,
  Operation,
  PagePlan,
  Plan,
  PlanProduct,
  TextSpan,
} from './types';
import { validateExtractedPage } from './validation/extractedPage';
import { EXTRACT_TIMEOUT_MS, RENDER_TIMEOUT_MS } from './timeouts';
import { INSERT_TEXT_BASELINE_OFFSET_PT } from './insertText';
import { isLightColor } from './engine/safeColor';
import { pdfHash, saveToCache, tryRestoreFromCache } from './extractCache';

/** Retourne la valeur majoritaire d'un champ optionnel sur une liste de
 *  PlanProducts. Vide si tous absents. Utilisé pour récupérer la famille /
 *  sous-famille d'une allocation (majorité parmi ses produits). */
function majorityField(products: PlanProduct[], field: 'family' | 'subFamily' | 'section'): string {
  const counts = new Map<string, number>();
  for (const p of products) {
    const v = (p[field] ?? '').toString().trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export interface EngineOrchestratorOptions {
  templatePdfPath: string;
  products: PlanProduct[];
  assetsDir: string;
  jobId: string;
  workDir: string;
  outPdfPath: string;
  projectDir: string;
  binaryBin?: string;
  claudeBin?: string;
  /** Active l'audit Claude (~2-3 min). Defaut false (pipeline rapide ~2s). */
  enableClaudeAudit?: boolean;
  /** Active l'audit visuel final par Claude (vision sur N pages echantillonnees
   *  apres render). Default FALSE — l'audit prend ~60s sur 80s du pipeline,
   *  ratio cout/benefice insuffisant pour l'usage courant. Activer via flag
   *  pour les generations critiques (release client par exemple). */
  enableVisualAudit?: boolean;
  /** Taille echantillon pour l'audit visuel. Default 6. 'all' pour toutes
   *  les pages substituees (couteux). */
  visualAuditSampleSize?: number | 'all';
  /** Active l'audit visuel via Gemini Vision (gratuit free tier + pas
   *  d'expiration auth, alternative a Claude). Default TRUE : Gemini est
   *  gratuit donc safe en defaut. Skip gracieux si GEMINI_KEY absente.
   *  Mettre FALSE pour desactiver explicitement. Cumulable avec
   *  enableVisualAudit (Claude) pour cross-check. */
  enableGeminiAudit?: boolean;
  /** Active l'audit de coherence globale via Gemini Pro Vision (analyse
   *  cross-page : typo / couleurs / hierarchie / alignements / pagination).
   *  Un seul appel batch, context 1M tokens. Default FALSE. */
  enableGeminiCoherenceAudit?: boolean;
  /** Active la normalisation des spec keys produit au style template via
   *  Claude (declenche uniquement si mismatch detecte > 50%). Default true. */
  enableSpecNormalization?: boolean;
  /** Active le reformatting des spec values au style template (ex "60" →
   *  "60 cm" si template utilise les unites). Default true. */
  enableValueFormatting?: boolean;
  /** Active la generation des descriptions marketing (Gemini/Claude) pour le
   *  sommaire. Default TRUE (on garde la feature). Decouple de enableTemplateToc :
   *  le TOC se rend de toute facon (deterministe), sans descriptions il n'a juste
   *  pas de blurbs. Fail-fast sur quota mort (skip rapide, jamais bloquant). */
  enableGeminiDescriptions?: boolean;
  /** Active la reutilisation de la page sommaire originale du template :
   *  nettoie les anciennes entries et ecrit les sections du nouveau catalogue
   *  en preservant la deco / typo / mise en page d'origine. Place la page TOC
   *  juste avant la 1ere page produit substituee. Default true. */
  enableTemplateToc?: boolean;
  /** Active la chaine IntentPlan (approche BC) : construit un PageSchema par
   *  page produit substituee + persiste un plan_v2.json informationnel a cote
   *  du plan bas niveau. Le binaire C++ ne voit aucun changement.
   *
   *  IMPORTANT : default TRUE (intent par defaut). Pour desactiver explicitement,
   *  passer `enableIntentPlan: false`. Le code utilise `opts.enableIntentPlan
   *  !== false` (cf engineOrchestrator.ts:554 useIntentSubstitute). Ce choix
   *  vient de BC_test ou intent etait le default. Si tu veux le pipeline
   *  V2 procedural strict (substitutor.ts seul), passe false explicitement. */
  enableIntentPlan?: boolean;
  /** Active la boucle Claude → IntentOps → re-render apres le 1er render
   *  C++ (approche BC). Necessite enableIntentPlan true (sinon pas de
   *  schemas dispo). Defaut FALSE. Cout : ~$0.02-0.05/page * sample * iter. */
  enableIntentLoop?: boolean;
  /** Plafond de pages echantillonees par passe de boucle intent. Defaut 5. */
  intentLoopSampleSize?: number;
  /** Nombre max de passes Claude → re-render. Defaut 2. */
  intentLoopMaxIterations?: number;
  /** Callback de progression (phase, pct, message FR). Invoque a chaque
   *  transition de phase. Peut etre absent (pas de tracker cote serveur). */
  onProgress?: (phase: string, pct: number, message: string) => void;
}

/** Usage Gemini agrege pour CETTE generation (diagnostic UI). */
export interface GeminiUsage {
  /** Appels par modele (nom API → nombre) pour cette generation. Permet a l'UI
   *  d'afficher le(s) modele(s) reellement utilise(s) et les bascules. */
  byModel: Record<string, number>;
  /** Detail par modele (appels / ok / quota429) → l'UI montre quels modeles
   *  de la cascade sont epuises vs sains. */
  byModelDetail?: Record<string, { calls: number; ok: number; quota: number }>;
  totalCalls: number;
  okCalls: number;
  /** Bascules de cascade (un appel a du passer a un modele de secours). */
  fallbacks: number;
  /** Erreurs 429 (quota) rencontrees. */
  calls429: number;
}

export interface EngineOrchestratorResult {
  ok: boolean;
  outPdfPath: string;
  stats: {
    pagesKept: number;
    pagesDeleted: number;
    productsUsed: number;
    productsRemaining: number;
    extractMs: number;
    classifyMs: number;
    allocateMs: number;
    claudeAuditMs: number;
    substituteMs: number;
    renderMs: number;
    profileSource: string;
    /** Nb total de pages produit du template (kind='product') avant allocator. */
    productPagesTotal?: number;
    /** Nb de pages produit effectivement allouees a un produit du plan. */
    productPagesAllocated?: number;
    /** Ratio allocated/total (0..1). Indicateur d'efficacite allocator.
     *  Sur Catalogue A : 8/188 = 0.04 (catalogue volumineux, peu de produits).
     *  Sur catalogue dense bien dimensionne : > 0.5. */
    allocationRatio?: number;
    /** Repartition raisons de drop des pages non allouees. */
    dropReasonCounts?: Record<string, number>;
    claudeCorrections: number;
    claudeCostUsd?: number;
    visualAuditMs?: number;
    visualAuditCostUsd?: number;
    visualAuditSampledCount?: number;
    visualAuditCriticalCount?: number;
    visualAuditMinorCount?: number;
    specNormalizerMs?: number;
    specNormalizerCostUsd?: number;
    specNormalizerKeysRemapped?: number;
    valueFormatterMs?: number;
    valueFormatterCostUsd?: number;
    valueFormatterValuesReformatted?: number;
    tocSourcePage?: number | null;
    tocEntriesWritten?: number;
    intentLoopMs?: number;
    intentLoopCostUsd?: number;
    intentLoopIterations?: number;
    intentLoopIntents?: number;
    intentLoopOpsApplied?: number;
  };
  warnings: string[];
  errors: string[];
  claudeNotes: string[];
  visualAuditIssues?: VisualAuditIssue[];
  /** Issues d'audit Gemini (visuel page + coherence cross-page) agregees pour
   *  l'UI "pages a verifier" (garde-fou de relecture). undefined si aucune. */
  geminiAuditIssues?: GeminiAuditIssue[];
  /** Usage Gemini de CETTE generation (modeles utilises + bascules de cascade)
   *  pour le diagnostic UI. undefined si aucun appel Gemini. */
  geminiUsage?: GeminiUsage;
  /** Plan final assemble (pour post-processing : TOC, exports). */
  plan?: Plan;
  /** Allocations produits → pages template (pour post-processing). */
  allocations?: PageAllocation[];
}

/** Issue d'audit Gemini unifiee (visuel page-par-page OU coherence cross-page),
 *  format leger pour l'UI "pages a verifier". */
export interface GeminiAuditIssue {
  /** Page finale principale concernee (1-based). */
  page: number;
  /** Pages multiples (audit coherence cross-page). */
  pages?: number[];
  severity: 'critical' | 'minor';
  category: string;
  description: string;
  productName?: string;
  /** Origine : audit visuel page-par-page ou audit de coherence globale. */
  source: 'visual' | 'coherence';
}

// En prod Docker (Linux x64/arm64) le binaire est installe a
// /usr/local/bin/catgen-pdf. En local macOS ARM, Homebrew utilise
// /opt/homebrew/bin/. On accepte les 2 ; en dev override via env
// CATGEN_BIN (recommande).
const LINUX_BINARY = '/usr/local/bin/catgen-pdf';
const HOMEBREW_BINARY = '/opt/homebrew/bin/catgen-pdf';
function resolveDefaultBinary(): string {
  // Priorite env > local Homebrew (si fichier existe) > Linux. Le check
  // d'existence se fait au lancement du child_process via spawn (gere
  // ENOENT). Ici on retourne juste le path par defaut le plus probable.
  if (process.env.CATGEN_BIN) return process.env.CATGEN_BIN;
  if (process.platform === 'darwin') return HOMEBREW_BINARY;
  return LINUX_BINARY;
}

/**
 * Pipeline V2 complet : extract → classify → allocate → substitute → render.
 * Le nettoyage du workDir est delegue au caller (cf generate.ts qui a besoin
 * de lire plan.json APRES retour pour le copier a cote du PDF).
 */
export async function substituteCatalogEngine(
  opts: EngineOrchestratorOptions,
): Promise<EngineOrchestratorResult> {
  const binary = opts.binaryBin ?? resolveDefaultBinary();
  const warnings: string[] = [];
  const claudeNotes: string[] = [];
  const progress = opts.onProgress ?? (() => {});

  // Reset des accumulateurs module-level de blockDetector : sur un serveur
  // long-lived, droppedPages/horizontalLayoutPages s'empilaient entre
  // generations (fuite lente + debug melange). On repart propre a chaque run.
  resetDroppedPages();
  resetHorizontalLayoutPages();

  // Snapshot stats Gemini avant pipeline pour mesurer l'usage de CETTE
  // generation (vs cumul global du process).
  const { snapshotMark, statsSince, formatAggregate } = await import('./gemini/stats');
  const geminiStatsMark = snapshotMark();

  progress('extract', 6, 'Extraction du template…');
  await fs.mkdir(opts.workDir, { recursive: true });
  const workTemplatePdf = path.join(opts.workDir, 'template.pdf');
  const workTemplatesDir = path.join(opts.workDir, 'templates');
  const workProducts = path.join(opts.workDir, 'products.json');
  const workPlan = path.join(opts.workDir, 'plan.json');
  try {
    await fs.copyFile(opts.templatePdfPath, workTemplatePdf);
    await fs.writeFile(workProducts, JSON.stringify(opts.products, null, 2), 'utf8');
  } catch (e) {
    // Echec setup workDir (ENOSPC, perms) → echec propre.
    return failResultBootstrap(`setup workDir failed: ${(e as Error).message}`);
  }

  // ─── Extract C++ ──────────────────────────────────────────────────────────
  // Cache hit ? Si meme template hash deja extrait, on copie les JSONs et
  // on saute le binaire (~700ms → ~30ms). Sinon extract normal + save.
  const extractStart = Date.now();
  const templateHash = await pdfHash(workTemplatePdf).catch(() => null);
  let extractCacheHit = false;
  if (templateHash) {
    extractCacheHit = await tryRestoreFromCache(templateHash, workTemplatesDir);
  }
  const extractRes = extractCacheHit
    ? { ok: true, exitCode: 0, stderr: '', stdout: '[cache hit]', durationMs: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false }
    : await runBinary({
        bin: binary,
        args: ['extract', workTemplatePdf, workTemplatesDir],
        timeoutMs: EXTRACT_TIMEOUT_MS,
        stderrLogPath: path.join(opts.workDir, 'extract.stderr.log'),
      });
  if (!extractCacheHit && extractRes.ok && templateHash) {
    // Save best-effort : si filesystem cache fail (perms, ENOSPC), on
    // continue sans planter le pipeline. Le prochain run re-extractera.
    await saveToCache(templateHash, workTemplatesDir).catch((e: unknown) => {
      warnings.push(`extract cache save failed (non-fatal): ${(e as Error).message}`);
    });
  }
  const extractMs = Date.now() - extractStart;
  if (!extractRes.ok) {
    return failResult({
      msg: `extract failed (exit ${extractRes.exitCode}): ${extractRes.stderr.slice(0, 500)}`,
      extractMs,
      classifyMs: 0,
      allocateMs: 0,
      claudeAuditMs: 0,
      substituteMs: 0,
      renderMs: 0,
      profileSource: '',
      claudeCorrections: 0,
      warnings,
      notes: claudeNotes,
    });
  }
  const pages = await loadExtractedPages(workTemplatesDir, warnings);
  if (pages.length === 0) {
    const stderrTail = extractRes.stderr.slice(-400).trim();
    return failResult({
      msg:
        'aucune page extracted valide. PDF vide, corrompu, ou extracteur planté.'
        + (stderrTail ? ` stderr: ${stderrTail}` : ''),
      extractMs,
      classifyMs: 0,
      allocateMs: 0,
      claudeAuditMs: 0,
      substituteMs: 0,
      renderMs: 0,
      profileSource: '',
      claudeCorrections: 0,
      warnings,
      notes: claudeNotes,
    });
  }

  // ─── Orientation pages (portrait / paysage) ───────────────────────────────
  // Détecte l'orientation dominante sur l'échantillon de pages extraites.
  // Catalogues type Catalogue A/Catalogue E = paysage (legacy). Catalogues type Catalogue C /
  // Catalogue B Jardin = portrait. Le pipeline supporte les 2 orientations
  // depuis l'introduction du profile heuristique adaptatif. Pas de warning
  // explicite (recalibrage : ce n'est plus une limitation).
  const orientation: PageOrientation = dominantOrientation(pages);

  // ─── Profile typo ─────────────────────────────────────────────────────────
  const profile = await detectProfile({
    pages,
    heuristicOnly: true,
  });
  if (profile.source === 'fallback') {
    warnings.push(
      'profile: aucune page-fiche-produit detectee heuristiquement. ' +
        'Le pipeline utilise un profil generique — resultats imprevisibles ' +
        'sur ce template. Verifie que les fiches ont des spec keys avec ":".',
    );
  }


  // ─── Phase 0 : inputs ────────────────────────────────────────────────────
  progress('classify', 14, 'Détection des blocs et sections…');
  const analysis = analyzeProducts(opts.products);

  // ─── Phase 1.1 : classify ────────────────────────────────────────────────
  const classifyStart = Date.now();
  const baseClassifications = classifyAllPages(pages, profile);
  const classifyMs = Date.now() - classifyStart;

  // P2.5 : alerte forte si aucun bloc produit detecte alors qu'on a des
  // produits a substituer. Template "purement visuel" sans key/value
  // typographique, ou heuristique blocDetector incompatible. Pipeline
  // continuera mais produira 0 substitution.
  const totalBlocks = baseClassifications.reduce((s, c) => s + c.blocks.length, 0);
  if (totalBlocks === 0 && opts.products.length > 0) {
    warnings.push(
      `aucun bloc produit detecte dans ${pages.length} page(s) template. ` +
        'Le PDF de sortie reprend le template sans substitution. ' +
        'Possibles causes : template sans cle/valeur typographique, ' +
        'profil typographique fallback, ou patterns trop stricts.',
    );
  }
  // Detection "template non-standard" : tres peu de pages produit
  // detectees par rapport au nombre total de pages, OU confidence
  // moyenne tres basse. Indique probablement un layout que V2 ne sait
  // pas traiter proprement (tableaux multi-produits, merchandising,
  // catalogue tres design...). Le pipeline va quand meme essayer mais
  // le rendu sera probablement chevauche / incoherent.
  const productPages = baseClassifications.filter((c) => c.kind === 'product').length;
  const productRatio = pages.length > 0 ? productPages / pages.length : 0;
  if (productPages > 0 && productRatio < 0.05) {
    warnings.push(
      `template non-standard : seulement ${productPages}/${pages.length} `
        + `pages classifiees produit (${Math.round(productRatio * 100)}%). `
        + 'V2 calibree sur layout 1 produit = 1 bloc vertical avec specs '
        + 'en colonne droite. Si le template a un layout tableau multi-'
        + 'produits ou merchandising, le rendu sera chevauche. ',
    );
  }

  // ─── Phase 1.5 : inférence de section depuis le template ────────────────
  // Si la majorité des produits n'a pas de section renseignée mais le template
  // contient plusieurs sections distinctes (banners), on infère pour chaque
  // produit la section la + proche par tokens du nom. Permet de supporter
  // les XLSX simples (sans colonne famille/section).
  let effectiveAnalysis = analysis;
  {
    const emptyCount = opts.products.filter((p) => !(p.section ?? '').trim()).length;
    const candidateSections = Array.from(new Set(
      baseClassifications
        .map((c) => (c.activeSection ?? '').trim())
        .filter((s) => s.length > 0),
    ));
    if (shouldInferSections(emptyCount, opts.products.length, candidateSections.length)) {
      let inferred = 0;
      for (const p of opts.products) {
        if ((p.section ?? '').trim()) continue;
        const guess = inferProductSection(p.name, candidateSections);
        if (guess) {
          p.section = guess;
          inferred++;
        }
      }
      if (inferred > 0) {
        warnings.push(
          `inference section : ${inferred}/${emptyCount} produit(s) sans section associes via tokens du nom (${candidateSections.length} sections candidates)`
        );
        // Re-analyse avec les sections inférées
        effectiveAnalysis = analyzeProducts(opts.products);
      }
    }
  }

  // ─── Phase 2 : allocate ──────────────────────────────────────────────────
  progress('allocate', 20, 'Allocation des pages produit…');
  const allocateStart = Date.now();
  const allocation = allocatePages(baseClassifications, effectiveAnalysis, {
    // Si trop de produits pour les pages template dispo, on autorise
    // l'overflow grille : downstream `gridLayout` synthetise des blocs
    // additionnels par translation verticale du bloc tpl ref. Permet de
    // ne pas drop des produits silencieusement.
    allowGridOverflow: true,
  });
  const allocateMs = Date.now() - allocateStart;

  // Stats allocator pour response API (quick win audit)
  const productPagesTotal = baseClassifications.filter(
    (c) => c.kind === 'product',
  ).length;
  const productPagesAllocated = allocation.allocations.length;
  const allocationRatio =
    productPagesTotal > 0 ? productPagesAllocated / productPagesTotal : 0;
  const dropReasonCounts: Record<string, number> = {};
  for (const d of allocation.droppedPageDetails ?? []) {
    dropReasonCounts[d.reason] = (dropReasonCounts[d.reason] ?? 0) + 1;
  }

  // Warnings sur les pages produit non utilisees (sur-allocation template).
  if (allocation.droppedProductPages.length > 0) {
    // Breakdown des raisons pour observabilite (audit bloquants production)
    const reasonCounts = new Map<string, number>();
    for (const d of allocation.droppedPageDetails ?? []) {
      reasonCounts.set(d.reason, (reasonCounts.get(d.reason) ?? 0) + 1);
    }
    const reasonBreakdown = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}=${n}`)
      .join(', ');
    // Stat ratio : ${dropped}/${total} = ${pct}% drop (utile pour comprendre
    // si c'est normal — peu de produits sur gros catalogue — ou pathologique).
    const productPagesTotal = baseClassifications.filter(
      (c) => c.kind === 'product',
    ).length;
    const dropPct = productPagesTotal > 0
      ? Math.round(allocation.droppedProductPages.length / productPagesTotal * 100)
      : 0;
    // Limite l'affichage des pages a 20 (sinon le warning fait 500 chars)
    const pagesList = allocation.droppedProductPages.slice(0, 20).join(', ');
    const more = allocation.droppedProductPages.length > 20
      ? `, +${allocation.droppedProductPages.length - 20} autres`
      : '';
    warnings.push(
      `allocator : ${allocation.droppedProductPages.length}/${productPagesTotal} `
        + `pages produit du template drop (${dropPct}%). `
        + `Pages source : ${pagesList}${more}.`
        + (reasonBreakdown ? ` Raisons : ${reasonBreakdown}.` : ''),
    );
  }
  if (allocation.unmatched.length > 0) {
    warnings.push(
      `allocator : ${allocation.unmatched.length} produit(s) sans place dispo `
        + `dans le template (pas assez de pages produit).`,
    );
  }

  // ─── Phase descriptions PARALLELE (Claude Haiku, ~17s) ──────────────────
  // generateDescriptions ne lit que les NOMS des produits + premieres specs
  // (capturees dans le prompt SYNCHRONEMENT a la construction). Les
  // mutations ulterieures de products par normalize/format n'affectent pas
  // l'appel deja en vol. On lance ici en arriere-plan, await dans le
  // bloc TOC. Gain : ~15s sur le total (overlap avec norm+format+substitute).
  type DescResult = { ran: boolean; durationMs: number; costUsd?: number; notes: string[]; descriptions: Record<string, string> };
  const descPromise: Promise<DescResult> = (opts.enableGeminiDescriptions !== false)
    ? (async (): Promise<DescResult> => {
        try {
          const sectionMap = new Map<string, PlanProduct[]>();
          for (const a of allocation.allocations) {
            const label = (a.sectionLabel || '').trim();
            if (!label) continue;
            const arr = sectionMap.get(label) ?? [];
            arr.push(...a.products);
            sectionMap.set(label, arr);
          }
          if (sectionMap.size === 0) {
            return { ran: false, durationMs: 0, notes: ['no sections'], descriptions: {} };
          }
          const descSections = [...sectionMap.entries()].map(([label, products]) => ({ label, products }));
          // Tente Gemini en premier (gratuit + pas d'expiration auth).
          // Fallback Claude Haiku si Gemini indispo / erreur API.
          const { generateDescriptionsGemini } = await import('./gemini/descriptions');
          const gem = await generateDescriptionsGemini({
            sections: descSections,
            enabled: true,
          });
          if (gem.ran && Object.keys(gem.descriptions).length > 0) {
            return {
              ran: true,
              durationMs: gem.durationMs,
              notes: ['descriptions via Gemini Flash', ...gem.notes],
              descriptions: gem.descriptions,
            };
          }
          // Si le quota Gemini est froid (cascade complete echouee a l'instant),
          // le fallback Claude (spawn CLI lent, auth souvent expiree) plomberait
          // le temps de gen pour une tache AUXILIAIRE → on skip, rapide. Claude
          // reste utilise quand Gemini echoue pour une autre raison (quota OK).
          const { isQuotaCold } = await import('./gemini/circuitBreaker');
          if (isQuotaCold()) {
            return { ran: false, durationMs: 0, notes: ['gemini froid → skip fallback Claude (gen rapide)'], descriptions: {} };
          }
          // Fallback Claude
          return generateDescriptions({
            sections: descSections,
            workDir: opts.workDir,
            projectDir: opts.projectDir,
            claudeBin: opts.claudeBin,
            enabled: true,
          });
        } catch (err) {
          // Etape AUXILIAIRE : un echec (import KO, fallback Claude qui throw) ne
          // doit JAMAIS avorter la generation du PDF. On degrade en no-op.
          return {
            ran: false,
            durationMs: 0,
            notes: [`descriptions echec (non bloquant): ${err instanceof Error ? err.message : String(err)}`],
            descriptions: {},
          };
        }
      })()
    : Promise.resolve({ ran: false, durationMs: 0, notes: [], descriptions: {} });

  // ─── Phase 1.2 : Claude audit ────────────────────────────────────────────
  let classifications = baseClassifications;
  let forcedDrops = new Set<number>();
  let claudeAuditMs = 0;
  let claudeCorrections = 0;
  let claudeCostUsd: number | undefined;
  if (opts.enableClaudeAudit === true) {
    const audit = await claudeAudit({
      classifications: baseClassifications,
      analysis,
      allocation,
      templatesDir: workTemplatesDir,
      workDir: opts.workDir,
      projectDir: opts.projectDir,
      claudeBin: opts.claudeBin,
    });
    claudeAuditMs = audit.durationMs;
    claudeCorrections = audit.corrections.length;
    claudeCostUsd = audit.costUsd;
    claudeNotes.push(...audit.notes);
    const applied = applyAuditCorrections(baseClassifications, audit);
    classifications = applied.updated;
    forcedDrops = applied.forcedDrops;
  }

  // ─── Phase 2.5 : normalisation spec keys au style template ──────────────
  // Trigger uniquement si mismatch detecte > 50% (xlsx en langue exotique ou
  // naming custom client). Sinon skip silencieux. Mutation in-place sur les
  // products → substitutor lira les nouvelles keys.
  // On prend les keys des pages ALLOUEES en priorite (= celles qui vont
  // recevoir les nouveaux produits) pour avoir un mapping pertinent au
  // contexte. Fallback : toutes les pages produit si pas d'alloc.
  const allocatedSourcePages = new Set(allocation.allocations.map((a) => a.sourcePage));
  const templateSpecKeys: string[] = [];
  for (const c of classifications) {
    if (allocatedSourcePages.size > 0 && !allocatedSourcePages.has(c.pageNumber)) continue;
    for (const b of c.blocks) for (const s of b.specs) templateSpecKeys.push(s.key.text);
  }
  progress('normalize', 28, 'Normalisation des caractéristiques…');
  const specNorm = await normalizeSpecs({
    products: opts.products,
    templateSpecKeys,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    enabled: opts.enableSpecNormalization !== false,
  });
  claudeNotes.push(...specNorm.notes);
  if (specNorm.keysRemapped > 0) {
    warnings.push(
      `spec normalizer : ${specNorm.keysRemapped} spec key(s) remappee(s) au style template`
        + (specNorm.costUsd !== undefined ? ` (cout ~$${specNorm.costUsd.toFixed(3)})` : ''),
    );
    await fs.writeFile(workProducts, JSON.stringify(opts.products, null, 2), 'utf8').catch(() => {});
  }

  // ─── Phase 2.6 : value formatting (unites, suffixes) ────────────────────
  // Apres normalisation des keys, on uniformise les VALEURS pour matcher le
  // style template (ex "60" → "60 cm" si template utilise les unites).
  const templateValuesByKey = new Map<string, string[]>();
  for (const c of classifications) {
    if (allocatedSourcePages.size > 0 && !allocatedSourcePages.has(c.pageNumber)) continue;
    for (const b of c.blocks) {
      for (const s of b.specs) {
        const arr = templateValuesByKey.get(s.key.text) ?? [];
        for (const v of s.values) arr.push(v.text);
        templateValuesByKey.set(s.key.text, arr);
      }
    }
  }
  progress('format', 40, 'Mise en forme des valeurs…');
  const valueFmt = await formatSpecValues({
    products: opts.products,
    templateValuesByKey,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    enabled: opts.enableValueFormatting !== false,
  });
  claudeNotes.push(...valueFmt.notes);
  if (valueFmt.valuesReformatted > 0) {
    warnings.push(
      `value formatter : ${valueFmt.valuesReformatted} value(s) reformatee(s) au style template`
        + (valueFmt.costUsd !== undefined ? ` (cout ~$${valueFmt.costUsd.toFixed(3)})` : ''),
    );
    await fs.writeFile(workProducts, JSON.stringify(opts.products, null, 2), 'utf8').catch(() => {});
  }

  // ─── Phase 3 : substitute ────────────────────────────────────────────────
  progress('substitute', 55, 'Substitution des produits…');
  const substituteStart = Date.now();
  resetMissingProductImages();
  // Index : sourcePage → PageAllocation
  const allocByPage = new Map(allocation.allocations.map((a) => [a.sourcePage, a]));
  const substitutedPages = new Map<number, Operation[]>();
  // Intent-driven : on stocke les schemas + intents pour plan_v2 + boucle
  const intentSchemasBySourceEarly = new Map<number, PageSchema>();
  const intentsBySource = new Map<number, { intents: import('./intent/intent').IntentOp[] }>();
  const useIntentSubstitute = opts.enableIntentPlan !== false; // BC_test : intent par defaut
  for (const a of allocation.allocations) {
    const cls = classifications.find((c) => c.pageNumber === a.sourcePage);
    if (!cls) continue;
    // Decorations vectorielles : extraites des slots type='decoration' kind='vector'.
    const decorationVectors = cls.extracted.slots
      .filter(
        (s) => s.type === 'decoration' && (s as { kind?: string }).kind === 'vector',
      )
      .map((s) => s.bbox);
    // Spans section_banner detectes strictement via isRealSectionBannerLabel
    // (factorise depuis classify.ts ; voir docstring pour les criteres).
    const sectionBannerSpans = cls.extracted.slots
      .filter((s) => s.type === 'section_banner')
      .map((s) => (s as { label: TextSpan }).label)
      .filter((lbl) => isRealSectionBannerLabel(lbl, profile));

    // Spans ruban (vertical OU horizontal) : detecte heuristiquement.
    //  - Vertical : bbox sur bord gauche/droit + texte vertical (h > w)
    //  - Horizontal : bbox sur bord haut/bas + texte court (≤ 40 chars),
    //                 taille >= 12pt, large bande (w > 30% page width).
    //    Évite de matcher les page numbers (≤ 5 chars typique) et les titres
    //    de section (zone centrale, pas en bordure).
    const pageW = cls.extracted.page_size.width;
    const pageH = cls.extracted.page_size.height;
    const ribbonMargin = profile.ribbonMargin * 1.5;
    const HORIZONTAL_RIBBON_TOP_MARGIN = 60; // pt
    const HORIZONTAL_RIBBON_BOTTOM_MARGIN = 60;
    const HORIZONTAL_RIBBON_MIN_W_RATIO = 0.10;
    const HORIZONTAL_RIBBON_MIN_SIZE = 12;
    const HORIZONTAL_RIBBON_MAX_CHARS = 40;
    const ribbonSpans = (cls.extracted.raw_spans ?? []).filter((s) => {
      const w = s.bbox[2] - s.bbox[0];
      const h = s.bbox[3] - s.bbox[1];
      const txt = s.text.trim();
      if (txt.length < 3) return false;
      if (s.size < 8) return false;

      // Détection vertical : texte rotated (h > w), sur bord gauche/droit
      if (h > w) {
        const onLeft = s.bbox[2] < ribbonMargin;
        const onRight = s.bbox[0] > pageW - ribbonMargin;
        return onLeft || onRight;
      }

      // Détection horizontal : bandeau haut/bas avec texte court large
      if (w > h && txt.length <= HORIZONTAL_RIBBON_MAX_CHARS
          && s.size >= HORIZONTAL_RIBBON_MIN_SIZE
          && w >= pageW * HORIZONTAL_RIBBON_MIN_W_RATIO) {
        const onTop = s.bbox[3] < HORIZONTAL_RIBBON_TOP_MARGIN;
        const onBottom = s.bbox[1] > pageH - HORIZONTAL_RIBBON_BOTTOM_MARGIN;
        return onTop || onBottom;
      }
      return false;
    });
    // Dédup ribbons sur même bandeau Y : sur Catalogue C / Catalogue B les 2 spans
    // "POMPES D'ÉVACUATION" + "EAUX CLAIRES" sont consécutifs sur la même
    // ligne Y, sans X-overlap. Substituer chaque par "SANITAIRE" donne
    // "SANITAIRESANITAIRE" visible. Solution : grouper par row Y et ne
    // garder que le 1er span de chaque row.
    const dedupedRibbons = dedupRibbonsByRow(ribbonSpans, pageW, pageH);
    const ribbonSpansDedup = dedupedRibbons;
    // Famille majoritaire des produits alloues sur cette page (souvent une
    // seule valeur). Si absente : pas de substitution du ruban.
    const familyCounts = new Map<string, number>();
    for (const p of a.products) {
      const f = (p.family ?? '').trim();
      if (f) familyCounts.set(f, (familyCounts.get(f) ?? 0) + 1);
    }
    let newFamilyLabel: string | undefined;
    if (familyCounts.size > 0) {
      newFamilyLabel = [...familyCounts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    }

    // Banner section : on prefere le label issu des PRODUITS alloues a celui
    // detecte sur la page template. Garantit la coherence "banner = ce que
    // raconte la page" quand l'allocator met des produits d'une section sur
    // une page template qui en montrait une autre. Si aucun produit n'a de
    // section, fallback sur a.sectionLabel (label template).
    const sectionCounts = new Map<string, number>();
    for (const p of a.products) {
      const s = (p.section ?? '').trim();
      if (s) sectionCounts.set(s, (sectionCounts.get(s) ?? 0) + 1);
    }
    const productSectionLabel = sectionCounts.size > 0
      ? [...sectionCounts.entries()].sort((x, y) => y[1] - x[1])[0][0]
      : undefined;
    const finalSectionLabel = productSectionLabel ?? a.sectionLabel;

    // ─── Grille overflow : si N produits > N blocs template ──────────────
    // Synthese des blocs supplementaires (translation verticale du bloc
    // template ref) pour faire tenir les produits surnumeraires sur la
    // meme page. Si pas de place dispo, retourne les blocs originaux et
    // les produits surnumeraires sont drop comme avant.
    const { synthesizeOverflowBlocks } = await import('./engine/reflow/gridLayout');
    const gridRes = synthesizeOverflowBlocks({
      originalBlocks: cls.blocks,
      nProducts: a.products.length,
      pageHeight: cls.extracted.page_size.height,
    });
    const effectiveBlocks = gridRes.blocks;
    if (gridRes.gridApplied) {
      warnings.push(
        `grille overflow page ${a.sourcePage}: +${gridRes.rowsAdded} rang(s) synthetises (${a.products.length} produits sur ${cls.blocks.length} blocs tpl)`
      );
    }

    if (useIntentSubstitute) {
      // Pipeline intent-driven : genere IntentOps → resolve → Operations
      const result = intentSubstitutePage({
        page: cls.extracted,
        blocks: effectiveBlocks,
        products: a.products,
        kind: cls.kind as PageSchema['kind'],
        pageWidth: cls.extracted.page_size.width,
        pageHeight: cls.extracted.page_size.height,
        profile,
        sectionBannerSpans,
        newSectionLabel: finalSectionLabel,
        rawSpans: cls.extracted.raw_spans,
        rawImages: cls.extracted.raw_images,
        decorationVectors,
        rawPaths: cls.extracted.raw_paths,
        ribbonSpans: ribbonSpansDedup,
        newFamilyLabel,
      });
      substitutedPages.set(a.sourcePage, result.operations);
      intentSchemasBySourceEarly.set(a.sourcePage, result.schema);
      intentsBySource.set(a.sourcePage, { intents: result.intents });
    } else {
      // Fallback : substitutor legacy (procedural)
      const ops = substitutePage(effectiveBlocks, a.products, {
        pageWidth: cls.extracted.page_size.width,
        pageHeight: cls.extracted.page_size.height,
        profile,
        rawSpans: cls.extracted.raw_spans,
        rawImages: cls.extracted.raw_images,
        decorationVectors,
        rawPaths: cls.extracted.raw_paths,
        sectionBannerSpans,
        newSectionLabel: finalSectionLabel,
        ribbonSpans: ribbonSpansDedup,
        newFamilyLabel,
      });
      substitutedPages.set(a.sourcePage, ops);
    }
  }
  const substituteMs = Date.now() - substituteStart;
  // Warning produits sans image (assets.zip incomplet)
  const missingImgs = getMissingProductImages();
  if (missingImgs.length > 0) {
    const names = missingImgs.slice(0, 5).map((m) => `"${m.productName}"`).join(', ');
    const more = missingImgs.length > 5 ? `, +${missingImgs.length - 5} autres` : '';
    warnings.push(
      `${missingImgs.length} produit(s) sans image source : ${names}${more}. `
        + `Verifier que assets.zip contient bien les fichiers.`,
    );
  }

  // ─── Assemblage Plan (drop final + renum) ────────────────────────────────

  // Zone produit = entre la 1re et la derniere page kind='product' (ou
  // 'intercalaire' qui annonce une section). Dans cette zone : tout ce
  // qui n'est PAS substitue est drope (cahier technique, photos lifestyle
  // intercalees, pages tech, etc.).
  const productZoneIdxs: number[] = [];
  for (let i = 0; i < classifications.length; i++) {
    const c = classifications[i];
    if (c.kind === 'product' || c.kind === 'intercalaire' || c.kind === 'toc') {
      productZoneIdxs.push(i);
    }
  }
  const firstProductZoneIdx = productZoneIdxs[0] ?? classifications.length;
  const lastProductZoneIdx =
    productZoneIdxs[productZoneIdxs.length - 1] ?? -1;

  // Dedup intro/outro : les catalogues ont souvent des pages d'outro qui
  // dupliquent visuellement des pages d'intro (verso recto-verso imprimerie).
  // Ex Catalogue A : page 1 (Catalogue B + RSE) et page 186 sont identiques. On hash
  // les pages intro (sauf cover) puis on drop les pages non-intro qui
  // matchent. La cover (page 0) est exclue car la 4eme de couverture lui
  // ressemble legitimement.
  const introHashes = new Set<string>();
  for (let i = 1; i < firstProductZoneIdx && i < classifications.length; i++) {
    introHashes.add(pageContentHash(classifications[i].extracted));
  }

  const pagePlans: PagePlan[] = [];
  for (let i = 0; i < classifications.length; i++) {
    const cls = classifications[i];
    const forced = forcedDrops.has(cls.pageNumber);
    const inProductZone = i >= firstProductZoneIdx && i <= lastProductZoneIdx;

    // KEEP : page produit substituee
    if (substitutedPages.has(cls.pageNumber)) {
      pagePlans.push({
        source_page: cls.pageNumber,
        page_number: null,
        render: { mode: 'operations', operations: substitutedPages.get(cls.pageNumber)! },
      });
      continue;
    }
    // DROP : tout dans la zone produit qui n'est pas substitue
    // (cahier technique, photos lifestyle, sommaires, glossaires, etc.)
    if (inProductZone) continue;
    // DROP : forced par Claude (hors zone produit)
    if (forced) continue;
    // DROP : glossaire / cahier tech (peuvent etre hors zone aussi)
    if (cls.kind === 'glossaire' || cls.kind === 'tech') continue;
    // DROP : toc / intercalaire hors zone produit (rare)
    if (cls.kind === 'toc' || cls.kind === 'intercalaire') continue;
    // DROP : page outro qui duplique une page d'intro (= verso recto-verso
    // imprimerie). Evite d'avoir 2x la meme page Catalogue B/RSE.
    if (i > lastProductZoneIdx && introHashes.has(pageContentHash(cls.extracted))) {
      continue;
    }
    // KEEP : identite marque (cover, RSE, NF, mentions, 4eme de couv, etc.)
    pagePlans.push({
      source_page: cls.pageNumber,
      page_number: null,
      render: { mode: 'keep_raw' },
    });
  }

  // ─── Intercalaires de section (heuristique pure) ─────────────────────────
  // Réanime UNE page intercalaire "pure" (= peu de spans, pas de fiche
  // produit dedans) avant chaque groupe de pages produit d'une section.
  // Substitue le grand titre par le label de section. Pas d'appel Claude
  // (gardé simple pour le V2 procédural).
  let intercalairesInserted = 0;
  {
    // Pattern de ref produit pour detecter les pages "fiche produit deguisee"
    // (= ressemblent a un intercalaire mais contiennent en realite des refs).
    // Match :
    //   - 6-8 chiffres standalone ("002236" Catalogue B/Catalogue C, "1234567",
    //     "12345678")
    //   - prefixe optionnel 4-7 chiffres + espace (codes ERP grossistes : ex
    //     "304740 1234567" du catalogue de reference Catalogue A, mais
    //     compatible avec n'importe quel grossiste qui prefixe ses refs).
    //   - exclu : annees (1900-2099) toutes seules — voir filtre suspect ci-bas.
    const REF_RE = /\b(?:\d{4,7}\s+)?\d{6,8}\b/;
    const YEAR_RE = /^(?:19|20)\d{2}$/;
    // Dates concatenees JJMMAAAA (8 chiffres respectant 01-31/01-12/19xx-20xx).
    // Filtre essentiel : sans cela "28062024" passe REF_RE et fausse la detection
    // intercalaire (page legale "Loi du 28/06/2024" → suspect → identity a tort).
    const DATE_RE = /\b(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}\b/;
    const SPEC_KW_RE = /\b(MATIERE|MATIÈRE|LONGUEUR|DIAMETRE|DIAMÈTRE|GARANTIE|DURÉE|SUPPORT|CONDITIONNEMENT|ACCESSOIRES|FOURNIS|FINITION|RACCORD|DEBIT|DÉBIT)\b/i;
    const lastPageIdx = classifications.length - 1;
    // Zones "identité catalogue" : début (cover + intros marque + RSE +
    // mission) et fin (notes + mentions légales + index + 4ème de couv).
    // Conventionnellement les 5 premières et 5 dernières pages d'un
    // catalogue commercial. Toute page intercalaire détectée dans ces
    // zones est exclue : on ne réécrit JAMAIS une intro de marque avec
    // un label de section. Sur Catalogue A : pages 0-4 déjà classées identity →
    // no-op. Sur Catalogue C : pages 1-3 (Catalogue B / Catalogue F / NOS MARQUES /
    // NOTRE VISIBILITÉ) préservées.
    // Zones adaptatives selon taille du catalogue (cf computeIntercalaireGuardZones)
    const { intro: INTRO_ZONE, outro: OUTRO_ZONE } =
      computeIntercalaireGuardZones(classifications.length);
    // Plafond de spans texte pour un intercalaire "pur" : un VRAI intercalaire
    // de section = grand titre + sous-titre + deco (~5-15 spans). Au-dela, c'est
    // une page de CONTENU THEMATIQUE (page pedagogique "comment choisir une
    // surpression", schema + legendes) qu'il ne faut PAS reanimer : substituer
    // son bandeau par un autre label de section cree une incoherence
    // contenu/titre (bug observe Catalogue C : page surpression a 44 spans, bandeau
    // reecrit en "EAUX CLAIRES"). Mieux vaut PAS d'intercalaire qu'un faux.
    const MAX_INTERCALAIRE_TEXT_SPANS = 30;
    const isPureIntercalaire = (c: typeof classifications[0]): boolean => {
      if (c.kind !== 'intercalaire') return false;
      if (c.pageNumber < INTRO_ZONE) return false;
      if (c.pageNumber > lastPageIdx - OUTRO_ZONE) return false;
      const spans = c.extracted.raw_spans ?? [];
      // Garde anti-page-thematique : trop de texte = page de contenu, pas un
      // intercalaire reutilisable.
      const textSpans = spans.filter((s) => (s.text ?? '').trim().length > 1);
      if (textSpans.length > MAX_INTERCALAIRE_TEXT_SPANS) return false;
      // Pages produit déguisées : on les filtre par specs/refs.
      let suspect = 0;
      for (const s of spans) {
        const t = s.text.trim();
        // Filtre annees pures (1900-2099) : pas une ref produit.
        if (YEAR_RE.test(t)) continue;
        // Filtre dates JJMMAAAA : pas une ref produit.
        if (DATE_RE.test(t)) continue;
        if (REF_RE.test(t) || SPEC_KW_RE.test(t)) suspect++;
        if (suspect >= 2) return false;
      }
      return true;
    };
    const candidates = classifications.filter(isPureIntercalaire);

    if (candidates.length > 0) {
      // Liste les sections dans l'ordre d'apparition produit
      const allocBySource = new Map(
        allocation.allocations.map((a) => [a.sourcePage, a.sectionLabel]),
      );
      const sectionInsertPoints: { label: string; idx: number }[] = [];
      const seenSections = new Set<string>();
      for (let i = 0; i < pagePlans.length; i++) {
        const label = allocBySource.get(pagePlans[i].source_page);
        if (!label || seenSections.has(label)) continue;
        seenSections.add(label);
        sectionInsertPoints.push({ label, idx: i });
      }
      // Insertion de la FIN vers le DEBUT pour preserver les indices
      const sortedSections = [...sectionInsertPoints].sort((a, b) => b.idx - a.idx);
      const used = new Set<number>();
      for (const section of sortedSections) {
        const cand = candidates.find((c) => !used.has(c.pageNumber));
        if (!cand) break;
        used.add(cand.pageNumber);
        // Identifie le grand titre : span avec font_size max dans la moitie
        // haute, hors zone footer/ribbon.
        const pageH = cand.extracted.page_size.height;
        const pageW = cand.extracted.page_size.width;
        const candidates_spans = (cand.extracted.raw_spans ?? []).filter((s) => {
          if (s.text.trim().length < 3) return false;
          if (s.bbox[3] > pageH * 0.7) return false; // bas = footer
          if (s.bbox[0] > pageW * 0.85) return false; // bord droit = ribbon
          const w = s.bbox[2] - s.bbox[0];
          const h = s.bbox[3] - s.bbox[1];
          if (h > w * 1.5) return false; // vertical
          return true;
        });
        if (candidates_spans.length === 0) continue;
        const titleSpan = [...candidates_spans].sort((a, b) => b.size - a.size)[0];
        // Casse template
        const tplText = titleSpan.text.trim();
        let styled = section.label;
        const hasUpper = /[A-ZÀ-ſ]/.test(tplText);
        const hasLower = /[a-zà-ſ]/.test(tplText);
        if (hasUpper && !hasLower) styled = section.label.toUpperCase();
        else if (hasLower && !hasUpper) styled = section.label.toLowerCase();
        // Erase grand titre + insert nouveau label
        const ops: Operation[] = [];
        ops.push({
          op: 'erase_rect',
          bbox: [titleSpan.bbox[0] - 3, titleSpan.bbox[1] - 3, Math.min(pageW * 0.95, titleSpan.bbox[2] + Math.max(200, styled.length * titleSpan.size * 0.65)), titleSpan.bbox[3] + 3],
        });
        ops.push({
          op: 'insert_text',
          bbox: [titleSpan.bbox[0], titleSpan.bbox[1], pageW * 0.95, titleSpan.bbox[3]],
          text: styled,
          font: titleSpan.font,
          size: titleSpan.size,
          color: titleSpan.color,
        });
        pagePlans.splice(section.idx, 0, {
          source_page: cand.pageNumber,
          page_number: null,
          render: { mode: 'operations', operations: ops },
        });
        intercalairesInserted++;
      }
      if (intercalairesInserted > 0) {
        warnings.push(
          `intercalaires : ${intercalairesInserted} page(s) section reanimee(s) (heuristique)`,
        );
      }
    }
  }

  // ─── Sommaire reutilise du template ─────────────────────────────────────
  // Strategie en 2 passes pour eviter le bug "page_number TOC pointe faux"
  // si la renumeration finale diverge des indices anticipes :
  //   PASS 1 (ici) : selectionne la page TOC candidate + insere un PagePlan
  //                  placeholder (ops vides). Lance Claude descriptions.
  //   PASS 2 (apres la renumerotation principale) : construit les VRAIES ops
  //                  TOC avec les page_number reels post-renum, puis remplace
  //                  les ops du placeholder.
  // Si Pass 2 echoue (aucune entry), on retire le placeholder + re-renumerote.
  let tocSourcePage: number | null = null;
  let tocEntriesWritten = 0;
  let tocPlaceholder: PagePlan | null = null;
  /** Tous les placeholders TOC (1 ou N si multi-pages sommaire). */
  let tocPlaceholders: PagePlan[] = [];
  let tocDescriptions: Record<string, string> = {};
  // On AWAIT TOUJOURS descPromise (meme si TOC off) : evite une floating promise
  // non geree ET garantit que la cascade descriptions a fini AVANT le bloc audit
  // — le court-circuit quota-froid en depend (descriptions epuise le quota →
  // markQuotaCold → l'audit se court-circuite). Le resultat ne sert au TOC que
  // si enableTemplateToc.
  const descResult = await descPromise;
  claudeNotes.push(...descResult.notes);
  if (opts.enableTemplateToc !== false) {
    progress('descriptions', 62, 'Rédaction des descriptions (Claude)…');
    tocDescriptions = descResult.descriptions;
    if (Object.keys(tocDescriptions).length > 0) {
      warnings.push(
        `descriptions marketing : ${Object.keys(tocDescriptions).length} section(s) generee(s)`
          + (descResult.costUsd !== undefined ? ` (cout ~$${descResult.costUsd.toFixed(3)})` : ''),
      );
    } else if (opts.enableGeminiDescriptions !== false) {
      // Descriptions DEMANDÉES mais AUCUNE produite → on le signale explicitement.
      // Sinon le sommaire perd ses chapeaux sans aucune explication (cause typique :
      // quota Gemini journalier epuise / cascade froide → reessayer plus tard).
      const why = descResult.notes.find(
        (n) => /froid|quota|429|erreur|error|absente|echec|indispo/i.test(n),
      );
      warnings.push(
        'descriptions marketing : aucune generee (sommaire sans chapeaux) — '
          + (why ?? 'Gemini indisponible (quota/erreur), reessayer plus tard'),
      );
    }

    // PASS 1 : pick TOC source page via build "dry" avec page_number=0.
    // Le but ici n'est pas d'avoir les bonnes ops mais de savoir si une
    // page TOC valide existe + recuperer son source_page.
    progress('toc', 70, 'Adaptation du sommaire…');
    const dryPlans = pagePlans.map((pp) => ({ source_page: pp.source_page, page_number: 0 }));
    const tocDry = buildTocFromTemplate(
      classifications,
      allocation.allocations,
      dryPlans,
      tocDescriptions,
    );
    if (tocDry.sourcePage !== null && tocDry.entriesWritten > 0) {
      const allocSourcePages = new Set(allocation.allocations.map((a) => a.sourcePage));
      const firstProductIdx = pagePlans.findIndex((pp) => allocSourcePages.has(pp.source_page));
      const insertAt = firstProductIdx === -1 ? pagePlans.length : firstProductIdx;
      // Multi-pages : on insère autant de placeholders que tocDry.pages.length.
      // Tous pointent vers la meme sourcePage tpl (= meme deco). Les ops
      // sont injectées en PASS 2 quand on connaît les pageNumbers reels.
      const nPages = Math.max(1, tocDry.pages.length);
      tocPlaceholders = [];
      for (let k = 0; k < nPages; k++) {
        const placeholder: PagePlan = {
          source_page: tocDry.sourcePage,
          page_number: null,
          render: { mode: 'operations', operations: [] },
        };
        tocPlaceholders.push(placeholder);
        pagePlans.splice(insertAt + k, 0, placeholder);
      }
      // Backward compat : tocPlaceholder = la 1ère page sommaire.
      tocPlaceholder = tocPlaceholders[0];
    }
  }

  // ─── Tri des pages produit par hiérarchie ────────────────────────────
  // Aligne l'ordre des pages produit avec le sommaire : family > subFamily >
  // section, puis sourcePage en tiebreaker. Les pages NON-produit
  // (cover, intros, sommaire, intercalaires) gardent leur position. On
  // permute uniquement les pages substituées entre elles, à leurs slots.
  {
    const allocBySource = new Map(allocation.allocations.map((a) => [a.sourcePage, a]));
    // Ordres d'apparition (= ordre du sommaire) pour family et sfamille
    const familyOrder = new Map<string, number>();
    const subFamilyOrder = new Map<string, number>();
    let famIdx = 0;
    let subIdx = 0;
    for (const a of allocation.allocations) {
      const fam = majorityField(a.products, 'family');
      const sfam = majorityField(a.products, 'subFamily');
      if (fam && !familyOrder.has(fam)) familyOrder.set(fam, famIdx++);
      const key = `${fam}::${sfam}`;
      if (!subFamilyOrder.has(key)) subFamilyOrder.set(key, subIdx++);
    }

    // Collecte les indices + sortKey des pages produit
    interface ProductSlot { idx: number; plan: PagePlan; sortKey: [number, number, string, number] }
    const productSlots: ProductSlot[] = [];
    for (let i = 0; i < pagePlans.length; i++) {
      const sp = pagePlans[i].source_page;
      const alloc = allocBySource.get(sp);
      if (!alloc) continue;
      const fam = majorityField(alloc.products, 'family');
      const sfam = majorityField(alloc.products, 'subFamily');
      const fOrd = familyOrder.get(fam) ?? Number.MAX_SAFE_INTEGER;
      const sOrd = subFamilyOrder.get(`${fam}::${sfam}`) ?? Number.MAX_SAFE_INTEGER;
      productSlots.push({
        idx: i,
        plan: pagePlans[i],
        sortKey: [fOrd, sOrd, alloc.sectionLabel || '', sp],
      });
    }

    // Tri par sortKey
    const sortedPlans = [...productSlots].sort((a, b) => {
      if (a.sortKey[0] !== b.sortKey[0]) return a.sortKey[0] - b.sortKey[0];
      if (a.sortKey[1] !== b.sortKey[1]) return a.sortKey[1] - b.sortKey[1];
      const sc = a.sortKey[2].localeCompare(b.sortKey[2]);
      if (sc !== 0) return sc;
      return a.sortKey[3] - b.sortKey[3];
    });

    // Réassigne dans les slots d'origine
    for (let k = 0; k < productSlots.length; k++) {
      pagePlans[productSlots[k].idx] = sortedPlans[k].plan;
    }
  }

  // Renumerotation : position 1-based dans le PDF final. Le compteur `i + 1`
  // avance pour CHAQUE page (même celles sans footer numéroté, ex couverture)
  // → l'ordre reste juste pour numéroter les autres pages et le sommaire.
  //
  // On renumérote TOUTES les pages qui ont un slot page_number (footer numéroté
  // d'origine), y compris les pages identité keep_raw. Le numéro est réécrit
  // dans la COULEUR D'ORIGINE du template (lbl.color : blanc sur photo sombre,
  // sombre sinon).
  //
  // Le seul piège était le bloc blanc de l'erase :
  //   - page 'operations' (sommaire, produit, page relocalisée, fond clair) :
  //     l'ancien numéro template diffère souvent du nouveau (ex "104" → "6"),
  //     il faut donc un erase blanc pour le couvrir. Invisible sur fond clair.
  //   - page 'keep_raw' (identité, fond photo) : un erase blanc ferait un bloc
  //     disgracieux (et masquait le chiffre blanc). On N'EFFACE PAS : on réécrit
  //     le numéro par-dessus dans sa couleur d'origine. Ces pages ne sont pas
  //     relocalisées (ancien numéro == nouveau) → l'écrasement est propre.
  // Jamais de remove_text_in_bbox (corrompait les logos vectoriels NF lors du
  // GenerateContent) ; insert_text + GenerateContent sont sûrs (logos intacts).
  for (let i = 0; i < pagePlans.length; i++) {
    const newNum = i + 1;
    pagePlans[i].page_number = newNum;
    const plan = pagePlans[i];
    const cls = classifications.find((c) => c.pageNumber === plan.source_page);
    if (!cls) continue;
    const pageNumberSlots = cls.extracted.slots.filter((s) => s.type === 'page_number');
    if (pageNumberSlots.length === 0) continue;
    const ops: Operation[] =
      plan.render.mode === 'operations' ? plan.render.operations : [];
    const opsBefore = ops.length;
    for (const slot of pageNumberSlots) {
      const lbl = (slot as { label: TextSpan }).label;
      const numText = String(newNum);
      // Comment couvrir l'ancien numéro template (≠ nouveau, ex "1" → "3") :
      //   - numéro CLAIR (blanc) ⟹ footer sur fond SOMBRE (photo). Un erase
      //     blanc ferait un bloc voyant → on SUPPRIME l'objet TEXT à la place.
      //     Ces pages sombres n'ont pas les logos vectoriels type "norme NF",
      //     donc le remove_text ne les corrompt pas.
      //   - numéro FONCÉ ⟹ footer sur fond CLAIR. erase blanc invisible ; on
      //     l'utilise (et on évite remove_text qui corromprait les logos NF
      //     en transparency-group des pages claires).
      const removeOldText = isLightColor(lbl.color);
      // Page à fond photo (identité, intercalaire) : si on efface en blanc
      // (numéro foncé sur photo CLAIRE), on échantillonne la teinte du fond
      // (sample_bg) au lieu d'un blanc franc → pas de petit bloc blanc visible.
      const photoBg = cls.kind === 'identity' || cls.kind === 'intercalaire';
      // Compensation baseline : render.cpp applyOpInsertTextInsert calcule
      // `baseline_pdfium = pageH - y1 + INSERT_TEXT_BASELINE_OFFSET_PT`.
      // Pour avoir la baseline EXACTE du span template, on compense ici.
      const insertY1 = lbl.bbox[3] + INSERT_TEXT_BASELINE_OFFSET_PT;
      // X-start : meme que le span template (= aligne gauche apres le "/").
      const xStart = lbl.bbox[0];
      // Largeur estimee du nouveau num pour l'erase (coef chiffres
      // tabulaires = TEXT_WIDTH_COEFS.digits ; ~0.6).
      const numWidth = numText.length * lbl.size * TEXT_WIDTH_COEFS.digits;
      // Clamp anti-débord : certains footers (ex société Catalogue A, alignés à droite)
      // ont leur slot numéro collé au bord droit → le chiffre sortait de la page
      // (coupé). On décale à gauche juste assez pour qu'il reste entier.
      const pageW = cls.extracted.page_size?.width ?? 0;
      const RIGHT_MARGIN = 3;
      let insX = xStart;
      if (pageW > 0 && insX + numWidth > pageW - RIGHT_MARGIN) {
        insX = Math.max(2, pageW - RIGHT_MARGIN - numWidth);
      }
      const insXEnd = insX + numWidth + 2;
      if (removeOldText) {
        // Supprime physiquement l'ancien numéro (bbox serrée sur le seul
        // chiffre ; le running header voisin n'est pas entièrement inscrit donc
        // préservé), puis insert du nouveau dans la couleur d'origine, no_erase.
        ops.push({
          op: 'remove_text_in_bbox',
          bbox: [lbl.bbox[0] - 0.5, lbl.bbox[1] - 0.5, lbl.bbox[2] + 0.5, lbl.bbox[3] + 0.5],
        });
      } else {
        // Fond clair : erase (couvre l'ancien num, souvent plus large). Blanc
        // sur page produit/sommaire (fond blanc) ; teinte échantillonnée sur
        // page identité (fond photo clair, ex page NF) pour éviter un bloc.
        const eraseX0 = Math.min(xStart, insX);
        const eraseX1 = Math.min(Math.max(lbl.bbox[2], insXEnd) + 1, pageW > 0 ? pageW : Infinity);
        ops.push({
          op: 'erase_rect',
          bbox: [eraseX0, lbl.bbox[1] - 2, eraseX1, lbl.bbox[3] + 2],
          ...(photoBg ? { sample_bg: true } : {}),
        });
      }
      ops.push({
        op: 'insert_text',
        bbox: [insX, lbl.bbox[1], insXEnd, insertY1],
        text: numText,
        font: lbl.font,
        size: lbl.size,
        color: lbl.color,
        // no_erase : on a déjà géré la couverture de l'ancien num (remove_text
        // sur photo, erase blanc sur fond clair) ; on coupe l'auto-erase blanc
        // interne de insert_text (render.cpp) qui reposerait un bloc.
        no_erase: true,
      });
    }
    // On bascule en mode 'operations' dès qu'on a ajouté un insert (le numéro
    // doit être (ré)écrit). insert_text + GenerateContent ne corrompent pas les
    // logos (seul remove_text_in_bbox le faisait).
    if (ops.length > opsBefore) {
      plan.render = { mode: 'operations', operations: ops };
    }
  }

  // PASS 2 TOC : maintenant que les page_number sont fixes, on (re)construit
  // les ops du sommaire avec les VRAIS numeros et on remplace les ops du
  // placeholder inséré en PASS 1. Si le build retombe vide, on retire la
  // page placeholder + on re-renumerote.
  if (tocPlaceholder) {
    const placeholderSet = new Set(tocPlaceholders);
    const realPagePlans = pagePlans
      .filter((pp) => !placeholderSet.has(pp))
      .map((pp) => ({ source_page: pp.source_page, page_number: pp.page_number ?? 0 }));
    // Calcul du cahier technique : produits avec schema_path ET dans
    // allocations (= effectivement substitues). Sert a pre-allouer l'entry
    // "Cahier technique" dans le sommaire avec son numero de page final.
    // Normalisation tolerante pour eviter un tri trop strict : casse +
    // whitespace + accents. Sinon "AQUASTAR  900" rate "AQUASTAR 900".
    const normName = (s: string): string => s
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const allocatedNamesSet = new Set<string>();
    for (const a of allocation.allocations) {
      for (const prod of a.products) {
        const n = normName(prod.name || '');
        if (n) allocatedNamesSet.add(n);
      }
    }
    const cahierProductCount = opts.products.filter((p) => {
      const sp = (p as { schema_path?: string }).schema_path;
      const name = normName(p.name || '');
      return typeof sp === 'string' && sp.length > 0 && allocatedNamesSet.has(name);
    }).length;
    const CAHIER_PER_PAGE = 6;
    const cahierPagesCount = Math.ceil(cahierProductCount / CAHIER_PER_PAGE);
    // Le cahier sera insere AVANT la derniere page (4e de couv). Au moment du
    // PASS 2 TOC, pagePlans.length = nb total de pages SANS le cahier. La 4e
    // couv est a page_number = pagePlans.length. Le cahier prendra les pages
    // pagePlans.length a pagePlans.length + cahierPagesCount - 1.
    const cahierFirstPageNumber = cahierPagesCount > 0 ? pagePlans.length : 0;
    const extraEntries = cahierPagesCount > 0
      ? [{ label: 'Cahier technique', pageNumber: cahierFirstPageNumber }]
      : [];
    const tocResult = buildTocFromTemplate(
      classifications,
      allocation.allocations,
      realPagePlans,
      tocDescriptions,
      extraEntries,
    );
    if (tocResult.sourcePage !== null && tocResult.entriesWritten > 0) {
      // Multi-pages : il peut y avoir + ou - de pages que prévu en PASS 1
      // (selon yStep recalculé avec vrais pageNumbers). On ajuste : si nb
      // de pages différent du nb de placeholders, on en ajoute/retire.
      const realPages = tocResult.pages;
      // Synchronise le nombre de placeholders avec realPages.length
      while (tocPlaceholders.length < realPages.length) {
        // Manque des placeholders → on en insère après le dernier
        const lastIdx = pagePlans.indexOf(tocPlaceholders[tocPlaceholders.length - 1]);
        const insertIdx = lastIdx >= 0 ? lastIdx + 1 : pagePlans.length;
        const extra: PagePlan = {
          source_page: tocResult.sourcePage,
          page_number: null,
          render: { mode: 'operations', operations: [] },
        };
        pagePlans.splice(insertIdx, 0, extra);
        tocPlaceholders.push(extra);
      }
      while (tocPlaceholders.length > realPages.length) {
        // Trop de placeholders → on retire l'excès depuis la fin
        const extra = tocPlaceholders.pop()!;
        const idx = pagePlans.indexOf(extra);
        if (idx >= 0) pagePlans.splice(idx, 1);
      }
      // Affecte les ops à chaque placeholder. Pour chacun, MERGE avec les
      // ops de renumérotation déjà présentes (page number bottom).
      for (let i = 0; i < tocPlaceholders.length; i++) {
        const ph = tocPlaceholders[i];
        const pageOps = realPages[i]?.ops ?? [];
        const renumOps = ph.render.mode === 'operations' ? ph.render.operations : [];
        ph.render = { mode: 'operations', operations: [...pageOps, ...renumOps] };
      }
      tocSourcePage = tocResult.sourcePage;
      tocEntriesWritten = tocResult.entriesWritten;
      warnings.push(
        `sommaire : ${tocPlaceholders.length} page(s) sommaire, ${tocResult.entriesWritten}/${tocResult.entriesErased} entries reecrites (template page ${tocResult.sourcePage})`,
      );
    } else {
      // Echec rebuild : on retire TOUS les placeholders et on re-renumerote.
      for (const ph of tocPlaceholders) {
        const idx = pagePlans.indexOf(ph);
        if (idx >= 0) pagePlans.splice(idx, 1);
      }
      for (let i = 0; i < pagePlans.length; i++) {
        pagePlans[i].page_number = i + 1;
      }
    }
  }

  // Assemblage final
  const plan: Plan = {
    version: '1',
    pages: pagePlans,
    stats: {
      products_used: opts.products.length - allocation.unmatched.length,
      products_remaining: allocation.unmatched.length,
      pages_kept: pagePlans.length,
      pages_deleted: pages.length - pagePlans.length,
    },
  };
  try {
    await fs.writeFile(workPlan, JSON.stringify(plan, null, 2), 'utf8');
  } catch (e) {
    return failResult({
      msg: `write plan.json failed: ${(e as Error).message}`,
      extractMs,
      classifyMs,
      allocateMs,
      claudeAuditMs,
      substituteMs,
      renderMs: 0,
      profileSource: profile.source,
      claudeCorrections,
      warnings,
      notes: claudeNotes,
    });
  }

  // ─── IntentPlan (approche BC) ─────────────────────────────────────────────
  // Si intent-driven substitute est active, on reutilise les schemas et intents
  // deja construits pendant la phase substitute. Sinon on les construit ici.
  const intentSchemasBySource = new Map<number, PageSchema>();
  if (useIntentSubstitute) {
    // Schemas deja construits pendant la phase substitute intent-driven
    for (const [src, schema] of intentSchemasBySourceEarly) {
      intentSchemasBySource.set(src, schema);
    }
    // Persiste plan_v2.json avec les intents reels
    const intentPages = [...intentsBySource.entries()].map(([src, data]) => ({
      sourcePage: src,
      intents: data.intents,
    }));
    const totalIntentsGenerated = intentPages.reduce((s, p) => s + p.intents.length, 0);
    const workIntentPlan = path.join(opts.workDir, 'plan_v2.json');
    await fs.writeFile(workIntentPlan, JSON.stringify({
      version: '2',
      mode: 'intent-driven',
      pages: intentPages,
      schemas: [...intentSchemasBySource.values()],
    }, null, 2), 'utf8').catch(() => {});
    warnings.push(
      `intent-driven : ${totalIntentsGenerated} intents generes, ${intentSchemasBySource.size} schemas (ops via substitutor)`,
    );
  } else if (opts.enableIntentPlan === true || opts.enableIntentLoop === true) {
    // Fallback : construction des schemas depuis les classifications
    const intentPlan = buildIntentPlanV1(allocation.allocations, classifications);
    for (const s of intentPlan.schemas) {
      if (!intentSchemasBySource.has(s.sourcePage)) intentSchemasBySource.set(s.sourcePage, s);
    }
    if (opts.enableIntentPlan === true) {
      const workIntentPlan = path.join(opts.workDir, 'plan_v2.json');
      await fs.writeFile(workIntentPlan, JSON.stringify(intentPlan, null, 2), 'utf8').catch(() => {});
      warnings.push(
        `intent : plan_v2.json informationnel ecrit (${intentPlan.schemas.length} schemas de page)`,
      );
    }
  }

  // ─── Render C++ ──────────────────────────────────────────────────────────
  progress('render', 75, 'Rendu du PDF…');
  const renderStart = Date.now();
  const renderRes = await runBinary({
    bin: binary,
    args: [
      'render',
      workPlan,
      workTemplatePdf,
      workTemplatesDir,
      opts.assetsDir,
      opts.outPdfPath,
    ],
    timeoutMs: RENDER_TIMEOUT_MS,
    stderrLogPath: path.join(opts.workDir, 'render.stderr.log'),
  });
  const renderMs = Date.now() - renderStart;
  if (!renderRes.ok) {
    return failResult({
      msg: `render failed (exit ${renderRes.exitCode}): ${renderRes.stderr.slice(0, 500)}`,
      extractMs,
      classifyMs,
      allocateMs,
      claudeAuditMs,
      substituteMs,
      renderMs,
      profileSource: profile.source,
      claudeCorrections,
      warnings,
      notes: claudeNotes,
    });
  }
  // Filtre les lignes informatives du binaire (pas des warnings).
  // ATTENTION : la liste BENIGN_STDERR_PREFIXES est COUPLEE aux prints
  // C++ de extract.cpp/render.cpp. Si tu changes un message C++, mets a
  // jour ici aussi sinon le filtre laisse passer du bruit comme warning.
  // Compatibilite : on accepte les nouvelles formes en ajoutant des entrees,
  // pas en supprimant les anciennes.
  const BENIGN_STDERR_PREFIXES = [
    'Pages:',           // extract.cpp "Pages: N"
    'Extraction OK',    // extract.cpp "Extraction OK: N fichiers..."
    'Extracted',        // render.cpp "Extracted pages charges: N"
  ];
  for (const line of renderRes.stderr.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (BENIGN_STDERR_PREFIXES.some((p) => t.startsWith(p))) continue;
    warnings.push('render: ' + t);
  }

  // ─── Boucle Claude → IntentOps → re-render (approche BC) ────────────────
  // Apres le 1er render, on demande a Claude vision des corrections (IntentOps)
  // sur un echantillon de pages substituees, on les resout en Operations et
  // on re-render. Iteratif (max 2 par defaut), stop des qu'une passe ne
  // produit plus d'intent.
  let intentLoopMs: number | undefined;
  let intentLoopCostUsd: number | undefined;
  let intentLoopIterations: number | undefined;
  let intentLoopIntents: number | undefined;
  let intentLoopOpsApplied: number | undefined;
  if (opts.enableIntentLoop === true && intentSchemasBySource.size > 0) {
    progress('intent_loop', 80, 'Boucle Claude → IntentOps…');
    const allocBySource = new Map(allocation.allocations.map((a) => [a.sourcePage, a]));
    const loopRes = await runIntentLoop({
      outPdfPath: opts.outPdfPath,
      plan,
      schemas: intentSchemasBySource,
      allocations: allocBySource,
      workDir: opts.workDir,
      projectDir: opts.projectDir,
      claudeBin: opts.claudeBin,
      samplePages: opts.intentLoopSampleSize,
      maxIterations: opts.intentLoopMaxIterations,
      rerender: async (planPath) => {
        const rr = await runBinary({
          bin: binary,
          args: ['render', planPath, workTemplatePdf, workTemplatesDir, opts.assetsDir, opts.outPdfPath],
          timeoutMs: RENDER_TIMEOUT_MS,
          stderrLogPath: path.join(opts.workDir, 'render-intent.stderr.log'),
        });
        return { ok: rr.ok, stderr: rr.stderr };
      },
    });
    intentLoopMs = loopRes.durationMs;
    intentLoopCostUsd = loopRes.costUsd;
    intentLoopIterations = loopRes.iterations;
    intentLoopIntents = loopRes.totalIntents;
    intentLoopOpsApplied = loopRes.totalOps;
    claudeNotes.push(...loopRes.notes);
    warnings.push(
      `intent loop : ${loopRes.iterations} iter, ${loopRes.totalIntents} intents, ${loopRes.totalOps} ops, ${loopRes.totalUnresolved} unresolved, $${(loopRes.costUsd ?? 0).toFixed(4)}`,
    );
  }

  // ─── Cahier technique : grille 2x3 de schemas avant derniere page ────────
  // Pour chaque produit AVEC schema_path matche ET effectivement alloue
  // dans le PDF (= present dans une page produit substituee), on ajoute son
  // schema dans une grille 6/page inseree JUSTE AVANT la derniere page (4e
  // de couv). Une entree est aussi ajoutee dans le sommaire.
  try {
    // Set des produits effectivement utilises dans le PDF final.
    // Normalisation tolerante (NFKD + diacritics + ws + lowercase) pour
    // eviter un tri trop strict cote cahier technique (cas "AQUASTAR  900"
    // vs "AQUASTAR 900", accents/casse heterogenes XLSX vs allocations).
    const normName = (s: string): string => s
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const allocatedNames = new Set<string>();
    for (const a of allocation.allocations) {
      for (const prod of a.products) {
        const n = normName(prod.name || '');
        if (n) allocatedNames.add(n);
      }
    }
    // Numero de page (1-based) du sommaire dans le PDF final, depuis pagePlans
    let tocFinalPageNumber: number | undefined;
    if (tocSourcePage != null) {
      const tocPlan = pagePlans.find((pp) => pp.source_page === tocSourcePage);
      if (tocPlan && typeof tocPlan.page_number === 'number') {
        tocFinalPageNumber = tocPlan.page_number;
      }
    }
    const cahierRes = await appendCahiersTechniques(opts.outPdfPath, opts.products, {
      allocatedProductNames: allocatedNames,
      // Pas de tocFinalPageNumber : l'entry sommaire est ajoutee directement
      // par buildTocFromTemplate via extraEntries (style natif du sommaire).
      insertBeforeLastPage: true,
    });
    if (cahierRes.pagesAdded > 0) {
      const range = cahierRes.firstPageNumber === cahierRes.lastPageNumber
        ? `${cahierRes.firstPageNumber}`
        : `${cahierRes.firstPageNumber}-${cahierRes.lastPageNumber}`;
      warnings.push(
        `cahiers techniques : ${cahierRes.schemasPlaced} schema(s) sur ${cahierRes.pagesAdded} page(s) (p.${range}, ${cahierRes.filteredOut} produits filtres non alloues)`,
      );
    } else if (cahierRes.filteredOut > 0) {
      warnings.push(
        `cahier technique : ${cahierRes.filteredOut} produit(s) avec schema non alloues (ignores).`,
      );
    }
    warnings.push(...cahierRes.warnings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`cahier technique : erreur globale (${msg}). Pipeline continue.`);
  }

  // ─── Audit visuel final (Claude vision) ──────────────────────────────────
  // Desactive par defaut (cf. enableVisualAudit dans EngineOrchestratorOptions).
  // Pour reactiver : passer { enableVisualAudit: true } a l'appel.
  if (opts.enableVisualAudit === true) {
    progress('audit', 85, 'Audit visuel par Claude…');
  }
  const visual = await visualAudit({
    outPdfPath: opts.outPdfPath,
    plan,
    allocations: allocation.allocations,
    workDir: opts.workDir,
    projectDir: opts.projectDir,
    claudeBin: opts.claudeBin,
    sampleSize: opts.visualAuditSampleSize,
    enabled: opts.enableVisualAudit === true,
  });
  let visualAuditCriticalCount = 0;
  let visualAuditMinorCount = 0;
  for (const issue of visual.issues) {
    if (issue.severity === 'critical') {
      visualAuditCriticalCount++;
      warnings.push(
        `audit visuel CRITIQUE p.${issue.finalPageNumber} (src ${issue.sourcePage}): `
          + `${issue.category} — ${issue.description}`
          + (issue.productName ? ` [${issue.productName}]` : ''),
      );
    } else {
      visualAuditMinorCount++;
    }
  }
  claudeNotes.push(...visual.notes);

  // Issues d'audit Gemini (visuel + coherence) collectees de facon structuree
  // pour l'UI "pages a verifier" (garde-fou de relecture humaine).
  const geminiAuditIssues: GeminiAuditIssue[] = [];

  // ─── Audit Gemini Vision (alternative + cumulable Claude) ───────────────
  // Gratuit free tier, pas d'expiration auth. Detecte les bugs visuels
  // page-par-page (overflow, overlap, cropped, mismatch).
  // Default true : Gemini est gratuit, fallback gracieux si pas de cle.
  // Set explicitement enableGeminiAudit: false pour desactiver.
  if (opts.enableGeminiAudit !== false) {
    try {
      progress('audit', 86, 'Audit visuel Gemini…');
      const { visualAuditGemini } = await import('./gemini/visualAudit');
      const gem = await visualAuditGemini({
        outPdfPath: opts.outPdfPath,
        plan,
        allocations: allocation.allocations,
        workDir: opts.workDir,
        sampleSize: opts.visualAuditSampleSize,
        projectDir: opts.projectDir, // active le cache audit
      });
      if (gem.ran) {
        const crit = gem.issues.filter((i) => i.severity === 'critical').length;
        const minor = gem.issues.length - crit;
        warnings.push(
          `audit Gemini : ${gem.issues.length} issue(s) (${crit} critical, ${minor} minor) sur ${gem.sampledPages.length} page(s) en ${gem.durationMs}ms`,
        );
        for (const issue of gem.issues) {
          // Collecte structuree (pour l'UI "pages a verifier"), tous severites.
          geminiAuditIssues.push({
            page: issue.finalPageNumber,
            severity: issue.severity,
            category: issue.category,
            description: issue.description,
            productName: issue.productName ?? undefined,
            source: 'visual',
          });
          if (issue.severity === 'critical') {
            warnings.push(
              `audit Gemini CRITIQUE p.${issue.finalPageNumber}: ${issue.category} — ${issue.description}`
                + (issue.productName ? ` [${issue.productName}]` : ''),
            );
          }
        }
      } else if (gem.notes.length) {
        warnings.push(`audit Gemini skip : ${gem.notes[0]}`);
      }
    } catch (err) {
      warnings.push(`audit Gemini : erreur (${(err as Error).message})`);
    }
  }

  // ─── Audit Gemini de coherence globale (cross-page) ──────────────────────
  // Detecte les incoherences inter-pages : typo / couleurs / hierarchie /
  // alignements / pagination / sommaire mismatch. Un seul appel batch Pro Vision.
  if (opts.enableGeminiCoherenceAudit === true) {
    try {
      progress('audit', 88, 'Audit coherence Gemini…');
      const { coherenceAudit } = await import('./gemini/coherenceAudit');
      const coh = await coherenceAudit({
        outPdfPath: opts.outPdfPath,
        plan,
        workDir: opts.workDir,
      });
      if (coh.ran) {
        const crit = coh.issues.filter((i) => i.severity === 'critical').length;
        const minor = coh.issues.length - crit;
        warnings.push(
          `coherence Gemini : ${coh.issues.length} issue(s) (${crit} critical, ${minor} minor) sur ${coh.sampledPages.length} page(s) en ${coh.durationMs}ms`,
        );
        for (const issue of coh.issues) {
          geminiAuditIssues.push({
            page: issue.pages[0] ?? 0,
            pages: issue.pages,
            severity: issue.severity,
            category: issue.category,
            description: issue.description,
            source: 'coherence',
          });
          if (issue.severity === 'critical') {
            warnings.push(
              `coherence Gemini CRITIQUE [${issue.category}] p.${issue.pages.join(',')}: ${issue.description}`,
            );
          }
        }
      } else if (coh.notes.length) {
        warnings.push(`coherence Gemini skip : ${coh.notes[0]}`);
      }
    } catch (err) {
      warnings.push(`coherence Gemini : erreur (${(err as Error).message})`);
    }
  }

  progress('finalize', 97, 'Finalisation…');

  // Stats Gemini de CETTE generation (delta depuis le mark initial).
  // Si Gemini a ete utilise : warning recap avec calls / cache hits / erreurs.
  const geminiDelta = statsSince(geminiStatsMark);
  if (geminiDelta.totalCalls > 0) {
    warnings.push(formatAggregate(geminiDelta));
  }
  // Notif QUOTA : si l'API a tape son rate limit (429) et/ou bascule sur le
  // fallback (CLI Pro abonnement / Claude), on emet un warning DEDIE que l'UI
  // detecte (prefixe "Quota Gemini") pour afficher une notif claire. Le rendu
  // n'est PAS impacte (le fallback a pris le relais).
  const calls429 = geminiDelta.errorBreakdown[429] ?? 0;
  if (calls429 > 0 || geminiDelta.fallbacksUsed > 0) {
    // Le CLI Gemini est abandonne : le relais est desormais la CASCADE de
    // modeles API (3.1-flash-lite → flash → … → Gemma), puis Claude en dernier.
    const modelsUsed = Object.keys(geminiDelta.byModel).join(', ') || 'cascade';
    warnings.push(
      `Quota Gemini atteint (${calls429}× 429, ${geminiDelta.fallbacksUsed} bascule(s) de modele) — `
        + `relais automatique via la cascade (${modelsUsed}). Rendu non impacte.`,
    );
  }
  // Si des circuits Gemini se sont ouverts pendant ce run : avertir.
  // Le breaker se reset auto apres 5min, donc c'est purement informatif.
  const { getCircuitState } = await import('./gemini/circuitBreaker');
  const cbState = getCircuitState();
  const openCircuits = Object.entries(cbState).filter(([, v]) => v.open);
  if (openCircuits.length > 0) {
    const list = openCircuits.map(([k]) => k).join(', ');
    warnings.push(`Gemini circuits ouverts (quota epuise, retest auto 5min) : ${list}`);
  }

  // Quick win audit : promouvoir auth fail Claude des claudeNotes vers
  // warnings utilisateur. Une seule occurrence (dedup).
  if (detectClaudeAuthFailure(claudeNotes)) {
    warnings.push(
      'Claude API auth expirée — relance `claude login` pour reactiver. '
        + 'Pipeline continue mais descriptions/audit visuel desactives.',
    );
  }

  const geminiUsage: GeminiUsage | undefined = geminiDelta.totalCalls > 0
    ? {
        byModel: geminiDelta.byModel,
        byModelDetail: geminiDelta.byModelDetail,
        totalCalls: geminiDelta.totalCalls,
        okCalls: geminiDelta.okCalls,
        fallbacks: geminiDelta.fallbacksUsed,
        calls429,
      }
    : undefined;

  return {
    ok: true,
    outPdfPath: opts.outPdfPath,
    stats: {
      pagesKept: plan.pages.length,
      pagesDeleted: plan.stats?.pages_deleted ?? 0,
      productsUsed: plan.stats?.products_used ?? 0,
      productsRemaining: plan.stats?.products_remaining ?? 0,
      extractMs,
      classifyMs,
      allocateMs,
      claudeAuditMs,
      substituteMs,
      renderMs,
      profileSource: profile.source,
      productPagesTotal,
      productPagesAllocated,
      allocationRatio,
      dropReasonCounts:
        Object.keys(dropReasonCounts).length > 0
          ? dropReasonCounts
          : undefined,
      claudeCorrections,
      claudeCostUsd,
      visualAuditMs: visual.durationMs,
      visualAuditCostUsd: visual.costUsd,
      visualAuditSampledCount: visual.sampledPages.length,
      visualAuditCriticalCount,
      visualAuditMinorCount,
      specNormalizerMs: specNorm.durationMs,
      specNormalizerCostUsd: specNorm.costUsd,
      specNormalizerKeysRemapped: specNorm.keysRemapped,
      valueFormatterMs: valueFmt.durationMs,
      valueFormatterCostUsd: valueFmt.costUsd,
      valueFormatterValuesReformatted: valueFmt.valuesReformatted,
      tocSourcePage,
      tocEntriesWritten,
      intentLoopMs,
      intentLoopCostUsd,
      intentLoopIterations,
      intentLoopIntents,
      intentLoopOpsApplied,
    },
    warnings,
    errors: [],
    claudeNotes,
    visualAuditIssues: visual.issues.length > 0 ? visual.issues : undefined,
    geminiAuditIssues: geminiAuditIssues.length > 0 ? geminiAuditIssues : undefined,
    geminiUsage,
    plan,
    allocations: allocation.allocations,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Hash du contenu textuel d'une page (concat 20 spans non-vides triés par
 *  position top-down/left-right). Sert a detecter les duplications visuelles
 *  (ex recto-verso imprimerie). Trier par bbox rend le hash deterministe
 *  meme si l'ordre de traversee PDFium varie selon les FORM XObjects. */
export function pageContentHash(page: ExtractedPage): string {
  const spans = (page.raw_spans ?? []).filter((s) => s.text.trim().length > 0);
  spans.sort((a, b) => {
    // y0 (top) puis x0 (left) ; tolerance 0.5pt sur y pour eviter shuffle
    // entre spans alignes a la baseline mais legerement decales.
    if (Math.abs(a.bbox[1] - b.bbox[1]) > 0.5) return a.bbox[1] - b.bbox[1];
    return a.bbox[0] - b.bbox[0];
  });
  return spans
    .slice(0, 20)
    .map((s) => s.text.trim())
    .join('|');
}

/**
 * Dedup ribbons par row Y (horizontal) ou col X (vertical) avec garde-fou
 * anti-UNION-geant.
 *
 * Sur Catalogue C / Catalogue B, les 2 spans "POMPES D'ÉVACUATION" + "EAUX CLAIRES"
 * sont consecutifs sur la meme ligne Y, sans X-overlap. On les merge en 1
 * bbox UNION pour erase complet du texte template.
 *
 * Garde-fou (faille review) : on rejette le merge si l'union depasse 70%
 * de la dimension page (W pour horiz, H pour vert) — sinon 2 ribbons
 * distincts a gauche+droite se mergeaient en rectangle plein-page.
 */
export function dedupRibbonsByRow<T extends { bbox: [number, number, number, number] }>(
  ribbons: T[],
  pageW: number,
  pageH: number,
): T[] {
  const RIBBON_Y_TOL = 4;
  const MAX_UNION_RATIO = 0.7;
  const deduped: T[] = [];
  for (const s of ribbons) {
    const sameRow = deduped.find((other) => {
      const sHoriz = (s.bbox[2] - s.bbox[0]) > (s.bbox[3] - s.bbox[1]);
      const otherHoriz =
        (other.bbox[2] - other.bbox[0]) > (other.bbox[3] - other.bbox[1]);
      if (sHoriz !== otherHoriz) return false;
      if (sHoriz) {
        if (Math.abs(s.bbox[1] - other.bbox[1]) > RIBBON_Y_TOL) return false;
        const unionW =
          Math.max(s.bbox[2], other.bbox[2]) - Math.min(s.bbox[0], other.bbox[0]);
        return unionW <= pageW * MAX_UNION_RATIO;
      }
      if (Math.abs(s.bbox[0] - other.bbox[0]) > RIBBON_Y_TOL) return false;
      const unionH =
        Math.max(s.bbox[3], other.bbox[3]) - Math.min(s.bbox[1], other.bbox[1]);
      return unionH <= pageH * MAX_UNION_RATIO;
    });
    if (sameRow) {
      const idx = deduped.indexOf(sameRow);
      deduped[idx] = {
        ...sameRow,
        bbox: [
          Math.min(sameRow.bbox[0], s.bbox[0]),
          Math.min(sameRow.bbox[1], s.bbox[1]),
          Math.max(sameRow.bbox[2], s.bbox[2]),
          Math.max(sameRow.bbox[3], s.bbox[3]),
        ],
      };
    } else {
      deduped.push(s);
    }
  }
  return deduped;
}

/** Detecte si les claudeNotes contiennent une indication d'auth expiree.
 *  Promu en warning utilisateur (faille audit : note moins visible). */
export function detectClaudeAuthFailure(claudeNotes: string[]): boolean {
  return claudeNotes.some((n) =>
    /auth\s+expir|claude\s+login|401|authentication_error|Invalid\s+authentication/i.test(n),
  );
}

/**
 * Calcule les zones de protection intercalaire (debut/fin du catalogue)
 * de facon adaptative selon le nombre total de pages.
 *
 * Faille review : seuil fixe 5 cassait sur mini-catalogues (8 pages =
 * 100% protege, plus rien d'exploitable) et sous-couvrait les mega-catalogues
 * (200 pages = 2.5% protege seulement).
 *
 * Strategie :
 *   - mini (< 12 pages) : 1 + 1 (cover + 4eme de couv minimum)
 *   - standard (12-50 pages) : 5 + 5 (legacy)
 *   - mega (> 50 pages) : 5% des pages cappe a 10
 *
 * Invariant : intro + outro < totalPages (au moins 1 page au milieu doit
 * rester exploitable pour la substitution).
 */
export function computeIntercalaireGuardZones(totalPages: number): {
  intro: number;
  outro: number;
} {
  // Garde-fou pour catalogues degeneres (faille audit : invariant doc viole
  // pour totalPages <= 2). En pratique l'orchestrator early-return en amont
  // mais on protege ici aussi.
  if (totalPages <= 2) return { intro: 0, outro: 0 };
  if (totalPages < 12) return { intro: 1, outro: 1 };
  if (totalPages <= 50) return { intro: 5, outro: 5 };
  const pct = Math.min(10, Math.ceil(totalPages * 0.05));
  return { intro: pct, outro: pct };
}

async function loadExtractedPages(
  dir: string,
  warnings: string[],
): Promise<ExtractedPage[]> {
  const entries = await fs.readdir(dir);
  const jsons = entries.filter((f) => f.startsWith('page-') && f.endsWith('.json')).sort();
  // P0.5 : Promise.all parallelise les readFile (gain ~50% sur volumes
  // monte NFS / Docker). On garde l'ordre via Promise.all (preserve l'ordre
  // des promesses), pas via reduce séquentiel.
  const raws = await Promise.all(
    jsons.map(async (fname) => ({
      fname,
      raw: await fs.readFile(path.join(dir, fname), 'utf8').catch((e: unknown) => {
        warnings.push(`IO error ${fname} : ${(e as Error).message}`);
        return null;
      }),
    })),
  );
  const pages: ExtractedPage[] = [];
  for (const { fname, raw } of raws) {
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw);
      const res = validateExtractedPage(parsed);
      if (res.ok) {
        const ep = res.data;
        if (parsed.raw_spans) ep.raw_spans = parsed.raw_spans;
        if (parsed.raw_images) ep.raw_images = parsed.raw_images;
        if (parsed.raw_paths) ep.raw_paths = parsed.raw_paths;
        pages.push(ep);
      } else {
        warnings.push(`page invalide ${fname} : ${res.errors[0]?.message ?? '?'}`);
      }
    } catch (e) {
      warnings.push(`JSON invalide ${fname} : ${(e as Error).message}`);
    }
  }
  return pages;
}

interface FailParams {
  msg: string;
  extractMs: number;
  classifyMs: number;
  allocateMs: number;
  claudeAuditMs: number;
  substituteMs: number;
  renderMs: number;
  profileSource: string;
  claudeCorrections: number;
  warnings: string[];
  notes: string[];
}

function failResult(p: FailParams): EngineOrchestratorResult {
  return {
    ok: false,
    outPdfPath: '',
    stats: {
      pagesKept: 0,
      pagesDeleted: 0,
      productsUsed: 0,
      productsRemaining: 0,
      extractMs: p.extractMs,
      classifyMs: p.classifyMs,
      allocateMs: p.allocateMs,
      claudeAuditMs: p.claudeAuditMs,
      substituteMs: p.substituteMs,
      renderMs: p.renderMs,
      profileSource: p.profileSource,
      claudeCorrections: p.claudeCorrections,
    },
    warnings: p.warnings,
    errors: [p.msg],
    claudeNotes: p.notes,
  };
}

/** Helper d'echec quand le pipeline crash AVANT extract (= aucune phase n'a
 *  ete mesuree). Renvoie un EngineOrchestratorResult avec stats a zero. */
function failResultBootstrap(msg: string): EngineOrchestratorResult {
  return failResult({
    msg,
    extractMs: 0,
    classifyMs: 0,
    allocateMs: 0,
    claudeAuditMs: 0,
    substituteMs: 0,
    renderMs: 0,
    profileSource: '',
    claudeCorrections: 0,
    warnings: [],
    notes: [],
  });
}

// ─── BC : helpers IntentPlan ────────────────────────────────────────────────

/** Construit un IntentPlan informationnel a partir des allocations + classes.
 *  Ne contient PAS d'IntentOps (le pipeline n'en genere pas encore) — juste
 *  les schemas de page, qui servent au resolver et a Claude pour cibler
 *  precisement des zones. */
function buildIntentPlanV1(
  allocations: { sourcePage: number; sectionLabel?: string | null }[],
  classifications: { pageNumber: number; kind: string; extracted: ExtractedPage; blocks: ProductBlock[] }[],
): { version: '1'; schemas: PageSchema[] } {
  const schemas: PageSchema[] = [];
  for (const a of allocations) {
    const cls = classifications.find((c) => c.pageNumber === a.sourcePage);
    if (!cls) continue;
    const schema = buildPageSchema({
      page: cls.extracted,
      kind: cls.kind as PageSchema['kind'],
      blocks: cls.blocks,
    });
    schemas.push(schema);
  }
  return { version: '1', schemas };
}
