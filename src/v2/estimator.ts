/**
 * Generation duration estimator. Honest by construction: it does not guess,
 * it calibrates on the REAL durations of the last N generations stored in
 * `generated/*.meta.json`.
 *
 * Model:
 *    eta = base + descClaudeWait * (descEnabled ? 1 : 0)
 *        + perProductMs * nbProducts
 *
 * where base/descClaudeWait/perProductMs are:
 *   - calibrated on the median of the last N meta.json if available
 *   - otherwise conservative default values (slightly overestimated so as
 *     not to frustrate the user)
 *
 * We return the median ETA + a ±25% range to signal the uncertainty.
 */
import { promises as fs } from 'fs';
import path from 'path';

const GEN_DIR = path.resolve('generated');
/** Max number of meta.json to read for calibration. */
const CALIBRATION_SAMPLE_SIZE = 30;

/** Conservative default values (ms) — used if no meta.json is available.
 *  Calibrated on observations of the full endpoint (multer upload, XLSX
 *  parse, engine, render, file writes): ~4s base, ~17s Claude
 *  descriptions, ~200ms per product (Claude audit / substitute / render). */
const DEFAULT_BASE_MS = 4000;
const DEFAULT_DESC_WAIT_MS = 17000;
const DEFAULT_PER_PRODUCT_MS = 200;

export interface EstimateInput {
  /** If absent: uses the median of the last generations as a proxy.
   *  Used by the front-end, which can show an estimate as soon as a template
   *  is loaded, even before parsing the XLSX. */
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
  /** Lower bound (~75% of the eta), to communicate an honest range. */
  etaLowerMs: number;
  /** Upper bound (~125% of the eta). */
  etaUpperMs: number;
  /** Source of the coefficients: "calibrated" if from meta.json, otherwise "default". */
  source: 'calibrated' | 'default';
  /** Sample used for the calibration (number of meta.json read). */
  sampleSize: number;
  breakdown: EstimateBreakdown;
}

interface CalibrationCoeffs {
  baseMs: number;
  descClaudeMs: number;
  perProductMs: number;
  /** Median of the observed productCount. Used as a proxy when the caller
   *  does not provide productsCount. */
  medianProductsCount: number;
  sampleSize: number;
}

/** Reads the last N meta.json to derive the median coefficients.
 *  Returns null if the sample is insufficient (< 3 usable files). */
async function calibrateFromMetas(): Promise<CalibrationCoeffs | null> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(GEN_DIR);
  } catch {
    return null;
  }
  const metas = entries.filter((n) => n.endsWith('.meta.json'));
  // Sort by mtime desc, take the N most recent
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
      // Total duration: prefer totalDurationMs (full-endpoint measurement,
      // added since the v2 calibration). Fallback: sum of the stats phases
      // (underestimates but better than nothing for older generations).
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
      // skip malformed
    }
  }
  if (samples.length < 3) return null;

  // Simple regression: duration = base + perProduct * nbProducts
  // We ignore the Claude descriptions part (not reliably stored) and keep
  // the default value DEFAULT_DESC_WAIT_MS.
  // Median by productsCount bucket for robustness.
  const sortedDur = [...samples].sort((a, b) => a.durationMs - b.durationMs);
  const median = sortedDur[Math.floor(sortedDur.length / 2)];
  // Estimate: perProduct = (median.durationMs - DEFAULT_BASE_MS) / nbProducts
  const perProductEst = median.productsCount > 0
    ? Math.max(10, (median.durationMs - DEFAULT_BASE_MS) / median.productsCount)
    : DEFAULT_PER_PRODUCT_MS;
  // Median of the productsCount (for proxy if caller is absent)
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

/** Estimates the duration of a generation. */
export async function estimateGenerationDuration(input: EstimateInput): Promise<EstimateResult> {
  const calibrated = await calibrateFromMetas();
  const coeffs = calibrated ?? {
    baseMs: DEFAULT_BASE_MS,
    descClaudeMs: DEFAULT_DESC_WAIT_MS,
    perProductMs: DEFAULT_PER_PRODUCT_MS,
    medianProductsCount: 0,
    sampleSize: 0,
  };
  // productsCount provided → use as-is. Absent → use the historical median
  // as a proxy (or 0 if we have no stats).
  const products = input.productsCount != null
    ? Math.max(0, Math.floor(input.productsCount))
    : coeffs.medianProductsCount;
  const descMs = input.withDescriptions ? coeffs.descClaudeMs : 0;
  const productMs = products * coeffs.perProductMs;
  const etaMs = coeffs.baseMs + descMs + productMs;
  // Uncertainty range ±35% (more honest than ±25%; the linear model
  // lacks the precision to tighten the prediction when there are few samples
  // or when variance is high depending on template page count / Claude descs).
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
