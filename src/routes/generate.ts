import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { extract } from '../services/extractors';
import { buildProductInputs, splitMultiValue } from '../services/productsAdapter';
import { substituteCatalogEngine } from '../v2/engineOrchestrator';
import { clearProgress, getProgress, markDone, markError, setProgress } from '../v2/progressTracker';
import { signedUrl } from './downloadToken';
import { requireAuth, isAuthorized } from '../middleware/auth';
import { errorBody, failMessage, isProd } from '../middleware/httpError';
import type { ExtractedFile, FileCategory, ProductInput } from '../types';
import type { PlanProduct } from '../v2/types';

/** Adapts a ProductInput (productsAdapter output) into the PlanProduct
 *  expected by the V2 engine. Specs (key,value) become (key, values[]), and
 *  the named variants are mapped onto generic color variants. */
function adaptProductInput(p: ProductInput): PlanProduct {
  // Sanitize image_path: block path traversal only. Absolute paths are
  // legitimate here (productsAdapter assigns matched.absPath = a file already
  // extracted into workDir/assets/); forbidding startsWith('/') would kill
  // every image.
  let imgPath = p.image_path ?? null;
  if (imgPath && imgPath.includes('..')) {
    imgPath = null;
  }
  let schPath: string | null = p.schema_path ?? null;
  if (schPath && schPath.includes('..')) {
    schPath = null;
  }
  return {
    name: p.name,
    ref: p.ref ?? null,
    color: p.color ?? null,
    image_path: imgPath,
    specs: (p.specs ?? []).map((s) => {
      const splitted = splitMultiValue(s.value);
      return {
        key: s.key,
        // Keep at least 1 element to preserve the key even if all values
        // are filtered out (non-informative). The downstream pipeline
        // handles an empty values[0].
        values: splitted.length > 0 ? splitted : [s.value],
      };
    }),
    variants: (p.variantes ?? []).map((v) => ({
      color: '#cccccc',
      label: v.name,
    })),
    section: p.section ?? null,
    family: p.family ?? null,
    subFamily: p.subFamily ?? null,
    schema_path: schPath,
  };
}

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MAX_TOTAL_SIZE = 1024 * 1024 * 1024;

/** Sanitizes a client file name: strips path separators, control chars,
 *  non-printable parentheses. Keeps letters/digits/underscore/hyphen/dot/space. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.{2,}/g, '_')
    .trim();
  return cleaned.slice(0, 200) || 'file';
}

const storage = multer.diskStorage({
  destination: path.resolve('uploads'),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}-${sanitizeFilename(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 10,
    fields: 20,
  },
});
const CATEGORIES: FileCategory[] = ['template', 'data', 'assets'];
const GEN_DIR = path.resolve('generated');
const PROJECT_DIR = path.resolve('.');

async function cleanupFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => fs.rm(p, { force: true, recursive: true }).catch(() => {})));
}

/** Reject before any parsing if Content-Length exceeds the global cap.
 *  As a backup: if Content-Length is absent, we track received bytes while
 *  streaming and cut the connection past the threshold (defense in depth). */
