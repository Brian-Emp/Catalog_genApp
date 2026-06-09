/**
 * V2 engine orchestrator — full pipeline.
 *
 * Phases (in the strict order of the spec):
 *   Phase 0 — inputs: C++ extract + parse products by section
 *   Phase 1.1 — classify: kind per page (product/toc/glossaire/intercalaire/identity)
 *   Phase 2 — allocate: pick product pages based on need (1 section = 1 page)
 *   Phase 1.2 — claudeAudit: Claude validates + corrects + adds drops
 *   Phase 3 — substitute: ops per block (style borrowed from the template)
 *   Final phase — Plan assembly + renumbering + C++ render (the custom
 *     table of contents, ex-Phase 4, is disabled: too fragile on design
 *     contents pages — see tocBuilder.ts in the git history to reactivate).
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

/** Returns the majority value of an optional field over a list of
 *  PlanProducts. Empty if all are absent. Used to recover the family /
 *  sub-family of an allocation (majority among its products). */
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
  /** Enables the Claude audit (~2-3 min). Default false (fast pipeline ~2s). */
  enableClaudeAudit?: boolean;
  /** Enables the final visual audit by Claude (vision over N sampled pages
   *  after render). Default FALSE — the audit takes ~60s out of the 80s
   *  pipeline, an insufficient cost/benefit ratio for everyday use. Enable via
   *  flag for critical generations (a client release, for example). */
  enableVisualAudit?: boolean;
  /** Sample size for the visual audit. Default 6. 'all' for every
   *  substituted page (expensive). */
  visualAuditSampleSize?: number | 'all';
  /** Enables the visual audit via Gemini Vision (free tier + no auth
   *  expiration, an alternative to Claude). Default TRUE: Gemini is
   *  free so it is safe as a default. Graceful skip if GEMINI_KEY is absent.
   *  Set to FALSE to disable explicitly. Stackable with
   *  enableVisualAudit (Claude) for cross-checking. */
  enableGeminiAudit?: boolean;
  /** Enables the global coherence audit via Gemini Pro Vision (cross-page
   *  analysis: typo / colors / hierarchy / alignments / pagination).
   *  A single batch call, 1M token context. Default FALSE. */
  enableGeminiCoherenceAudit?: boolean;
  /** Enables normalization of product spec keys to the template style via
   *  Claude (triggered only if a mismatch > 50% is detected). Default true. */
  enableSpecNormalization?: boolean;
  /** Enables reformatting of spec values to the template style (e.g. "60" →
   *  "60 cm" if the template uses units). Default true. */
  enableValueFormatting?: boolean;
  /** Enables generation of marketing descriptions (Gemini/Claude) for the
   *  table of contents. Default TRUE (we keep the feature). Decoupled from
   *  enableTemplateToc: the TOC renders anyway (deterministic), it just has no
   *  blurbs without descriptions. Fail-fast on dead quota (fast skip, never blocking). */
  enableGeminiDescriptions?: boolean;
  /** Enables reuse of the template's original table-of-contents page:
   *  clears the old entries and writes the new catalog's sections while
   *  preserving the original decoration / typography / layout. Places the TOC
   *  page just before the 1st substituted product page. Default true. */
  enableTemplateToc?: boolean;
  /** Enables the IntentPlan chain (BC approach): builds one PageSchema per
   *  substituted product page + persists an informational plan_v2.json next to
   *  the low-level plan. The C++ binary sees no change.
   *
   *  IMPORTANT: default TRUE (intent by default). To disable explicitly,
   *  pass `enableIntentPlan: false`. The code uses `opts.enableIntentPlan
   *  !== false` (cf engineOrchestrator.ts:554 useIntentSubstitute). This choice
   *  comes from BC_test where intent was the default. If you want the strict
   *  procedural V2 pipeline (substitutor.ts alone), pass false explicitly. */
  enableIntentPlan?: boolean;
  /** Enables the Claude → IntentOps → re-render loop after the 1st C++
   *  render (BC approach). Requires enableIntentPlan true (otherwise no
   *  schemas available). Default FALSE. Cost: ~$0.02-0.05/page * sample * iter. */
  enableIntentLoop?: boolean;
  /** Cap on pages sampled per intent-loop pass. Default 5. */
  intentLoopSampleSize?: number;
  /** Max number of Claude → re-render passes. Default 2. */
  intentLoopMaxIterations?: number;
  /** Progress callback (phase, pct, FR message). Invoked at each phase
   *  transition. May be absent (no tracker on the server side). */
  onProgress?: (phase: string, pct: number, message: string) => void;
}

/** Aggregated Gemini usage for THIS generation (UI diagnostics). */
export interface GeminiUsage {
  /** Calls per model (API name → count) for this generation. Lets the UI
   *  show which model(s) were actually used and the switches. */
  byModel: Record<string, number>;
  /** Detail per model (calls / ok / quota429) → the UI shows which cascade
   *  models are exhausted vs healthy. */
  byModelDetail?: Record<string, { calls: number; ok: number; quota: number }>;
  totalCalls: number;
  okCalls: number;
  /** Cascade switches (a call had to fall back to a backup model). */
  fallbacks: number;
  /** 429 (quota) errors encountered. */
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
    /** Total number of template product pages (kind='product') before allocator. */
    productPagesTotal?: number;
    /** Number of product pages actually allocated to a plan product. */
    productPagesAllocated?: number;
    /** allocated/total ratio (0..1). Allocator efficiency indicator.
     *  On Catalogue A: 8/188 = 0.04 (large catalog, few products).
     *  On a dense, well-sized catalog: > 0.5. */
    allocationRatio?: number;
    /** Breakdown of drop reasons for the non-allocated pages. */
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
  /** Gemini audit issues (per-page visual + cross-page coherence) aggregated
   *  for the "pages to review" UI (proofreading safeguard). undefined if none. */
  geminiAuditIssues?: GeminiAuditIssue[];
  /** Gemini usage for THIS generation (models used + cascade switches)
   *  for UI diagnostics. undefined if no Gemini call. */
  geminiUsage?: GeminiUsage;
  /** Final assembled plan (for post-processing: TOC, exports). */
  plan?: Plan;
  /** Product → template page allocations (for post-processing). */
  allocations?: PageAllocation[];
}

