/**
 * Stats d'usage Gemini : compteur in-memory des appels, latences et statuts.
 *
 * Utilise pour :
 *  - mesurer l'economie quota Gemini vs Claude (cache hit ratio, ratio retry)
 *  - debug : afficher dans le diagnostic UI ou warnings pipeline
 *  - estimer le cout d'une generation (Gemini free tier = $0, mais sert
 *    quand-meme a comparer perfs)
 *
 * Reset : explicite via `resetStats()` ou au boot du process.
 */

export interface GeminiCallRecord {
  /** Module appelant (audit / mapping / matcher / etc.). */
  module: string;
  /** Modele utilise (gemini-2.5-flash, gemini-2.5-pro, ...). */
  model: string;
  /** Statut final apres retry. */
  status: 'ok' | 'error' | 'retry_exhausted' | 'cache_hit';
  /** Latence ms (0 pour cache hit). */
  durationMs: number;
  /** Code erreur si KO (ex 429, 401). */
  errorCode?: number;
  /** True si la reponse vient du fallbackModel (degradation quota). */
  usedFallback?: boolean;
  /** Tokens prompt + candidates (proxy consommation quota). */
  promptTokens?: number;
  candidateTokens?: number;
  /** Timestamp epoch ms. */
  timestamp: number;
}

interface StatsAggregate {
  totalCalls: number;
  okCalls: number;
  errorCalls: number;
  cacheHits: number;
  retryExhausted: number;
  /** Nombre d'appels ou` le fallbackModel a sauve (degradation reussie). */
  fallbacksUsed: number;
  totalDurationMs: number;
  /** Tokens cumules (proxy consommation quota daily). */
  totalPromptTokens: number;
  totalCandidateTokens: number;
  /** Map errorCode → count. */
  errorBreakdown: Record<number, number>;
  /** Map module → count. */
  byModule: Record<string, number>;
  /** Map model → count. */
  byModel: Record<string, number>;
  /** Detail par modele : appels / ok / quota(429). Sert a l'UI a montrer
   *  QUELS modeles sont epuises (quota journalier atteint) vs sains. */
  byModelDetail: Record<string, { calls: number; ok: number; quota: number }>;
}

let records: GeminiCallRecord[] = [];

export function recordCall(rec: Omit<GeminiCallRecord, 'timestamp'>): void {
  records.push({ ...rec, timestamp: Date.now() });
  // Cap memoire : on garde les 1000 derniers (rolling window)
  if (records.length > 1000) {
    records = records.slice(-1000);
  }
}

function emptyAggregate(): StatsAggregate {
  return {
    totalCalls: 0,
    okCalls: 0,
    errorCalls: 0,
    cacheHits: 0,
    retryExhausted: 0,
    fallbacksUsed: 0,
    totalDurationMs: 0,
    totalPromptTokens: 0,
    totalCandidateTokens: 0,
    errorBreakdown: {},
    byModule: {},
    byModel: {},
    byModelDetail: {},
  };
}

function accumulateRecord(agg: StatsAggregate, r: GeminiCallRecord): void {
  agg.totalCalls++;
  agg.totalDurationMs += r.durationMs;
  if (r.status === 'ok') agg.okCalls++;
  else if (r.status === 'cache_hit') agg.cacheHits++;
  else if (r.status === 'retry_exhausted') agg.retryExhausted++;
  else agg.errorCalls++;
  if (r.usedFallback) agg.fallbacksUsed++;
  if (r.promptTokens) agg.totalPromptTokens += r.promptTokens;
  if (r.candidateTokens) agg.totalCandidateTokens += r.candidateTokens;
  if (r.errorCode) {
    agg.errorBreakdown[r.errorCode] = (agg.errorBreakdown[r.errorCode] ?? 0) + 1;
  }
  agg.byModule[r.module] = (agg.byModule[r.module] ?? 0) + 1;
  agg.byModel[r.model] = (agg.byModel[r.model] ?? 0) + 1;
  const d = agg.byModelDetail[r.model]
    ?? (agg.byModelDetail[r.model] = { calls: 0, ok: 0, quota: 0 });
  d.calls++;
  if (r.status === 'ok') d.ok++;
  if (r.errorCode === 429) d.quota++;
}

