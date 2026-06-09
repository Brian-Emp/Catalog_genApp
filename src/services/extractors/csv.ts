import { promises as fs } from 'fs';
import { parse } from 'csv-parse/sync';
import type { CsvData } from '../../types';

// Limits overridable via env vars.
const MAX_CSV_BYTES = Number(process.env.MAX_CSV_BYTES) || 100 * 1024 * 1024;
// Cap independent of bytes: a CSV of short rows can produce millions of
// records and OOM Node even though the total bytes are within the limit.
const MAX_CSV_ROWS = Number(process.env.MAX_CSV_ROWS) || 200_000;

/** Candidate delimiters in order of caution (first = default if everything
 *  ties, last = exotic). */
type CsvDelimiter = ',' | ';' | '\t' | '|';
const DELIMITER_CANDIDATES: ReadonlyArray<CsvDelimiter> = [',', ';', '\t', '|'];

/**
 * Detects the most likely separator by analyzing the first N lines.
 *
 * Strategy:
 *   1. For each candidate, count the occurrences PER LINE.
 *   2. Compute mean + variance.
 *   3. Score = mean / (1 + variance) → favors a sep that appears often AND a
 *      CONSTANT number of times per line (= clean tabular structure).
 *
 *  More robust than counting the first line alone: if the first line (headers)
 *  contains an ambiguous character (e.g. a comma in "Nom, Prénom" as a
 *  single-column header), the following lines disambiguate.
 */
export function detectDelimiter(sample: string): CsvDelimiter {
  const lines = sample
    .split(/\r?\n/)
    .slice(0, 10)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return ',';

  let bestSep: CsvDelimiter = ',';
  let bestScore = -1;

  for (const sep of DELIMITER_CANDIDATES) {
    const counts = lines.map((line) => {
      let c = 0;
      for (const ch of line) if (ch === sep) c++;
      return c;
    });
    const sum = counts.reduce((s, c) => s + c, 0);
    if (sum === 0) continue;
    const avg = sum / counts.length;
    const variance =
      counts.reduce((s, c) => s + (c - avg) * (c - avg), 0) / counts.length;
    // Score: mean (importance) / (1 + variance) (instability penalty)
    const score = avg / (1 + variance);
    if (score > bestScore) {
      bestScore = score;
      bestSep = sep;
    }
  }

  return bestSep;
}

/**
 * Detects the probable encoding of the CSV buffer.
 *
 * Strategy:
 *   1. UTF-16 LE BOM (FF FE) → utf-16le (Mac Excel exports)
 *   2. UTF-8 BOM (EF BB BF) → utf-8
 *   3. Strict utf-8 decode over the first 64 KB: if valid → utf-8
 *   4. Otherwise → latin1 (the safe superset for European CSVs exported from
 *      Excel Windows in CP1252, which is binary-compatible with latin1 for the
 *      0x80-0xFF latin range)
 *
 *  Covers the XLSX → CSV exports from Excel/LibreOffice that often produce
 *  latin1/CP1252 by default on Windows, or UTF-16 LE on Mac.
 *  Note: UTF-16 BE (FE FF) remains unsupported (rare; mapped to latin1).
 */
export type CsvEncoding = 'utf-8' | 'latin1' | 'utf-16le';

export function detectEncoding(buf: Buffer): CsvEncoding {
  if (buf.length === 0) return 'utf-8';
  // UTF-16 LE BOM (Mac Excel exports)
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  // UTF-8 BOM
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  // Strict utf-8 decode over the sample: if it fails → latin1
  const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'utf-8';
  } catch {
    return 'latin1';
  }
}

/**
 * Skips any "title" lines at the start of a CSV (= lines with FEWER
 * separators than the following lines). Typical case: first line =
 * "Catalogue 2026" (0 separators), second = tabular headers "Name,Ref,Color".
 *
 * Strategy symmetric to findHeaderRowIndex for XLSX (round 25). We scan the
 * first 5 lines and look for the first one that has >= MIN_SEPARATORS
 * occurrences of the delimiter. Returns the text without the preceding lines.
 *
 * If all lines have few separators: we return the text intact (safe fallback =
 * legacy behavior).
 */
export function skipLeadingTitleRows(text: string, delimiter: string): string {
  const MIN_SEPARATORS = 2; // >= 2 sep = >= 3 columns = tabular header
  const MAX_SCAN_LINES = 5;
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return text;
  // Find the first line with enough separators
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, MAX_SCAN_LINES); i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // empty line → skip
    let count = 0;
    for (const ch of line) if (ch === delimiter) count++;
    if (count >= MIN_SEPARATORS) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === 0) return text;
  return lines.slice(headerIdx).join('\n');
}

export async function extractCsv(filePath: string): Promise<CsvData> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_CSV_BYTES) {
    throw new Error(`CSV trop volumineux (${stat.size} octets, max ${MAX_CSV_BYTES})`);
  }
  const buf = await fs.readFile(filePath);
  // Encoding detection: utf-8 if valid, otherwise latin1 (CP1252-compatible
  // for European Excel exports). Without this, "Mégère" becomes "Mégère"
  // or worse.
  const encoding = detectEncoding(buf);
  // Node Buffer.toString accepts 'utf16le' (alias 'ucs-2'), 'utf-8',
  // 'latin1'. The UTF-16 LE BOM is consumed automatically by the decoder.
  const rawText = buf.toString(encoding === 'utf-16le' ? 'utf16le' : encoding);
  const sample = rawText.slice(0, 2000);
  const delimiter = detectDelimiter(sample);
  // Skip title lines at the start (consistent with XLSX findHeaderRowIndex)
  const text = skipLeadingTitleRows(rawText, delimiter);
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter,
    relax_column_count: true,
    to: MAX_CSV_ROWS,
  }) as Record<string, string>[];
  if (records.length >= MAX_CSV_ROWS) {
    throw new Error(`CSV trop de lignes (>${MAX_CSV_ROWS}). Reduis le fichier ou contacte l'admin.`);
  }
  const headers = records.length ? Object.keys(records[0]) : [];
  return {
    kind: 'csv',
    headers,
    rowCount: records.length,
    rows: records,
  };
}