/** Unified Gemini audit issue (per-page visual OR cross-page coherence),
 *  lightweight format for the "pages to review" UI. */
export interface GeminiAuditIssue {
  /** Main final page concerned (1-based). */
  page: number;
  /** Multiple pages (cross-page coherence audit). */
  pages?: number[];
  severity: 'critical' | 'minor';
  category: string;
  description: string;
  productName?: string;
  /** Origin: per-page visual audit or global coherence audit. */
  source: 'visual' | 'coherence';
}

// In Docker prod (Linux x64/arm64) the binary is installed at
// /usr/local/bin/catgen-pdf. On local macOS ARM, Homebrew uses
// /opt/homebrew/bin/. We accept both; in dev override via the
// CATGEN_BIN env var (recommended).
const LINUX_BINARY = '/usr/local/bin/catgen-pdf';
const HOMEBREW_BINARY = '/opt/homebrew/bin/catgen-pdf';
function resolveDefaultBinary(): string {
  // Priority env > local Homebrew (if the file exists) > Linux. The
  // existence check happens when the child_process is launched via spawn
  // (handles ENOENT). Here we just return the most likely default path.
  if (process.env.CATGEN_BIN) return process.env.CATGEN_BIN;
  if (process.platform === 'darwin') return HOMEBREW_BINARY;
  return LINUX_BINARY;
}

/**
 * Full V2 pipeline: extract → classify → allocate → substitute → render.
 * Cleanup of the workDir is delegated to the caller (cf generate.ts which
 * needs to read plan.json AFTER return to copy it next to the PDF).
 */
