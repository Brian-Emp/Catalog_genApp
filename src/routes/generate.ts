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
import type { ExtractedFile, FileCategory, ProductInput } from '../types';
import type { PlanProduct } from '../v2/types';

/** Adapte un ProductInput (sortie productsAdapter) en PlanProduct attendu
 *  par le moteur engine V2. Les specs (key,value) deviennent (key, values[]),
 *  les variantes nominales sont mappees en variants couleur generique. */
function adaptProductInput(p: ProductInput): PlanProduct {
  // Sanitize image_path : bloquer path traversal seulement. Les chemins
  // absolus sont legitimes ici (productsAdapter assigne matched.absPath
  // = fichier deja extracted dans workDir/assets/), interdire startsWith('/')
  // tuait toutes les images.
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
        // Garde au moins 1 element pour preserver la key meme si toutes
        // les values sont filtrees (non-informatives). Le pipeline aval
        // gere les values[0] vide.
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

/** Sanitize un nom de fichier client : retire path separators, control chars,
 *  parentheses non-imprimables. Garde lettres/chiffres/underscore/tiret/point/space. */
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

/** Reject avant tout parsing si Content-Length depasse le plafond global.
 *  En backup : si Content-Length absent, on track les bytes recus en streaming
 *  et on coupe la connexion au-dela du seuil (defense en profondeur). */
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
  // Header absent -> on enforce en stream (chunked transfer-encoding).
  // P0.2 fix : on destroy AVANT que multer ne lise un seul byte. Sinon
  // multer rattache son propre 'data' listener et peut ecrire la totalite
  // sur disque avant qu'on ne coupe. On fait pause() immediat puis on
  // verifie au resume().
  let received = 0;
  let killed = false;
  req.on('data', (chunk: Buffer): void => {
    if (killed) return;
    received += chunk.length;
    if (received > MAX_TOTAL_SIZE) {
      killed = true;
      // pause + removeAll listeners pour empecher multer de consommer la
      // suite du stream sur disque.
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
 *  Retourne une ETA en ms avec fourchette ±25%, calibree sur les meta.json
 *  des dernieres generations (modele lineaire base + perProduct). Honnete
 *  par construction : si moins de 3 echantillons → "default" + valeurs
 *  conservatrices, sinon "calibrated" + N samples.
 */
generateRouter.get('/estimate', async (req, res) => {
  try {
    const { estimateGenerationDuration } = await import('../v2/estimator');
    const productsCount = Math.max(0, Number(req.query.products ?? 0));
    const withDescriptions = String(req.query.descriptions ?? 'true') === 'true';
    const result = await estimateGenerationDuration({ productsCount, withDescriptions });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: 'estimation indisponible',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

/** GET /api/gemini/health
 *  Verifie l'etat de Gemini : cle, quota, accessibilite. Retourne un statut
 *  permettant a l'UI d'afficher un badge "Gemini OK/KO". Appel minimal (1
 *  token) donc cout negligeable.
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
      error: err instanceof Error ? err.message : String(err),
      hint: 'Erreur interne lors du check Gemini.',
    });
  }
});

/** GET /api/gemini/stats
 *  Stats d'usage Gemini cumulees (en-memory, reset au boot serveur).
 *  Utile pour debug / monitoring du cache hit ratio + erreurs.
 *
 *  Query optionnelle ?reset=1 → vide les stats avant de retourner.
 */
generateRouter.get('/gemini/stats', async (req, res) => {
  try {
    const { getStats, resetStats, formatStats, getRecentRecords } = await import('../v2/gemini/stats');
    if (req.query.reset === '1') resetStats();
    res.json({
      summary: getStats(),
      formatted: formatStats(),
      recentCalls: getRecentRecords(20),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** GET /api/gemini/circuit
 *  Etat des circuits breakers Gemini (par module + model). Indique quels
 *  modules sont temporairement coupes apres 3 x 429 consecutifs. Auto-reset
 *  apres 5min ou via ?reset=1.
 */
generateRouter.get('/gemini/circuit', async (req, res) => {
  try {
    const { getCircuitState, resetCircuit } = await import('../v2/gemini/circuitBreaker');
    if (req.query.reset === '1') resetCircuit();
    res.json({ state: getCircuitState() });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** GET /api/gemini
 *  Endpoint umbrella : retourne health + stats + circuit state en un seul
 *  call. Utile pour UI dashboard pour eviter 3 round-trips.
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
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** GET /api/gemini/smoke
 *  Smoke test rapide des modules Gemini sur des donnees synthetiques.
 *  Utile pour valider end-to-end que la cle est OK et que chaque module
 *  retourne quelque chose de coherent. Skipe les modules Vision (besoin
 *  d'un PDF rasterise) — focus JSON only.
 *
 *  Modules teste : smartMapping, specNormalizer, imageMatcher, descriptions.
 *  Duree typique : 4-8s.
 */
generateRouter.get('/gemini/smoke', async (_req, res) => {
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** POST /api/layout
 *  Mode LAYOUT GEN (parallele a /generate) : compose un catalogue from scratch
 *  via Gemini Pro (HTML/CSS → Chromium PDF), SANS template PDF. Inputs : data
 *  (xlsx/csv) + assets (zip). Query ?perPage=N (default 3).
 *
 *  ATTENTION : lent (Pro ~30-45s/page). Mode experimental opt-in.
 */
generateRouter.post('/layout', enforceTotalSize, upload.any(), async (req, res) => {
  res.setTimeout(20 * 60 * 1000); // Pro lent : large marge
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
      res.status(500).json({ error: 'Echec layout gen', notes: result.notes });
      return;
    }
    res.json({
      pdfName,
      catalogUrl: signedUrl(pdfName),
      pageCount: result.pageCount,
      productCount: built.products.length,
      durationMs: result.durationMs,
      notes: result.notes,
      adapterWarnings: built.warnings,
    });
  } catch (err) {
    await cleanupFiles(uploadedPaths);
    res.status(500).json({ error: `Echec layout : ${(err as Error).message}` });
  }
});

generateRouter.post('/generate', enforceTotalSize, upload.any(), async (req, res) => {
  // R5 audit : timeout global cote serveur (30 min). Au-dela, Express
  // coupera la connexion meme si un sub-process tourne encore. Evite qu'une
  // generation runaway bloque indefiniment un client.
  res.setTimeout(30 * 60 * 1000);
  const totalStartMs = Date.now();

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) {
    res.status(400).json({ error: 'Aucun fichier fourni' });
    return;
  }
  const uploadedPaths = files.map((f) => f.path);
  // Stamp avec suffixe random : evite la collision de fs paths si 2 requetes
  // arrivent dans la meme milliseconde (workDir / outPdf identiques sinon).
  const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  // jobId pour le tracker de progression : passe en QUERY STRING par le
  // client (POST /api/generate?jobId=xxx) pour qu'on puisse le lire AVANT
  // que multer parse les fichiers. Si absent/invalide ou deja actif dans
  // le tracker (collision rare UUID v4 mais possible), on suffixe pour
  // garantir l'unicite. Le client poll son jobId d'origine : si on a du
  // suffixer, sa barre ne marchera pas mais le pipeline tourne normalement.
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
    markError(jobId, `Echec extraction : ${(err as Error).message}`);
    res.status(500).json({ error: `Echec extraction : ${(err as Error).message}` });
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
    markError(jobId, (err as Error).message);
    res.status(500).json({ error: `Echec creation repertoire de sortie : ${(err as Error).message}` });
    return;
  }

  setProgress(jobId, 'parse', 5, 'Lecture de la base produits…');
  let built;
  try {
    // V2 : pas de templateConfig (les patterns metier vivent dans le Skill).
    // projectDir : expose .claude/skills a la CLI Claude (smart mapping).
    built = await buildProductInputs(extracted, workDir, {
      projectDir: PROJECT_DIR,
      // Smart mapping des colonnes via Gemini (fallback quand l'heuristique a des
      // trous). ON par defaut ; ?enrich=0 pour mapping deterministe seul.
      enableSmartMapping: req.query?.enrich !== '0',
    });
  } catch (err) {
    await cleanupFiles([...uploadedPaths, workDir]);
    markError(jobId, (err as Error).message);
    res.status(500).json({
      error: `Echec preparation des produits : ${(err as Error).message}`,
      rejectedFiles,
    });
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

  // Validation amont supplementaire : produits sans nom, refs dupliquees,
  // sections vides. On warning (pas error) car le pipeline gere mais
  // l'utilisateur veut savoir avant rendu.
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
      // Branche BC_test : intent-driven substitute par defaut. Le pipeline
      // genere des IntentOps depuis les product data → resolve → Operations.
      // Override par query ?intent=0 pour revenir au substitutor legacy.
      enableIntentPlan: req.query?.intent !== '0',
      // Boucle Claude → IntentOps → re-render : DESACTIVEE par defaut.
      // Trop couteuse (~6min Claude Sonnet vision sur 2 passes) pour un
      // gain visuel marginal. Activer par query ?intent_loop=1 si besoin.
      enableIntentLoop: req.query?.intent_loop === '1',
      // Audit de coherence globale (CLI Pro Vision, cross-page). Opt-in via
      // ?coherence=1 : garde-fou de relecture (typo/alignement/pagination/
      // sommaire entre pages). ~45s en plus mais alimente "pages a verifier".
      enableGeminiCoherenceAudit: req.query?.coherence === '1',
      // ── Taches LLM auxiliaires : ON par defaut (on GARDE descriptions, audit,
      //    enrichissement specs). La lenteur passee venait du QUOTA mort (retries
      //    90s + CLI Pro lent en fallback), PAS des features → corrige par le
      //    fail-fast (client MAX_RETRY_DELAY_MS=8s + router sans CLI en 'speed') :
      //    sur quota mort la tache se skippe vite au lieu de bloquer des minutes.
      //    Opt-out ?audit=0 / ?descriptions=0 / ?enrich=0 pour une gen ultra-rapide.
      enableGeminiAudit: req.query?.audit !== '0',
      enableGeminiDescriptions: req.query?.descriptions !== '0',
      enableSpecNormalization: req.query?.enrich !== '0',
      enableValueFormatting: req.query?.enrich !== '0',
      onProgress: (phase, pct, message) => setProgress(jobId, phase, pct, message),
    });
  } catch (err) {
    await cleanupFiles([...uploadedPaths, workDir, outPdf]);
    markError(jobId, (err as Error).message);
    res.status(500).json({
      error: `Echec moteur V2 : ${(err as Error).message}`,
      rejectedFiles,
    });
    return;
  }
  if (!result.ok) {
    await cleanupFiles([...uploadedPaths, workDir, outPdf]);
    // Erreur utilisateur-friendly : on prend la premiere raison parmi
    // les orchestratorErrors, mappee a un message clair. Le detail
    // technique reste dans orchestratorErrors pour le debug.
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
      details: errMsg,
      rejectedFiles,
      adapterWarnings: built.warnings,
      stats: result.stats,
      orchestratorErrors: result.errors,
      orchestratorWarnings: result.warnings,
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
    /** Duree totale endpoint mesuree cote serveur (multer + parsing + engine
     *  + render + write fichiers). Sert a l'estimateur (plus fiable que la
     *  somme des phases stats qui sous-estime systematiquement). */
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

  // P1 fix : nettoyer aussi les uploads multer sur le chemin succes (les
  // chemins erreur le faisaient deja). Sinon les fichiers s'accumulent
  // indefiniment dans uploads/.
  await cleanupFiles([...uploadedPaths, workDir]);

  markDone(jobId, 'Terminé');
  // Le client lit le done=true via son prochain poll puis ferme l'EventSource.
  // On garde l'entree 60s pour laisser le dernier poll passer, puis cleanup.
  setTimeout(() => clearProgress(jobId), 60 * 1000).unref();
  res.json(payload);
});