export function getStats(): StatsAggregate {
  const agg = emptyAggregate();
  for (const r of records) accumulateRecord(agg, r);
  return agg;
}

export function getRecentRecords(n: number = 20): GeminiCallRecord[] {
  return records.slice(-n);
}

export function resetStats(): void {
  records = [];
}

/**
 * Snapshot du nombre de records actuels. Utile pour mesurer le delta sur
 * une operation specifique (ex : un seul run de pipeline) :
 *
 *   const before = snapshotMark();
 *   // ... pipeline ...
 *   const stats = statsSince(before);
 */
export function snapshotMark(): number {
  return records.length;
}

/**
 * Agrege seulement les records ajoutes APRES un snapshot mark.
 */
export function statsSince(mark: number): StatsAggregate {
  const agg = emptyAggregate();
  for (let i = Math.max(0, mark); i < records.length; i++) accumulateRecord(agg, records[i]);
  return agg;
}

/** Format un StatsAggregate fourni (vs formatStats() qui utilise globalement). */
export function formatAggregate(s: StatsAggregate): string {
  if (s.totalCalls === 0) return 'Gemini : 0 calls';
  const avgMs = Math.round(s.totalDurationMs / s.totalCalls);
  const okRate = Math.round((s.okCalls / s.totalCalls) * 100);
  const hitRate = Math.round((s.cacheHits / s.totalCalls) * 100);
  const parts = [`${s.totalCalls} calls`];
  if (s.okCalls > 0) parts.push(`ok=${s.okCalls}`);
  if (s.cacheHits > 0) parts.push(`cache=${s.cacheHits}`);
  if (s.errorCalls > 0) parts.push(`error=${s.errorCalls}`);
  if (s.retryExhausted > 0) parts.push(`retry_exh=${s.retryExhausted}`);
  if (s.fallbacksUsed > 0) parts.push(`fallback=${s.fallbacksUsed}`);
  if (s.totalPromptTokens + s.totalCandidateTokens > 0) {
    parts.push(`tokens=${s.totalPromptTokens + s.totalCandidateTokens}`);
  }
  parts.push(`avg ${avgMs}ms`);
  if (okRate > 0 || hitRate > 0) parts.push(`(${okRate}% ok, ${hitRate}% cache)`);
  return `Gemini : ${parts.join(', ')}`;
}

/** Format human-readable des stats pour log/diagnostic. */
export function formatStats(): string {
  const s = getStats();
  if (s.totalCalls === 0) return 'Gemini : 0 calls';
  const avgMs = Math.round(s.totalDurationMs / s.totalCalls);
  const okRate = s.totalCalls > 0
    ? Math.round((s.okCalls / s.totalCalls) * 100)
    : 0;
  const hitRate = s.totalCalls > 0
    ? Math.round((s.cacheHits / s.totalCalls) * 100)
    : 0;
  const lines = [
    `Gemini stats : ${s.totalCalls} calls (ok ${s.okCalls}, error ${s.errorCalls}, cache ${s.cacheHits}, retry_exh ${s.retryExhausted}, fallback ${s.fallbacksUsed})`,
    `  taux : ${okRate}% ok, ${hitRate}% cache hits | latence moy ${avgMs}ms`,
  ];
  if (Object.keys(s.byModule).length > 0) {
    const modList = Object.entries(s.byModule)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    lines.push(`  par module : ${modList}`);
  }
  if (Object.keys(s.errorBreakdown).length > 0) {
    const errList = Object.entries(s.errorBreakdown)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    lines.push(`  erreurs : ${errList}`);
  }
  return lines.join('\n');
}