export async function substituteCatalogEngine(
  opts: EngineOrchestratorOptions,
): Promise<EngineOrchestratorResult> {
  const binary = opts.binaryBin ?? resolveDefaultBinary();
  const warnings: string[] = [];
  const claudeNotes: string[] = [];
  const progress = opts.onProgress ?? (() => {});

  // Reset blockDetector's module-level accumulators: on a long-lived
  // server, droppedPages/horizontalLayoutPages piled up across
  // generations (slow leak + mixed-up debugging). We start clean on each run.
  resetDroppedPages();
  resetHorizontalLayoutPages();

  // Snapshot Gemini stats before the pipeline to measure the usage of THIS
  // generation (vs the global process total).
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
    // workDir setup failure (ENOSPC, perms) → clean failure.
    return failResultBootstrap(`setup workDir failed: ${(e as Error).message}`);
  }

  // ─── C++ extract ──────────────────────────────────────────────────────────
  // Cache hit? If the same template hash was already extracted, we copy the
  // JSONs and skip the binary (~700ms → ~30ms). Otherwise normal extract + save.
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
    // Best-effort save: if the filesystem cache fails (perms, ENOSPC), we
    // continue without crashing the pipeline. The next run will re-extract.
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

  // ─── Page orientation (portrait / landscape) ──────────────────────────────
  // Detects the dominant orientation over the sample of extracted pages.
  // Catalogs like Catalogue A/Catalogue E = landscape (legacy). Catalogs like Catalogue C /
  // Catalogue B Jardin = portrait. The pipeline supports both orientations
  // since the introduction of the adaptive heuristic profile. No explicit
  // warning (recalibrated: this is no longer a limitation).
  const orientation: PageOrientation = dominantOrientation(pages);

  // ─── Typo profile ─────────────────────────────────────────────────────────
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


  // ─── Phase 0: inputs ─────────────────────────────────────────────────────
  progress('classify', 14, 'Détection des blocs et sections…');
  const analysis = analyzeProducts(opts.products);

  // ─── Phase 1.1: classify ─────────────────────────────────────────────────
  const classifyStart = Date.now();
  const baseClassifications = classifyAllPages(pages, profile);
  const classifyMs = Date.now() - classifyStart;

  // P2.5: strong alert if no product block is detected while we have
  // products to substitute. "Purely visual" template with no typographic
  // key/value, or incompatible blocDetector heuristic. The pipeline will
  // continue but will produce 0 substitutions.
  const totalBlocks = baseClassifications.reduce((s, c) => s + c.blocks.length, 0);
  if (totalBlocks === 0 && opts.products.length > 0) {
    warnings.push(
      `aucun bloc produit detecte dans ${pages.length} page(s) template. ` +
        'Le PDF de sortie reprend le template sans substitution. ' +
        'Possibles causes : template sans cle/valeur typographique, ' +
        'profil typographique fallback, ou patterns trop stricts.',
    );
  }
  // "Non-standard template" detection: very few product pages detected
  // relative to the total page count, OR very low average confidence.
  // Likely indicates a layout that V2 cannot handle cleanly (multi-product
  // tables, merchandising, very design-heavy catalog...). The pipeline will
  // still try but the rendering will probably be overlapping / inconsistent.
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

  // ─── Phase 1.5: section inference from the template ─────────────────────
  // If most products have no section set but the template contains several
  // distinct sections (banners), we infer for each product the closest
  // section by name tokens. Lets us support simple XLSX files (without a
  // family/section column).
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
        // Re-analyze with the inferred sections
        effectiveAnalysis = analyzeProducts(opts.products);
      }
    }
  }

  // ─── Phase 2: allocate ───────────────────────────────────────────────────
  progress('allocate', 20, 'Allocation des pages produit…');
  const allocateStart = Date.now();
  const allocation = allocatePages(baseClassifications, effectiveAnalysis, {
    // If there are too many products for the available template pages, we
    // allow grid overflow: downstream `gridLayout` synthesizes additional
    // blocks by vertically translating the reference tpl block. Lets us
    // avoid dropping products silently.
    allowGridOverflow: true,
  });
  const allocateMs = Date.now() - allocateStart;

  // Allocator stats for the API response (quick win audit)
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

  // Warnings about unused product pages (template over-allocation).
  if (allocation.droppedProductPages.length > 0) {
    // Reason breakdown for observability (production-blocking audit)
    const reasonCounts = new Map<string, number>();
    for (const d of allocation.droppedPageDetails ?? []) {
      reasonCounts.set(d.reason, (reasonCounts.get(d.reason) ?? 0) + 1);
    }
    const reasonBreakdown = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}=${n}`)
      .join(', ');
    // Ratio stat: ${dropped}/${total} = ${pct}% drop (useful to understand
    // whether it's normal — few products on a large catalog — or pathological).
    const productPagesTotal = baseClassifications.filter(
      (c) => c.kind === 'product',
    ).length;
    const dropPct = productPagesTotal > 0
      ? Math.round(allocation.droppedProductPages.length / productPagesTotal * 100)
      : 0;
    // Limit the page display to 20 (otherwise the warning hits 500 chars)
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

  // ─── PARALLEL descriptions phase (Claude Haiku, ~17s) ───────────────────
  // generateDescriptions only reads the product NAMES + first specs
  // (captured into the prompt SYNCHRONOUSLY at build time). Later
  // mutations of products by normalize/format do not affect the call
  // already in flight. We launch it here in the background, await it in the
  // TOC block. Gain: ~15s on the total (overlap with norm+format+substitute).
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
          // Try Gemini first (free + no auth expiration).
          // Fall back to Claude Haiku if Gemini is unavailable / API error.
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
          // If the Gemini quota is cold (full cascade just failed), the Claude
          // fallback (slow CLI spawn, auth often expired) would drag down the
          // gen time for an AUXILIARY task → we skip, fast. Claude is still
          // used when Gemini fails for another reason (quota OK).
          const { isQuotaCold } = await import('./gemini/circuitBreaker');
          if (isQuotaCold()) {
            return { ran: false, durationMs: 0, notes: ['gemini froid → skip fallback Claude (gen rapide)'], descriptions: {} };
          }
          // Claude fallback
          return generateDescriptions({
            sections: descSections,
            workDir: opts.workDir,
            projectDir: opts.projectDir,
            claudeBin: opts.claudeBin,
            enabled: true,
          });
        } catch (err) {
          // AUXILIARY step: a failure (broken import, Claude fallback that
          // throws) must NEVER abort the PDF generation. We degrade to a no-op.
          return {
            ran: false,
            durationMs: 0,
            notes: [`descriptions echec (non bloquant): ${err instanceof Error ? err.message : String(err)}`],
            descriptions: {},
          };
        }
      })()
    : Promise.resolve({ ran: false, durationMs: 0, notes: [], descriptions: {} });

  // ─── Phase 1.2: Claude audit ─────────────────────────────────────────────
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

  // ─── Phase 2.5: normalize spec keys to the template style ───────────────
  // Triggered only if a mismatch > 50% is detected (xlsx in an exotic
  // language or custom client naming). Otherwise silent skip. In-place
  // mutation on the products → substitutor will read the new keys.
  // We take the keys of the ALLOCATED pages in priority (= those that will
  // receive the new products) to get a mapping relevant to the context.
  // Fallback: all product pages if no allocation.
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

  // ─── Phase 2.6: value formatting (units, suffixes) ──────────────────────
  // After normalizing the keys, we standardize the VALUES to match the
  // template style (e.g. "60" → "60 cm" if the template uses units).
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

  // ─── Phase 3: substitute ─────────────────────────────────────────────────
  progress('substitute', 55, 'Substitution des produits…');
  const substituteStart = Date.now();
  resetMissingProductImages();
  // Index: sourcePage → PageAllocation
  const allocByPage = new Map(allocation.allocations.map((a) => [a.sourcePage, a]));
  const substitutedPages = new Map<number, Operation[]>();
  // Intent-driven: we store the schemas + intents for plan_v2 + the loop
  const intentSchemasBySourceEarly = new Map<number, PageSchema>();
  const intentsBySource = new Map<number, { intents: import('./intent/intent').IntentOp[] }>();
  const useIntentSubstitute = opts.enableIntentPlan !== false; // BC_test: intent by default
  for (const a of allocation.allocations) {
    const cls = classifications.find((c) => c.pageNumber === a.sourcePage);
    if (!cls) continue;
    // Vector decorations: extracted from slots type='decoration' kind='vector'.
    const decorationVectors = cls.extracted.slots
      .filter(
        (s) => s.type === 'decoration' && (s as { kind?: string }).kind === 'vector',
      )
      .map((s) => s.bbox);
    // section_banner spans detected strictly via isRealSectionBannerLabel
    // (factored out from classify.ts; see docstring for the criteria).
    const sectionBannerSpans = cls.extracted.slots
      .filter((s) => s.type === 'section_banner')
      .map((s) => (s as { label: TextSpan }).label)
      .filter((lbl) => isRealSectionBannerLabel(lbl, profile));

    // Ribbon spans (vertical OR horizontal): detected heuristically.
    //  - Vertical: bbox on the left/right edge + vertical text (h > w)
    //  - Horizontal: bbox on the top/bottom edge + short text (≤ 40 chars),
    //                size >= 12pt, wide band (w > 30% page width).
    //    Avoids matching page numbers (≤ 5 chars typically) and section
    //    titles (central area, not on the border).
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

      // Vertical detection: rotated text (h > w), on the left/right edge
      if (h > w) {
        const onLeft = s.bbox[2] < ribbonMargin;
        const onRight = s.bbox[0] > pageW - ribbonMargin;
        return onLeft || onRight;
      }

      // Horizontal detection: top/bottom band with short, wide text
      if (w > h && txt.length <= HORIZONTAL_RIBBON_MAX_CHARS
          && s.size >= HORIZONTAL_RIBBON_MIN_SIZE
          && w >= pageW * HORIZONTAL_RIBBON_MIN_W_RATIO) {
        const onTop = s.bbox[3] < HORIZONTAL_RIBBON_TOP_MARGIN;
        const onBottom = s.bbox[1] > pageH - HORIZONTAL_RIBBON_BOTTOM_MARGIN;
        return onTop || onBottom;
      }
      return false;
    });
    // Dedup ribbons on the same Y band: on Catalogue C / Catalogue B the 2 spans
    // "POMPES D'ÉVACUATION" + "EAUX CLAIRES" are consecutive on the same
    // Y line, with no X-overlap. Substituting each with "SANITAIRE" gives a
    // visible "SANITAIRESANITAIRE". Solution: group by Y row and keep only
    // the 1st span of each row.
    const dedupedRibbons = dedupRibbonsByRow(ribbonSpans, pageW, pageH);
    const ribbonSpansDedup = dedupedRibbons;
    // Majority family of the products allocated on this page (often a single
    // value). If absent: no ribbon substitution.
    const familyCounts = new Map<string, number>();
    for (const p of a.products) {
      const f = (p.family ?? '').trim();
      if (f) familyCounts.set(f, (familyCounts.get(f) ?? 0) + 1);
    }
    let newFamilyLabel: string | undefined;
    if (familyCounts.size > 0) {
      newFamilyLabel = [...familyCounts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    }

    // Section banner: we prefer the label coming from the ALLOCATED PRODUCTS
    // over the one detected on the template page. Guarantees the consistency
    // "banner = what the page is about" when the allocator places products of
    // one section on a template page that showed another. If no product has a
    // section, fall back to a.sectionLabel (template label).
    const sectionCounts = new Map<string, number>();
    for (const p of a.products) {
      const s = (p.section ?? '').trim();
      if (s) sectionCounts.set(s, (sectionCounts.get(s) ?? 0) + 1);
    }
    const productSectionLabel = sectionCounts.size > 0
      ? [...sectionCounts.entries()].sort((x, y) => y[1] - x[1])[0][0]
      : undefined;
    const finalSectionLabel = productSectionLabel ?? a.sectionLabel;

    // ─── Grid overflow: if N products > N template blocks ────────────────
    // Synthesizes the extra blocks (vertical translation of the reference
    // template block) to fit the surplus products on the same page. If no
    // space is available, returns the original blocks and the surplus
    // products are dropped as before.
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
      // Intent-driven pipeline: generates IntentOps → resolve → Operations
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
      // Fallback: legacy substitutor (procedural)
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
  // Warning for products without an image (incomplete assets.zip)
  const missingImgs = getMissingProductImages();
  if (missingImgs.length > 0) {
    const names = missingImgs.slice(0, 5).map((m) => `"${m.productName}"`).join(', ');
    const more = missingImgs.length > 5 ? `, +${missingImgs.length - 5} autres` : '';
    warnings.push(
      `${missingImgs.length} produit(s) sans image source : ${names}${more}. `
        + `Verifier que assets.zip contient bien les fichiers.`,
    );
  }

  // ─── Plan assembly (final drop + renum) ──────────────────────────────────

  // Product zone = between the 1st and the last kind='product' page (or
  // 'intercalaire' that announces a section). Within this zone: everything
  // that is NOT substituted gets dropped (technical handbook, interleaved
  // lifestyle photos, tech pages, etc.).
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

  // Intro/outro dedup: catalogs often have outro pages that visually
  // duplicate intro pages (recto-verso printing back side).
  // E.g. Catalogue A: page 1 (Catalogue B + CSR) and page 186 are identical. We hash
  // the intro pages (except the cover) then drop the non-intro pages that
  // match. The cover (page 0) is excluded because the back cover
  // legitimately resembles it.
  const introHashes = new Set<string>();
  for (let i = 1; i < firstProductZoneIdx && i < classifications.length; i++) {
    introHashes.add(pageContentHash(classifications[i].extracted));
  }

  const pagePlans: PagePlan[] = [];
  for (let i = 0; i < classifications.length; i++) {
    const cls = classifications[i];
    const forced = forcedDrops.has(cls.pageNumber);
    const inProductZone = i >= firstProductZoneIdx && i <= lastProductZoneIdx;

    // KEEP: substituted product page
    if (substitutedPages.has(cls.pageNumber)) {
      pagePlans.push({
        source_page: cls.pageNumber,
        page_number: null,
        render: { mode: 'operations', operations: substitutedPages.get(cls.pageNumber)! },
      });
      continue;
    }
    // DROP: everything in the product zone that is not substituted
    // (technical handbook, lifestyle photos, contents pages, glossaries, etc.)
    if (inProductZone) continue;
    // DROP: forced by Claude (outside the product zone)
    if (forced) continue;
    // DROP: glossary / tech handbook (may be outside the zone too)
    if (cls.kind === 'glossaire' || cls.kind === 'tech') continue;
    // DROP: toc / intercalaire outside the product zone (rare)
    if (cls.kind === 'toc' || cls.kind === 'intercalaire') continue;
    // DROP: outro page that duplicates an intro page (= recto-verso printing
    // back side). Avoids having the same Catalogue B/CSR page twice.
    if (i > lastProductZoneIdx && introHashes.has(pageContentHash(cls.extracted))) {
      continue;
    }
    // KEEP: brand identity (cover, CSR, NF, legal notices, back cover, etc.)
    pagePlans.push({
      source_page: cls.pageNumber,
      page_number: null,
      render: { mode: 'keep_raw' },
    });
  }

  // ─── Section dividers (pure heuristic) ───────────────────────────────────
  // Revives ONE "pure" divider page (= few spans, no product sheet inside)
  // before each group of product pages of a section. Substitutes the large
  // title with the section label. No Claude call (kept simple for the
  // procedural V2).
  let intercalairesInserted = 0;
  {
    // Product ref pattern to detect "disguised product sheet" pages
    // (= they look like a divider but actually contain refs).
    // Match:
    //   - 6-8 standalone digits ("002236" Catalogue B/Catalogue C, "1234567",
    //     "12345678")
    //   - optional prefix of 4-7 digits + space (wholesaler ERP codes: e.g.
    //     "304740 1234567" from the reference catalog Catalogue A, but
    //     compatible with any wholesaler that prefixes its refs).
    //   - excluded: standalone years (1900-2099) — see the suspect filter below.
    const REF_RE = /\b(?:\d{4,7}\s+)?\d{6,8}\b/;
    const YEAR_RE = /^(?:19|20)\d{2}$/;
    // Concatenated DDMMYYYY dates (8 digits respecting 01-31/01-12/19xx-20xx).
    // Essential filter: without it "28062024" passes REF_RE and breaks the
    // divider detection (legal page "Loi du 28/06/2024" → suspect → identity wrongly).
    const DATE_RE = /\b(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}\b/;
    const SPEC_KW_RE = /\b(MATIERE|MATIÈRE|LONGUEUR|DIAMETRE|DIAMÈTRE|GARANTIE|DURÉE|SUPPORT|CONDITIONNEMENT|ACCESSOIRES|FOURNIS|FINITION|RACCORD|DEBIT|DÉBIT)\b/i;
    const lastPageIdx = classifications.length - 1;
    // "Catalog identity" zones: start (cover + brand intros + CSR +
    // mission) and end (notes + legal notices + index + back cover).
    // Conventionally the first 5 and last 5 pages of a commercial catalog.
    // Any divider page detected in these zones is excluded: we NEVER
    // rewrite a brand intro with a section label. On Catalogue A: pages 0-4
    // already classified identity → no-op. On Catalogue C: pages 1-3 (Catalogue B /
    // Catalogue F / NOS MARQUES / NOTRE VISIBILITÉ) preserved.
    // Adaptive zones based on the catalog size (cf computeIntercalaireGuardZones)
    const { intro: INTRO_ZONE, outro: OUTRO_ZONE } =
      computeIntercalaireGuardZones(classifications.length);
    // Text-span cap for a "pure" divider: a REAL section divider = large
    // title + subtitle + decoration (~5-15 spans). Beyond that, it's a
    // THEMATIC CONTENT page (educational page "how to choose a booster
    // pump", schematic + captions) that must NOT be revived: substituting
    // its band with another section label creates a content/title
    // inconsistency (bug seen on Catalogue C: booster-pump page has 44 spans, band
    // rewritten to "EAUX CLAIRES"). Better NO divider than a fake one.
    const MAX_INTERCALAIRE_TEXT_SPANS = 30;
    const isPureIntercalaire = (c: typeof classifications[0]): boolean => {
      if (c.kind !== 'intercalaire') return false;
      if (c.pageNumber < INTRO_ZONE) return false;
      if (c.pageNumber > lastPageIdx - OUTRO_ZONE) return false;
      const spans = c.extracted.raw_spans ?? [];
      // Anti-thematic-page guard: too much text = a content page, not a
      // reusable divider.
      const textSpans = spans.filter((s) => (s.text ?? '').trim().length > 1);
      if (textSpans.length > MAX_INTERCALAIRE_TEXT_SPANS) return false;
      // Disguised product pages: we filter them by specs/refs.
      let suspect = 0;
      for (const s of spans) {
        const t = s.text.trim();
        // Filter out pure years (1900-2099): not a product ref.
        if (YEAR_RE.test(t)) continue;
        // Filter out DDMMYYYY dates: not a product ref.
        if (DATE_RE.test(t)) continue;
        if (REF_RE.test(t) || SPEC_KW_RE.test(t)) suspect++;
        if (suspect >= 2) return false;
      }
      return true;
    };
    const candidates = classifications.filter(isPureIntercalaire);

    if (candidates.length > 0) {
      // List the sections in product appearance order
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
      // Insert from END to START to preserve the indices
      const sortedSections = [...sectionInsertPoints].sort((a, b) => b.idx - a.idx);
      const used = new Set<number>();
      for (const section of sortedSections) {
        const cand = candidates.find((c) => !used.has(c.pageNumber));
        if (!cand) break;
        used.add(cand.pageNumber);
        // Identify the large title: span with max font_size in the upper
        // half, outside the footer/ribbon zone.
        const pageH = cand.extracted.page_size.height;
        const pageW = cand.extracted.page_size.width;
        const candidates_spans = (cand.extracted.raw_spans ?? []).filter((s) => {
          if (s.text.trim().length < 3) return false;
          if (s.bbox[3] > pageH * 0.7) return false; // bottom = footer
          if (s.bbox[0] > pageW * 0.85) return false; // right edge = ribbon
          const w = s.bbox[2] - s.bbox[0];
          const h = s.bbox[3] - s.bbox[1];
          if (h > w * 1.5) return false; // vertical
          return true;
        });
        if (candidates_spans.length === 0) continue;
        const titleSpan = [...candidates_spans].sort((a, b) => b.size - a.size)[0];
        // Template case
        const tplText = titleSpan.text.trim();
        let styled = section.label;
        const hasUpper = /[A-ZÀ-ſ]/.test(tplText);
        const hasLower = /[a-zà-ſ]/.test(tplText);
        if (hasUpper && !hasLower) styled = section.label.toUpperCase();
        else if (hasLower && !hasUpper) styled = section.label.toLowerCase();
        // Erase the large title + insert the new label
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

  // ─── Table of contents reused from the template ─────────────────────────
  // 2-pass strategy to avoid the "TOC page_number points wrong" bug if the
  // final renumbering diverges from the anticipated indices:
  //   PASS 1 (here): selects the candidate TOC page + inserts a placeholder
  //                  PagePlan (empty ops). Launches Claude descriptions.
  //   PASS 2 (after the main renumbering): builds the REAL TOC ops with the
  //                  actual post-renum page_numbers, then replaces the
  //                  placeholder ops.
  // If Pass 2 fails (no entry), we remove the placeholder + re-renumber.
  let tocSourcePage: number | null = null;
  let tocEntriesWritten = 0;
  let tocPlaceholder: PagePlan | null = null;
  /** All the TOC placeholders (1 or N if the contents page spans multiple pages). */
  let tocPlaceholders: PagePlan[] = [];
  let tocDescriptions: Record<string, string> = {};
  // We ALWAYS await descPromise (even if TOC is off): avoids an unhandled
  // floating promise AND guarantees the descriptions cascade has finished
  // BEFORE the audit block — the cold-quota short-circuit depends on it
  // (descriptions exhaust the quota → markQuotaCold → the audit short-circuits).
  // The result is only used by the TOC if enableTemplateToc.
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
      // Descriptions REQUESTED but NONE produced → we flag it explicitly.
      // Otherwise the contents page loses its blurbs with no explanation (typical
      // cause: daily Gemini quota exhausted / cold cascade → retry later).
      const why = descResult.notes.find(
        (n) => /froid|quota|429|erreur|error|absente|echec|indispo/i.test(n),
      );
      warnings.push(
        'descriptions marketing : aucune generee (sommaire sans chapeaux) — '
          + (why ?? 'Gemini indisponible (quota/erreur), reessayer plus tard'),
      );
    }

    // PASS 1: pick the TOC source page via a "dry" build with page_number=0.
    // The goal here is not to have the right ops but to know whether a valid
    // TOC page exists + recover its source_page.
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
      // Multi-page: we insert as many placeholders as tocDry.pages.length.
      // All point to the same tpl sourcePage (= same decoration). The ops
      // are injected in PASS 2 once we know the real pageNumbers.
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
      // Backward compat: tocPlaceholder = the 1st contents page.
      tocPlaceholder = tocPlaceholders[0];
    }
  }

  // ─── Sort the product pages by hierarchy ─────────────────────────────
  // Aligns the order of the product pages with the table of contents:
  // family > subFamily > section, then sourcePage as tiebreaker. The
  // NON-product pages (cover, intros, contents page, dividers) keep their
  // position. We only permute the substituted pages among themselves, in
  // their slots.
  {
    const allocBySource = new Map(allocation.allocations.map((a) => [a.sourcePage, a]));
    // Appearance orders (= contents page order) for family and sub-family
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

    // Collect the indices + sortKey of the product pages
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

    // Sort by sortKey
    const sortedPlans = [...productSlots].sort((a, b) => {
      if (a.sortKey[0] !== b.sortKey[0]) return a.sortKey[0] - b.sortKey[0];
      if (a.sortKey[1] !== b.sortKey[1]) return a.sortKey[1] - b.sortKey[1];
      const sc = a.sortKey[2].localeCompare(b.sortKey[2]);
      if (sc !== 0) return sc;
      return a.sortKey[3] - b.sortKey[3];
    });

    // Reassign into the original slots
    for (let k = 0; k < productSlots.length; k++) {
      pagePlans[productSlots[k].idx] = sortedPlans[k].plan;
    }
  }

  // Renumbering: 1-based position in the final PDF. The `i + 1` counter
  // advances for EVERY page (even those without a numbered footer, e.g. the
  // cover) → the order stays correct for numbering the other pages and the
  // contents page.
  //
  // We renumber ALL pages that have a page_number slot (original numbered
  // footer), including keep_raw identity pages. The number is rewritten in
  // the template's ORIGINAL COLOR (lbl.color: white on a dark photo, dark
  // otherwise).
  //
  // The only pitfall was the white erase block:
  //   - 'operations' page (contents, product, relocated page, light background):
  //     the old template number often differs from the new one (e.g. "104" → "6"),
  //     so a white erase is needed to cover it. Invisible on a light background.
  //   - 'keep_raw' page (identity, photo background): a white erase would make an
  //     unsightly block (and hid the white digit). We DON'T ERASE: we rewrite
  //     the number on top in its original color. These pages are not
  //     relocated (old number == new) → the overwrite is clean.
  // Never remove_text_in_bbox (it corrupted the NF vector logos during
  // GenerateContent); insert_text + GenerateContent are safe (logos intact).
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
      // How to cover the old template number (≠ new, e.g. "1" → "3"):
      //   - LIGHT number (white) ⟹ footer on a DARK background (photo). A
      //     white erase would make a conspicuous block → we REMOVE the TEXT
      //     object instead. These dark pages don't have the "NF standard"
      //     vector logos, so remove_text doesn't corrupt them.
      //   - DARK number ⟹ footer on a LIGHT background. White erase invisible;
      //     we use it (and avoid remove_text which would corrupt the NF logos
      //     in the transparency-group of light pages).
      const removeOldText = isLightColor(lbl.color);
      // Photo-background page (identity, divider): if we erase in white
      // (dark number on a LIGHT photo), we sample the background tint
      // (sample_bg) instead of a plain white → no small visible white block.
      const photoBg = cls.kind === 'identity' || cls.kind === 'intercalaire';
      // Baseline compensation: render.cpp applyOpInsertTextInsert computes
      // `baseline_pdfium = pageH - y1 + INSERT_TEXT_BASELINE_OFFSET_PT`.
      // To get the template span's EXACT baseline, we compensate here.
      const insertY1 = lbl.bbox[3] + INSERT_TEXT_BASELINE_OFFSET_PT;
      // X-start: same as the template span (= left-aligned after the "/").
      const xStart = lbl.bbox[0];
      // Estimated width of the new number for the erase (tabular-digit coef
      // = TEXT_WIDTH_COEFS.digits; ~0.6).
      const numWidth = numText.length * lbl.size * TEXT_WIDTH_COEFS.digits;
      // Anti-overflow clamp: some footers (e.g. company on Catalogue A, right-aligned)
      // have their number slot stuck to the right edge → the digit ran off the
      // page (cut off). We shift it left just enough to keep it whole.
      const pageW = cls.extracted.page_size?.width ?? 0;
      const RIGHT_MARGIN = 3;
      let insX = xStart;
      if (pageW > 0 && insX + numWidth > pageW - RIGHT_MARGIN) {
        insX = Math.max(2, pageW - RIGHT_MARGIN - numWidth);
      }
      const insXEnd = insX + numWidth + 2;
      if (removeOldText) {
        // Physically remove the old number (bbox tight on the single digit;
        // the neighboring running header is not entirely enclosed so it's
        // preserved), then insert the new one in the original color, no_erase.
        ops.push({
          op: 'remove_text_in_bbox',
          bbox: [lbl.bbox[0] - 0.5, lbl.bbox[1] - 0.5, lbl.bbox[2] + 0.5, lbl.bbox[3] + 0.5],
        });
      } else {
        // Light background: erase (covers the old number, often wider). White
        // on a product/contents page (white background); sampled tint on an
        // identity page (light photo background, e.g. NF page) to avoid a block.
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
        // no_erase: we already handled covering the old number (remove_text
        // on photo, white erase on light background); we disable insert_text's
        // internal white auto-erase (render.cpp) which would re-add a block.
        no_erase: true,
      });
    }
    // We switch to 'operations' mode as soon as we've added an insert (the
    // number must be (re)written). insert_text + GenerateContent do not
    // corrupt the logos (only remove_text_in_bbox did).
    if (ops.length > opsBefore) {
      plan.render = { mode: 'operations', operations: ops };
    }
  }

  // PASS 2 TOC: now that the page_numbers are fixed, we (re)build the
  // contents-page ops with the REAL numbers and replace the ops of the
  // placeholder inserted in PASS 1. If the build comes back empty, we remove
  // the placeholder page + re-renumber.
  if (tocPlaceholder) {
    const placeholderSet = new Set(tocPlaceholders);
    const realPagePlans = pagePlans
      .filter((pp) => !placeholderSet.has(pp))
      .map((pp) => ({ source_page: pp.source_page, page_number: pp.page_number ?? 0 }));
    // Technical-handbook computation: products with schema_path AND in
    // allocations (= actually substituted). Used to pre-allocate the
    // "Cahier technique" entry in the contents page with its final page
    // number. Tolerant normalization to avoid a too-strict sort: case +
    // whitespace + accents. Otherwise "AQUASTAR  900" misses "AQUASTAR 900".
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
    // The handbook will be inserted BEFORE the last page (back cover). At
    // PASS 2 TOC time, pagePlans.length = total page count WITHOUT the
    // handbook. The back cover is at page_number = pagePlans.length. The
    // handbook will take pages pagePlans.length to pagePlans.length + cahierPagesCount - 1.
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
      // Multi-page: there may be more or fewer pages than expected in PASS 1
      // (depending on yStep recomputed with the real pageNumbers). We adjust:
      // if the page count differs from the placeholder count, we add/remove.
      const realPages = tocResult.pages;
      // Sync the number of placeholders with realPages.length
      while (tocPlaceholders.length < realPages.length) {
        // Missing placeholders → we insert one after the last
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
        // Too many placeholders → we remove the excess from the end
        const extra = tocPlaceholders.pop()!;
        const idx = pagePlans.indexOf(extra);
        if (idx >= 0) pagePlans.splice(idx, 1);
      }
      // Assign the ops to each placeholder. For each one, MERGE with the
      // renumbering ops already present (bottom page number).
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
      // Rebuild failure: we remove ALL placeholders and re-renumber.
      for (const ph of tocPlaceholders) {
        const idx = pagePlans.indexOf(ph);
        if (idx >= 0) pagePlans.splice(idx, 1);
      }
      for (let i = 0; i < pagePlans.length; i++) {
        pagePlans[i].page_number = i + 1;
      }
    }
  }

  // Final assembly
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

  // ─── IntentPlan (BC approach) ─────────────────────────────────────────────
  // If intent-driven substitute is active, we reuse the schemas and intents
  // already built during the substitute phase. Otherwise we build them here.
  const intentSchemasBySource = new Map<number, PageSchema>();
  if (useIntentSubstitute) {
    // Schemas already built during the intent-driven substitute phase
    for (const [src, schema] of intentSchemasBySourceEarly) {
      intentSchemasBySource.set(src, schema);
    }
    // Persist plan_v2.json with the real intents
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
    // Fallback: build the schemas from the classifications
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

  // ─── C++ render ──────────────────────────────────────────────────────────
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
  // Filter out the binary's informational lines (not warnings).
  // WARNING: the BENIGN_STDERR_PREFIXES list is COUPLED to the C++ prints
  // of extract.cpp/render.cpp. If you change a C++ message, update it here
  // too, otherwise the filter lets noise through as a warning.
  // Compatibility: we accept the new forms by adding entries, not by
  // removing the old ones.
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

  // ─── Claude → IntentOps → re-render loop (BC approach) ──────────────────
  // After the 1st render, we ask Claude vision for corrections (IntentOps)
  // on a sample of substituted pages, resolve them into Operations and
  // re-render. Iterative (max 2 by default), stops as soon as a pass produces
  // no more intents.
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

  // ─── Technical handbook: 2x3 grid of schematics before the last page ─────
  // For each product WITH a matched schema_path AND actually allocated
  // in the PDF (= present in a substituted product page), we add its
  // schematic to a 6-per-page grid inserted JUST BEFORE the last page (back
  // cover). An entry is also added to the contents page.
  try {
    // Set of the products actually used in the final PDF.
    // Tolerant normalization (NFKD + diacritics + ws + lowercase) to
    // avoid a too-strict sort on the handbook side (case "AQUASTAR  900"
    // vs "AQUASTAR 900", heterogeneous accents/case XLSX vs allocations).
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
    // Page number (1-based) of the contents page in the final PDF, from pagePlans
    let tocFinalPageNumber: number | undefined;
    if (tocSourcePage != null) {
      const tocPlan = pagePlans.find((pp) => pp.source_page === tocSourcePage);
      if (tocPlan && typeof tocPlan.page_number === 'number') {
        tocFinalPageNumber = tocPlan.page_number;
      }
    }
    const cahierRes = await appendCahiersTechniques(opts.outPdfPath, opts.products, {
      allocatedProductNames: allocatedNames,
      // No tocFinalPageNumber: the contents entry is added directly by
      // buildTocFromTemplate via extraEntries (native contents-page style).
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

  // ─── Final visual audit (Claude vision) ──────────────────────────────────
  // Disabled by default (cf. enableVisualAudit in EngineOrchestratorOptions).
  // To reactivate: pass { enableVisualAudit: true } at the call site.
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

  // Gemini audit issues (visual + coherence) collected in a structured way
  // for the "pages to review" UI (human proofreading safeguard).
  const geminiAuditIssues: GeminiAuditIssue[] = [];

  // ─── Gemini Vision audit (alternative + stackable with Claude) ──────────
  // Free tier, no auth expiration. Detects per-page visual bugs
  // (overflow, overlap, cropped, mismatch).
  // Default true: Gemini is free, graceful fallback if no key.
  // Explicitly set enableGeminiAudit: false to disable.
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
        projectDir: opts.projectDir, // enables the audit cache
      });
      if (gem.ran) {
        const crit = gem.issues.filter((i) => i.severity === 'critical').length;
        const minor = gem.issues.length - crit;
        warnings.push(
          `audit Gemini : ${gem.issues.length} issue(s) (${crit} critical, ${minor} minor) sur ${gem.sampledPages.length} page(s) en ${gem.durationMs}ms`,
        );
        for (const issue of gem.issues) {
          // Structured collection (for the "pages to review" UI), all severities.
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

  // ─── Gemini global coherence audit (cross-page) ──────────────────────────
  // Detects inter-page inconsistencies: typo / colors / hierarchy /
  // alignments / pagination / contents-page mismatch. A single Pro Vision batch call.
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

  // Gemini stats for THIS generation (delta since the initial mark).
  // If Gemini was used: recap warning with calls / cache hits / errors.
  const geminiDelta = statsSince(geminiStatsMark);
  if (geminiDelta.totalCalls > 0) {
    warnings.push(formatAggregate(geminiDelta));
  }
  // QUOTA notification: if the API hit its rate limit (429) and/or switched to
  // the fallback (Pro subscription CLI / Claude), we emit a DEDICATED warning
  // that the UI detects (prefix "Quota Gemini") to show a clear notification.
  // The rendering is NOT affected (the fallback took over).
  const calls429 = geminiDelta.errorBreakdown[429] ?? 0;
  if (calls429 > 0 || geminiDelta.fallbacksUsed > 0) {
    // The Gemini CLI is abandoned: the relay is now the CASCADE of API
    // models (3.1-flash-lite → flash → … → Gemma), then Claude as the last resort.
    const modelsUsed = Object.keys(geminiDelta.byModel).join(', ') || 'cascade';
    warnings.push(
      `Quota Gemini atteint (${calls429}× 429, ${geminiDelta.fallbacksUsed} bascule(s) de modele) — `
        + `relais automatique via la cascade (${modelsUsed}). Rendu non impacte.`,
    );
  }
  // If any Gemini circuits opened during this run: warn.
  // The breaker auto-resets after 5min, so this is purely informational.
  const { getCircuitState } = await import('./gemini/circuitBreaker');
  const cbState = getCircuitState();
  const openCircuits = Object.entries(cbState).filter(([, v]) => v.open);
  if (openCircuits.length > 0) {
    const list = openCircuits.map(([k]) => k).join(', ');
    warnings.push(`Gemini circuits ouverts (quota epuise, retest auto 5min) : ${list}`);
  }

  // Quick win audit: promote Claude auth failures from claudeNotes to
  // user warnings. A single occurrence (dedup).
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

/** Hash of a page's text content (concat of 20 non-empty spans sorted by
 *  top-down/left-right position). Used to detect visual duplications
 *  (e.g. recto-verso printing). Sorting by bbox makes the hash deterministic
 *  even if the PDFium traversal order varies across FORM XObjects. */
export function pageContentHash(page: ExtractedPage): string {
  const spans = (page.raw_spans ?? []).filter((s) => s.text.trim().length > 0);
  spans.sort((a, b) => {
    // y0 (top) then x0 (left); 0.5pt tolerance on y to avoid shuffling
    // between spans aligned on the baseline but slightly offset.
    if (Math.abs(a.bbox[1] - b.bbox[1]) > 0.5) return a.bbox[1] - b.bbox[1];
    return a.bbox[0] - b.bbox[0];
  });
  return spans
    .slice(0, 20)
    .map((s) => s.text.trim())
    .join('|');
}

/**
 * Dedup ribbons by Y row (horizontal) or X column (vertical) with an
 * anti-GIANT-UNION safeguard.
 *
 * On Catalogue C / Catalogue B, the 2 spans "POMPES D'ÉVACUATION" + "EAUX CLAIRES"
 * are consecutive on the same Y line, with no X-overlap. We merge them into 1
 * UNION bbox to fully erase the template text.
 *
 * Safeguard (review flaw): we reject the merge if the union exceeds 70%
 * of the page dimension (W for horiz, H for vert) — otherwise 2 distinct
 * ribbons on the left+right would merge into a full-page rectangle.
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

/** Detects whether the claudeNotes contain a sign of expired auth.
 *  Promoted to a user warning (audit flaw: a note is less visible). */
export function detectClaudeAuthFailure(claudeNotes: string[]): boolean {
  return claudeNotes.some((n) =>
    /auth\s+expir|claude\s+login|401|authentication_error|Invalid\s+authentication/i.test(n),
  );
}

/**
 * Computes the divider guard zones (start/end of the catalog)
 * adaptively based on the total page count.
 *
 * Review flaw: a fixed threshold of 5 broke on mini-catalogs (8 pages =
 * 100% protected, nothing left usable) and under-covered mega-catalogs
 * (200 pages = only 2.5% protected).
 *
 * Strategy:
 *   - mini (< 12 pages): 1 + 1 (cover + back cover minimum)
 *   - standard (12-50 pages): 5 + 5 (legacy)
 *   - mega (> 50 pages): 5% of the pages capped at 10
 *
 * Invariant: intro + outro < totalPages (at least 1 page in the middle must
 * stay usable for substitution).
 */
export function computeIntercalaireGuardZones(totalPages: number): {
  intro: number;
  outro: number;
} {
  // Safeguard for degenerate catalogs (audit flaw: documented invariant
  // violated for totalPages <= 2). In practice the orchestrator early-returns
  // upstream but we protect here too.
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
  // P0.5: Promise.all parallelizes the readFile calls (~50% gain on NFS /
  // Docker mounted volumes). We keep the order via Promise.all (which
  // preserves the promise order), not via a sequential reduce.
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

/** Failure helper for when the pipeline crashes BEFORE extract (= no phase
 *  was measured). Returns an EngineOrchestratorResult with zeroed stats. */
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

// ─── BC: IntentPlan helpers ─────────────────────────────────────────────────

/** Builds an informational IntentPlan from the allocations + classifications.
 *  Does NOT contain IntentOps (the pipeline does not generate any yet) — just
 *  the page schemas, which the resolver and Claude use to target zones
 *  precisely. */
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
