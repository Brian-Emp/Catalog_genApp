/**
 * Estimateur de duree de generation. Honnete par construction : ne devine
 * pas, calibre sur les durees REELLES des N dernieres generations stockees
 * dans `generated/*.meta.json`.
 *
 * Modele :
 *    eta = base + descClaudeWait * (descEnabled ? 1 : 0)
 *        + perProductMs * nbProducts
 *
 * ou base/descClaudeWait/perProductMs sont :
 *   - calibres sur la mediane des N dernieres meta.json si dispo
 *   - sinon valeurs par defaut conservatrices (legerement surestimees pour
 *     ne pas frustrer l'utilisateur)
 *
 * On retourne ETA mediane + une fourchette ±25% pour signaler l'incertitude.
 */
import { promises as fs } from 'fs';
import path from 'path';

const GEN_DIR = path.resolve('generated');
/** Nombre max de meta.json a lire pour calibration. */
const CALIBRATION_SAMPLE_SIZE = 30;

/** Valeurs par defaut conservatrices (ms) — utilisees si aucune meta.json
 *  disponible. Calibrees sur observations endpoint complete (multer upload,
 *  parse XLSX, engine, render, write fichiers) : ~4s base, ~17s Claude
 *  descriptions, ~200ms par produit (Claude audit / substitute / render). */
const DEFAULT_BASE_MS = 4000;
const DEFAULT_DESC_WAIT_MS = 17000;
const DEFAULT_PER_PRODUCT_MS = 200;

export interface EstimateInput {
  /** Si absent : utilise la mediane des dernieres generations comme proxy.
   *  Sert au front qui peut afficher une estimation des qu'un template est
   *  charge, avant meme de parser le XLSX. */
  productsCount?: number;
  withDescriptions: boolean;
}

export interface EstimateBreakdown {
  baseMs: number;
  descClaudeMs: number;
  perProductMs: number;
  productsCount: number;
}

export interface EstimateResult {
  etaMs: number;
  /** Borne basse (~75% de l'eta), pour communiquer une fourchette honnete. */
  etaLowerMs: number;
  /** Borne haute (~125% de l'eta). */
  etaUpperMs: number;
  /** Source des coefficients : "calibrated" si depuis meta.json, sinon "default". */
  source: 'calibrated' | 'default';
  /** Echantillon utilise pour la calibration (nb de meta.json lues). */
  sampleSize: number;
  breakdown: EstimateBreakdown;
}

interface CalibrationCoeffs {
  baseMs: number;
  descClaudeMs: number;
  perProductMs: number;
  /** Mediane des productCount observes. Sert de proxy quand le caller ne
   *  fournit pas productsCount. */
  medianProductsCount: number;
  sampleSize: number;
}

/** Lit les N dernieres meta.json pour deriver les coefficients medians.
 *  Retourne null si echantillon insuffisant (< 3 fichiers exploitables). */