function enforceTotalSize(req: Request, res: Response, next: NextFunction): void {
  const lenHeader = req.headers['content-length'];
  if (lenHeader !== undefined) {
    const len = Number(lenHeader);
    if (!Number.isFinite(len) || len < 0) {
      res.status(400).json({ error: 'Content-Length invalide' });
      return;
    }
    if (len > MAX_TOTAL_SIZE) {
      res.status(413).json({
        error: `Requete trop volumineuse (max ${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
      });
      return;
    }
  }
  // Header absent -> enforce while streaming (chunked transfer-encoding).
  // P0.2 fix: we destroy BEFORE multer reads a single byte. Otherwise
  // multer attaches its own 'data' listener and may write the whole thing
  // to disk before we cut it off. We pause() immediately and then check
  // on resume().
  let received = 0;
  let killed = false;
  req.on('data', (chunk: Buffer): void => {
    if (killed) return;
    received += chunk.length;
    if (received > MAX_TOTAL_SIZE) {
      killed = true;
      // pause + removeAll listeners to stop multer from consuming the rest
      // of the stream to disk.
      req.pause();
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      if (!res.headersSent) {
        res.status(413).json({
          error: `Requete trop volumineuse en streaming (max ${Math.round(MAX_TOTAL_SIZE / 1024 / 1024)} MB)`,
        });
      }
      req.destroy();
    }
  });
  next();
}

export const generateRouter: Router = Router();

/** GET /api/estimate?products=N&descriptions=true
 *  Returns an ETA in ms with a ±25% range, calibrated on the meta.json of the
 *  latest generations (linear model: base + perProduct). Honest by design: if
 *  fewer than 3 samples → "default" + conservative values, otherwise
 *  "calibrated" + N samples.
 */
generateRouter.get('/estimate', async (req, res) => {
  try {
    const { estimateGenerationDuration } = await import('../v2/estimator');
    const productsCount = Math.max(0, Number(req.query.products ?? 0));
    const withDescriptions = String(req.query.descriptions ?? 'true') === 'true';
    const result = await estimateGenerationDuration({ productsCount, withDescriptions });
    res.json(result);
  } catch (err) {
    res.status(500).json(
      errorBody('estimation indisponible', { detail: err instanceof Error ? err.message : String(err) }),
    );
  }
});

/** GET /api/gemini/health
 *  Checks Gemini's state: key, quota, accessibility. Returns a status that lets
 *  the UI show a "Gemini OK/KO" badge. Minimal call (1 token), so the cost is
 *  negligible.
 */
generateRouter.get('/gemini/health', async (_req, res) => {
  try {
    const { checkGeminiHealth } = await import('../v2/gemini/health');
    const result = await checkGeminiHealth();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      status: 'unknown',
      hint: 'Erreur interne lors du check Gemini.',
      ...(isProd() ? {} : { error: err instanceof Error ? err.message : String(err) }),
    });
  }
});

/** GET /api/gemini/stats
 *  Cumulative Gemini usage stats (in-memory, reset on server boot).
 *  Useful for debugging / monitoring the cache hit ratio + errors.
 *
 *  Optional query ?reset=1 → clears the stats before returning.
 */
generateRouter.get('/gemini/stats', async (req, res) => {
  try {
    const { getStats, resetStats, formatStats, getRecentRecords } = await import('../v2/gemini/stats');
    if (req.query.reset === '1') {
      if (!isAuthorized(req)) {
        res.status(401).json({ error: 'Authentification requise pour reset.' });
        return;
      }
      resetStats();
    }
    res.json({
      summary: getStats(),
      formatted: formatStats(),
      recentCalls: getRecentRecords(20),
    });
  } catch (err) {
    res.status(500).json(
      errorBody('Erreur interne.', { detail: err instanceof Error ? err.message : String(err) }),
    );
  }
});

/** GET /api/gemini/circuit
 *  State of the Gemini circuit breakers (per module + model). Indicates which
 *  modules are temporarily tripped after 3 consecutive 429s. Auto-resets after
 *  5 min or via ?reset=1.
 */
generateRouter.get('/gemini/circuit', async (req, res) => {
  try {
    const { getCircuitState, resetCircuit } = await import('../v2/gemini/circuitBreaker');
    if (req.query.reset === '1') {
      if (!isAuthorized(req)) {
        res.status(401).json({ error: 'Authentification requise pour reset.' });
        return;
      }
      resetCircuit();
    }
    res.json({ state: getCircuitState() });
  } catch (err) {
    res.status(500).json(
      errorBody('Erreur interne.', { detail: err instanceof Error ? err.message : String(err) }),
    );
  }
});

/** GET /api/gemini
 *  Umbrella endpoint: returns health + stats + circuit state in a single
 *  call. Handy for a dashboard UI to avoid 3 round-trips.
 */
generateRouter.get('/gemini', async (_req, res) => {
  try {
    const [{ quickCheckGeminiKey }, { getStats, formatStats }, { getCircuitState }] = await Promise.all([
      import('../v2/gemini/health'),
      import('../v2/gemini/stats'),
      import('../v2/gemini/circuitBreaker'),
    ]);
    const [keyCheck, stats] = await Promise.all([
      quickCheckGeminiKey(),
      Promise.resolve(getStats()),
    ]);
    res.json({
      keyPresent: keyCheck.keyPresent,
      stats,
      formatted: formatStats(),
      circuit: getCircuitState(),
    });
  } catch (err) {
    res.status(500).json(
      errorBody('Erreur interne.', { detail: err instanceof Error ? err.message : String(err) }),
    );
  }
});

/** GET /api/gemini/smoke
 *  Quick smoke test of the Gemini modules on synthetic data. Useful to
 *  validate end-to-end that the key is OK and that each module returns
 *  something coherent. Skips the Vision modules (they need a rasterized PDF) —
 *  JSON only.
 *
 *  Modules tested: smartMapping, specNormalizer, imageMatcher, descriptions.
 *  Typical duration: 4-8s.
 */
generateRouter.get('/gemini/smoke', requireAuth, async (_req, res) => {
  try {
    const { isGeminiAvailable } = await import('../v2/gemini/client');
    if (!(await isGeminiAvailable())) {
      res.status(503).json({ ok: false, error: 'GEMINI_KEY absente' });
      return;
    }

    const t0 = Date.now();
    const results: Record<string, { ok: boolean; durationMs: number; sample?: unknown; error?: string }> = {};

    // 1. smartMapping
    try {
      const { geminiColumnMap } = await import('../v2/gemini/smartMapping');
      const t = Date.now();
      const r = await geminiColumnMap({
        headers: ['Code Produit', 'Designation Produit', 'Libelle SFamille', 'Libelle Famille', 'Coloris'],
        sampleRows: [{ 'Code Produit': 'AB123', 'Designation Produit': 'Mitigeur Eole' }],
        heuristic: {},
      });
      results.smartMapping = { ok: r.ran && !!r.mapping?.name, durationMs: Date.now() - t, sample: r.mapping };
    } catch (e) {
      results.smartMapping = { ok: false, durationMs: 0, error: (e as Error).message };
    }

    // 2. specNormalizer
    try {
      const { geminiNormalizeSpecs } = await import('../v2/gemini/specNormalizer');
      const t = Date.now();
      const r = await geminiNormalizeSpecs({
        productKeys: ['Largo_bras', 'Material_principal'],
        templateKeys: ['LONGUEUR :', 'MATIERE :', 'PUISSANCE :'],
      });
      results.specNormalizer = { ok: r.ran, durationMs: Date.now() - t, sample: r.mapping };
    } catch (e) {
      results.specNormalizer = { ok: false, durationMs: 0, error: (e as Error).message };
    }

    // 3. imageMatcher
    try {
      const { geminiMatchAssets } = await import('../v2/gemini/imageMatcher');
      const t = Date.now();
      const r = await geminiMatchAssets({
        unmatchedProducts: [{ idx: 0, name: 'AQUASTAR 900', ref: '002236' }],
        assets: [
          { baseName: 'img_002236', absPath: '/a/img_002236.png' },
          { baseName: 'unrelated', absPath: '/a/unrelated.png' },
        ],
      });
      results.imageMatcher = { ok: r.ran && r.matched.length > 0, durationMs: Date.now() - t, sample: r.matched };
    } catch (e) {
      results.imageMatcher = { ok: false, durationMs: 0, error: (e as Error).message };
    }

    // 4. descriptions
    try {
      const { generateDescriptionsGemini } = await import('../v2/gemini/descriptions');
      const t = Date.now();
      const r = await generateDescriptionsGemini({
        sections: [{
          label: 'MITIGEURS',
          products: [{ name: 'Mitigeur Eole', ref: 'EOL', color: null, image_path: null, specs: [{ key: 'MATIERE :', values: ['Laiton'] }], variants: [] }],
        }],
      });
      results.descriptions = { ok: r.ran && Object.keys(r.descriptions).length > 0, durationMs: Date.now() - t, sample: r.descriptions };
    } catch (e) {
      results.descriptions = { ok: false, durationMs: 0, error: (e as Error).message };
    }

    // 5. intentParser (phase 2 intent loop)
    try {
      const { parseStructuredIntents } = await import('../v2/gemini/intentParser');
      const t = Date.now();
      const r = await parseStructuredIntents({
        suggestions: [
          {
            finalPageNumber: 1,
            issueDescription: 'test',
            intent: 'Décaler le titre de 4pt vers la droite.',
            confidence: 0.8,
          },
        ],
      });
      results.intentParser = { ok: r.ran && r.structured.length > 0, durationMs: Date.now() - t, sample: r.structured };
    } catch (e) {
      results.intentParser = { ok: false, durationMs: 0, error: (e as Error).message };
    }

    const allOk = Object.values(results).every((r) => r.ok);
    res.json({
      ok: allOk,
      totalDurationMs: Date.now() - t0,
      modules: results,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      ...errorBody('Smoke Gemini en échec', { detail: err instanceof Error ? err.message : String(err) }),
    });
  }
});

/** POST /api/layout
 *  LAYOUT GEN mode (parallel to /generate): composes a catalog from scratch
 *  via Gemini Pro (HTML/CSS → Chromium PDF), WITHOUT a PDF template. Inputs:
 *  data (xlsx/csv) + assets (zip). Query ?perPage=N (default 3).
 *
 *  WARNING: slow (Pro ~30-45s/page). Experimental opt-in mode.
 */
generateRouter.post('/layout', requireAuth, enforceTotalSize, upload.any(), async (req, res) => {
  res.setTimeout(20 * 60 * 1000); // Pro is slow: generous margin
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) {
    res.status(400).json({ error: 'Aucun fichier fourni (data + assets attendus)' });
    return;
  }
  const uploadedPaths = files.map((f) => f.path);
  const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const pdfName = `layout_${stamp}.pdf`;
  const outPdf = path.join(GEN_DIR, pdfName);
  const workDir = path.join(GEN_DIR, `_${stamp}_layout`);

  try {
    const extracted: ExtractedFile[] = await Promise.all(
      files.map((f) => {
        const category: FileCategory = CATEGORIES.includes(f.fieldname as FileCategory)
          ? (f.fieldname as FileCategory)
          : 'data';
        return extract(f, category);
      }),
    );
    await fs.mkdir(GEN_DIR, { recursive: true });
    const built = await buildProductInputs(extracted, workDir, { projectDir: PROJECT_DIR });
    if (!built.products.length) {
      await cleanupFiles(uploadedPaths);
      res.status(400).json({ error: 'Aucun produit detectable dans les fichiers data', adapterWarnings: built.warnings });
      return;
    }
    const { generateCatalogLayout } = await import('../v2/layout/layoutOrchestrator');
    const perPage = Math.max(1, Math.min(6, Number(req.query.perPage) || 3));
    const result = await generateCatalogLayout({
      products: built.products.map(adaptProductInput),
      assetsDir: path.join(workDir, 'assets'),
      productsPerPage: perPage,
      accentColor: typeof req.query.accent === 'string' ? req.query.accent : undefined,
      workDir: path.join(workDir, 'layout'),
      outPdfPath: outPdf,
    });
    await cleanupFiles(uploadedPaths);
    if (!result.ok) {
      // notes = orchestrator detail (internal paths/errors) → hidden in prod.
      res.status(500).json(errorBody('Echec layout gen', { debug: { notes: result.notes } }));
      return;
    }
    res.json({
      pdfName,
      catalogUrl: signedUrl(pdfName),
      pageCount: result.pageCount,
      productCount: built.products.length,
      durationMs: result.durationMs,
      adapterWarnings: built.warnings,
      ...(isProd() ? {} : { notes: result.notes }),
    });
  } catch (err) {
    await cleanupFiles(uploadedPaths);
    res.status(500).json({ error: failMessage('Echec layout', err) });
  }
});

generateRouter.post('/generate', enforceTotalSize, upload.any(), async (req, res) => {
  // R5 audit: global server-side timeout (30 min). Past that, Express will
  // cut the connection even if a sub-process is still running. Prevents a
  // runaway generation from blocking a client indefinitely.
  res.setTimeout(30 * 60 * 1000);
  const totalStartMs = Date.now();

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) {
    res.status(400).json({ error: 'Aucun fichier fourni' });
    return;
  }
  const uploadedPaths = files.map((f) => f.path);
  // Stamp with a random suffix: avoids fs-path collisions if 2 requests
  // arrive in the same millisecond (identical workDir / outPdf otherwise).
  const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  // jobId for the progress tracker: passed as a QUERY STRING by the client
  // (POST /api/generate?jobId=xxx) so we can read it BEFORE multer parses the
  // files. If absent/invalid or already active in the tracker (a rare but
  // possible UUID v4 collision), we add a suffix to guarantee uniqueness. The
  // client polls its original jobId: if we had to add a suffix, its progress
  // bar won't work but the pipeline runs normally.
  const rawJobId = typeof req.query?.jobId === 'string' ? req.query.jobId : '';
  let jobId = /^[a-zA-Z0-9_-]{1,64}$/.test(rawJobId) ? rawJobId : stamp;
  const existing = getProgress(jobId);
  if (existing && !existing.done) {
    jobId = `${jobId}_${randomBytes(2).toString('hex')}`;
  }
  setProgress(jobId, 'upload', 3, 'Réception des fichiers…');
  const pdfName = `catalog_${stamp}.pdf`;
  const outPdf = path.join(GEN_DIR, pdfName);
  const workDir = path.join(GEN_DIR, `_${stamp}_work`);

  let extracted: ExtractedFile[];
  try {
    extracted = await Promise.all(
      files.map((f) => {
        const category: FileCategory = CATEGORIES.includes(f.fieldname as FileCategory)
          ? (f.fieldname as FileCategory)
          : 'data';
        return extract(f, category);
      }),
    );
  } catch (err) {
    await cleanupFiles(uploadedPaths);
    const msg = failMessage('Echec extraction', err);
    markError(jobId, msg);
    res.status(500).json({ error: msg });
    return;
  }

  const rejectedFiles = extracted
    .filter((f) => f.kind === 'unknown')
    .map((f) => ({
      name: f.originalName,
      reason: (f.extracted as { note?: string }).note ?? 'inconnu',
    }));

  const templateFile = extracted.find((f) => f.category === 'template' && f.kind === 'pdf');
  if (!templateFile) {
    await cleanupFiles(uploadedPaths);
    markError(jobId, 'Aucun PDF template fourni');
    res.status(400).json({
      error: 'Aucun PDF template fourni dans la zone "template"',
      rejectedFiles,
    });
    return;
  }

  try {
    await fs.mkdir(GEN_DIR, { recursive: true });
  } catch (err) {
    await cleanupFiles(uploadedPaths);
    const msg = failMessage('Echec creation repertoire de sortie', err);
    markError(jobId, msg);
    res.status(500).json({ error: msg });
    return;
  }

  setProgress(jobId, 'parse', 5, 'Lecture de la base produits…');
  let built;
  try {
    // V2: no templateConfig (the business patterns live in the Skill).
    // projectDir: exposes .claude/skills to the Claude CLI (smart mapping).
    built = await buildProductInputs(extracted, workDir, {
      projectDir: PROJECT_DIR,
      // Smart column mapping via Gemini (fallback when the heuristic has
      // gaps). ON by default; ?enrich=0 for deterministic mapping only.
      enableSmartMapping: req.query?.enrich !== '0',
    });
  } catch (err) {
    await cleanupFiles([...uploadedPaths, workDir]);
    const msg = failMessage('Echec preparation des produits', err);
    markError(jobId, msg);
    res.status(500).json({ error: msg, rejectedFiles });
    return;
  }
  if (!built.products.length) {
    await cleanupFiles([...uploadedPaths, workDir]);
    markError(jobId, 'Aucun produit detectable');
    res.status(400).json({
      error: 'Aucun produit detectable dans les fichiers data (CSV/XLSX). '
        + 'Verifie que le fichier contient au moins une ligne avec une colonne '
        + 'nom (ex "Designation Produit", "Nom", "Produit").',
      rejectedFiles,
      adapterWarnings: built.warnings,
    });
    return;
  }
  const products = built.products;

  // Extra upfront validation: products without a name, duplicate refs, empty
  // sections. We warn (not error) because the pipeline handles it but the
  // user wants to know before rendering.
  const upfrontWarnings: string[] = [];
  const productsWithoutName = products.filter((p) => !p.name?.trim()).length;
  if (productsWithoutName > 0) {
    upfrontWarnings.push(
      `${productsWithoutName} produit(s) sans nom — seront rendus "Produit N".`,
    );
  }
  const refCounts = new Map<string, number>();
  for (const p of products) {
    if (!p.ref) continue;
    refCounts.set(p.ref, (refCounts.get(p.ref) ?? 0) + 1);
  }
  const dupRefs = [...refCounts.entries()].filter(([, n]) => n > 1).map(([r]) => r);
  if (dupRefs.length > 0) {
    upfrontWarnings.push(
      `Refs dupliquees : ${dupRefs.slice(0, 5).join(', ')}`
        + (dupRefs.length > 5 ? ` (+${dupRefs.length - 5} autres)` : ''),
    );
  }
  built.warnings.push(...upfrontWarnings);

  let result;
  try {
    result = await substituteCatalogEngine({
      templatePdfPath: templateFile.storedPath,
      products: products.map(adaptProductInput),
      assetsDir: path.join(workDir, 'assets'),
      jobId: stamp,
      workDir,
      outPdfPath: outPdf,
      projectDir: PROJECT_DIR,
      // BC_test branch: intent-driven substitute by default. The pipeline
      // generates IntentOps from the product data → resolve → Operations.
      // Override with query ?intent=0 to fall back to the legacy substitutor.
      enableIntentPlan: req.query?.intent !== '0',
      // Claude → IntentOps → re-render loop: DISABLED by default. Too costly
      // (~6 min of Claude Sonnet vision over 2 passes) for a marginal visual
      // gain. Enable with query ?intent_loop=1 if needed.
      enableIntentLoop: req.query?.intent_loop === '1',
      // Global coherence audit (CLI Pro Vision, cross-page). Opt-in via
      // ?coherence=1: a proofreading safeguard (typo/alignment/pagination/
      // table-of-contents across pages). ~45s extra but feeds "pages to check".
      enableGeminiCoherenceAudit: req.query?.coherence === '1',
      // ── Auxiliary LLM tasks: ON by default (we KEEP descriptions, audit,
      //    spec enrichment). The past slowness came from a dead QUOTA (90s
      //    retries + slow Pro CLI as fallback), NOT the features → fixed by
      //    fail-fast (client MAX_RETRY_DELAY_MS=8s + CLI-less router in 'speed'):
      //    on a dead quota the task skips quickly instead of blocking for minutes.
      //    Opt out with ?audit=0 / ?descriptions=0 / ?enrich=0 for an ultra-fast gen.
      enableGeminiAudit: req.query?.audit !== '0',
      enableGeminiDescriptions: req.query?.descriptions !== '0',
      enableSpecNormalization: req.query?.enrich !== '0',
      enableValueFormatting: req.query?.enrich !== '0',
      onProgress: (phase, pct, message) => setProgress(jobId, phase, pct, message),
    });
  } catch (err) {
    await cleanupFiles([...uploadedPaths, workDir, outPdf]);
    const msg = failMessage('Echec moteur V2', err);
    markError(jobId, msg);
    res.status(500).json({ error: msg, rejectedFiles });
    return;
  }
  if (!result.ok) {
    await cleanupFiles([...uploadedPaths, workDir, outPdf]);
    // User-friendly error: we take the first reason among the
    // orchestratorErrors and map it to a clear message. The technical detail
    // stays in orchestratorErrors for debugging.
    const errMsg = result.errors[0] ?? '';
    let userError = 'Echec generation du catalogue.';
    if (/PDF vide|extracteur plante|extract failed/i.test(errMsg)) {
      userError = 'Le PDF template est illisible ou corrompu.';
    } else if (/aucun produit/i.test(errMsg)) {
      userError = "Aucun produit detectable dans les fichiers data.";
    } else if (/profile.*fallback/i.test(errMsg)) {
      userError = 'Le template ne correspond pas au format attendu (pas de specs structurees).';
    } else if (/render failed/i.test(errMsg)) {
      userError = 'Echec du rendu PDF final.';
    }
    markError(jobId, userError);
    res.status(500).json({
      error: userError,
      rejectedFiles,
      adapterWarnings: built.warnings,
      stats: result.stats,
      // Technical detail (internal paths, orchestrator errors) hidden in prod.
      ...(isProd()
        ? {}
        : {
            details: errMsg,
            orchestratorErrors: result.errors,
            orchestratorWarnings: result.warnings,
          }),
    });
    return;
  }

  const totalDurationMs = Date.now() - totalStartMs;
  const payload = {
    pdfName,
    catalogUrl: signedUrl(pdfName),
    stamp,
    productCount: products.length,
    matchedImageCount: built.matchedImageCount,
    /** Total endpoint duration measured server-side (multer + parsing + engine
     *  + render + file writes). Feeds the estimator (more reliable than the
     *  sum of the phase stats, which systematically underestimates). */
    totalDurationMs,
    stats: result.stats,
    warnings: result.warnings,
    rejectedFiles,
    adapterWarnings: built.warnings,
    visualAuditIssues: result.visualAuditIssues,
    geminiAuditIssues: result.geminiAuditIssues,
    geminiUsage: result.geminiUsage,
    claudeNotes: result.claudeNotes,
  };

  const uploadedFiles = extracted.map((f) => path.basename(f.storedPath));
  const metaPath = path.join(GEN_DIR, `catalog_${stamp}.meta.json`);
  try {
    await fs.writeFile(
      metaPath,
      JSON.stringify({ ...payload, uploadedFiles, createdAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {
    // non-fatal
  }

  // P1 fix: also clean up the multer uploads on the success path (the
  // error paths already did). Otherwise files accumulate indefinitely
  // in uploads/.
  await cleanupFiles([...uploadedPaths, workDir]);

  markDone(jobId, 'Terminé');
  // The client reads done=true on its next poll then closes the EventSource.
  // We keep the entry for 60s to let the last poll through, then clean up.
  setTimeout(() => clearProgress(jobId), 60 * 1000).unref();
  res.json(payload);
});
