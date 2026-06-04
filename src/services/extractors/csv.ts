import { promises as fs } from 'fs';
import { parse } from 'csv-parse/sync';
import type { CsvData } from '../../types';

// Limites overridables via env vars.
const MAX_CSV_BYTES = Number(process.env.MAX_CSV_BYTES) || 100 * 1024 * 1024;
// Cap independant des bytes : un CSV de short-rows peut produire des millions
// de records et OOM Node alors que le total bytes est dans la limite.
const MAX_CSV_ROWS = Number(process.env.MAX_CSV_ROWS) || 200_000;

/** Délimiteurs candidats par ordre de prudence (premier = défaut si tout
 *  ex aequo, dernier = exotique). */
type CsvDelimiter = ',' | ';' | '\t' | '|';
const DELIMITER_CANDIDATES: ReadonlyArray<CsvDelimiter> = [',', ';', '\t', '|'];

/**
 * Détecte le séparateur le plus probable en analysant les N premières lignes.
 *
 * Strategie :
 *   1. Pour chaque candidat, compte les occurrences PAR LIGNE.
 *   2. Calcule moyenne + variance.
 *   3. Score = moyenne / (1 + variance) → favorise un sep qui apparait
 *      souvent ET un nombre CONSTANT de fois par ligne (= structure
 *      tabulaire propre).
 *
 *  Plus robuste que compter la 1ere ligne seule : si la 1ere ligne (headers)
 *  contient un caractere ambigu (ex virgule dans "Nom, Prénom" comme header
 *  d'une seule colonne), les lignes suivantes desambiguisent.
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
    // Score : moyenne (importance) / (1 + variance) (penalite instabilite)
    const score = avg / (1 + variance);
    if (score > bestScore) {
      bestScore = score;
      bestSep = sep;
    }
  }

  return bestSep;
}

/**
 * Détecte l'encodage probable du buffer CSV.
 *
 * Strategie :
 *   1. BOM UTF-16 LE (FF FE) → utf-16le (exports Mac Excel)
 *   2. BOM UTF-8 (EF BB BF) → utf-8
 *   3. Decode strict en utf-8 sur les 64 premiers Ko : si valide → utf-8
 *   4. Sinon → latin1 (le surensemble safe pour les CSV europeens
 *      exportes depuis Excel Windows en CP1252, qui est binairement
 *      compatible avec latin1 pour la plage 0x80-0xFF latin)
 *
 *  Couvre les exports XLSX → CSV de Excel/LibreOffice qui produisent
 *  souvent du latin1/CP1252 par defaut sur Windows, ou UTF-16 LE sur Mac.
 *  Note : UTF-16 BE (FE FF) reste non supporte (rare ; mappe sur latin1).
 */
export type CsvEncoding = 'utf-8' | 'latin1' | 'utf-16le';

export function detectEncoding(buf: Buffer): CsvEncoding {
  if (buf.length === 0) return 'utf-8';
  // BOM UTF-16 LE (Mac Excel exports)
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  // BOM UTF-8
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  // Decode strict utf-8 sur sample : si echoue → latin1
  const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'utf-8';
  } catch {
    return 'latin1';
  }
}

/**
 * Skip eventuelles lignes "titre" en debut de CSV (= lignes avec MOINS de
 * separateurs que les lignes suivantes). Cas typique : 1ere ligne =
 * "Catalogue 2026" (0 separator), 2e = headers tabulaires "Name,Ref,Color".
 *
 * Strategie symetrique a findHeaderRowIndex pour XLSX (tour 25). On scanne
 * les 5 premieres lignes et on cherche la 1ere qui a >= MIN_SEPARATORS
 * occurrences du delimiteur. Retourne le text sans les lignes avant.
 *
 * Si toutes les lignes ont peu de separateurs : on retourne le text intact
 * (fallback safe = comportement legacy).
 */
export function skipLeadingTitleRows(text: string, delimiter: string): string {
  const MIN_SEPARATORS = 2; // >= 2 sep = >= 3 colonnes = header tabulaire
  const MAX_SCAN_LINES = 5;
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return text;
  // Trouve la 1ere ligne avec assez de separateurs
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, MAX_SCAN_LINES); i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // ligne vide → skip
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
  // Detection encodage : utf-8 si valide, sinon latin1 (CP1252-compatible
  // pour les exports Excel europeens). Sans ca, "Mégère" devient "Mégère"
  // ou pire.
  const encoding = detectEncoding(buf);
  // Node Buffer.toString accepte 'utf16le' (alias 'ucs-2'), 'utf-8',
  // 'latin1'. Le BOM UTF-16 LE est consomme automatiquement par le decoder.
  const rawText = buf.toString(encoding === 'utf-16le' ? 'utf16le' : encoding);
  const sample = rawText.slice(0, 2000);
  const delimiter = detectDelimiter(sample);
  // Skip lignes-titre en debut (cohérence avec XLSX findHeaderRowIndex)
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