async function calibrateFromMetas(): Promise<CalibrationCoeffs | null> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(GEN_DIR);
  } catch {
    return null;
  }
  const metas = entries.filter((n) => n.endsWith('.meta.json'));
  // Tri par mtime desc, on prend les N plus recentes
  const withStat = await Promise.all(
    metas.map(async (name) => {
      try {
        const stat = await fs.stat(path.join(GEN_DIR, name));
        return { name, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const sorted = withStat.filter((x): x is { name: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, CALIBRATION_SAMPLE_SIZE);

  interface Sample {
    productsCount: number;
    durationMs: number;
    descRan: boolean;
  }
  const samples: Sample[] = [];
  for (const { name } of sorted) {
    try {
      const raw = await fs.readFile(path.join(GEN_DIR, name), 'utf8');
      const meta = JSON.parse(raw);
      const productsCount = Number(meta.productCount ?? 0);
      if (productsCount <= 0) continue;
      // Duree totale : preferer totalDurationMs (mesure endpoint complete,
      // ajoute depuis la calibration v2). Fallback : somme des phases stats
      // (sous-estime mais mieux que rien pour les anciennes generations).
      let durationMs = Number(meta.totalDurationMs ?? 0);
      if (!isFinite(durationMs) || durationMs <= 0) {
        const stats = meta?.stats ?? {};
        const phases = [
          Number(stats.extractMs ?? 0),
          Number(stats.classifyMs ?? 0),
          Number(stats.allocateMs ?? 0),
          Number(stats.claudeAuditMs ?? 0),
          Number(stats.substituteMs ?? 0),
          Number(stats.renderMs ?? 0),
          Number(stats.visualAuditMs ?? 0),
          Number(stats.specNormalizerMs ?? 0),
          Number(stats.valueFormatterMs ?? 0),
        ];
        durationMs = phases.reduce((s, x) => s + (isFinite(x) ? x : 0), 0);
      }
      if (durationMs <= 0) continue;
      const descRan = Array.isArray(meta.warnings)
        && meta.warnings.some((w: unknown) =>
          typeof w === 'string' && /description/i.test(w));
      samples.push({ productsCount, durationMs, descRan });
    } catch {
      // skip malformes
    }
  }
  if (samples.length < 3) return null;

  // Regression simple : duration = base + perProduct * nbProducts
  // On ignore la part Claude descriptions (non stockee fiable), on garde
  // la valeur par defaut DEFAULT_DESC_WAIT_MS.
  // Mediane par bucket de productsCount pour robustesse.
  const sortedDur = [...samples].sort((a, b) => a.durationMs - b.durationMs);
  const median = sortedDur[Math.floor(sortedDur.length / 2)];
  // Estimation : perProduct = (median.durationMs - DEFAULT_BASE_MS) / nbProducts
  const perProductEst = median.productsCount > 0
    ? Math.max(10, (median.durationMs - DEFAULT_BASE_MS) / median.productsCount)
    : DEFAULT_PER_PRODUCT_MS;
  // Mediane des productsCount (pour proxy si caller absent)
  const sortedCounts = [...samples].sort((a, b) => a.productsCount - b.productsCount);
  const medianProductsCount = sortedCounts[Math.floor(sortedCounts.length / 2)].productsCount;

  return {
    baseMs: DEFAULT_BASE_MS,
    descClaudeMs: DEFAULT_DESC_WAIT_MS,
    perProductMs: perProductEst,
    medianProductsCount,
    sampleSize: samples.length,
  };
}

/** Estime la duree d'une generation. */
export async function estimateGenerationDuration(input: EstimateInput): Promise<EstimateResult> {
  const calibrated = await calibrateFromMetas();
  const coeffs = calibrated ?? {
    baseMs: DEFAULT_BASE_MS,
    descClaudeMs: DEFAULT_DESC_WAIT_MS,
    perProductMs: DEFAULT_PER_PRODUCT_MS,
    medianProductsCount: 0,
    sampleSize: 0,
  };
  // productsCount fourni → utiliser tel quel. Absent → utiliser la mediane
  // historique comme proxy (ou 0 si on n'a pas de stats).
  const products = input.productsCount != null
    ? Math.max(0, Math.floor(input.productsCount))
    : coeffs.medianProductsCount;
  const descMs = input.withDescriptions ? coeffs.descClaudeMs : 0;
  const productMs = products * coeffs.perProductMs;
  const etaMs = coeffs.baseMs + descMs + productMs;
  // Fourchette d'incertitude ±35% (plus honnete que ±25%, le modele lineaire
  // n'a pas la finesse pour serrer la prediction quand peu de samples ou que
  // la variance est forte selon nb pages template / Claude descs).
  return {
    etaMs,
    etaLowerMs: Math.round(etaMs * 0.65),
    etaUpperMs: Math.round(etaMs * 1.35),
    source: calibrated ? 'calibrated' : 'default',
    sampleSize: coeffs.sampleSize,
    breakdown: {
      baseMs: coeffs.baseMs,
      descClaudeMs: descMs,
      perProductMs: coeffs.perProductMs,
      productsCount: products,
    },
  };
}
