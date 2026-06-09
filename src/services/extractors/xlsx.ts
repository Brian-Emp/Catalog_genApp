import { promises as fs } from 'fs';
import ExcelJS from 'exceljs';
import type { XlsxData } from '../../types';

const MAX_XLSX_BYTES = Number(process.env.MAX_XLSX_BYTES) || 100 * 1024 * 1024;

/** Converts an ExcelJS cell into a readable string.
 *  Handles: strings, numbers, Date, formulas (.result), hyperlinks (.text),
 *  RichText (.richText[]), null/undefined. */
/** Excel errors (#REF!, #N/A, etc.) treated as empty cells: injecting them
 *  into the specs would pollute the product sheets with non-informative
 *  technical noise. */
const EXCEL_ERROR_VALUES = new Set([
  '#REF!', '#N/A', '#NAME?', '#DIV/0!', '#VALUE!', '#NULL!', '#NUM!',
  '#GETTING_DATA', '#SPILL!', '#CALC!', '#FIELD!',
]);

function isExcelError(s: string): boolean {
  return EXCEL_ERROR_VALUES.has(s.trim());
}

export function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (typeof cell === 'string') {
    // Excel error → empty cell (avoids "#REF!" in a product sheet).
    return isExcelError(cell) ? '' : cell;
  }
  if (typeof cell === 'object') {
    const c = cell as Record<string, unknown>;
    // ExcelJS encodes errors as { error: '#REF!' } or { result: { error: ... } }.
    if ('error' in c && typeof c.error === 'string') {
      return ''; // explicit error → empty
    }
    if (Array.isArray((c as { richText?: unknown[] }).richText)) {
      return (c.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if ('text' in c && c.text != null) {
      return cellToString(c.text);
    }
    if ('result' in c && c.result != null) {
      // result of a formula: can be a number, string, or error
      return cellToString(c.result);
    }
    if ('hyperlink' in c && typeof c.hyperlink === 'string') return c.hyperlink;
    return '';
  }
  const str = String(cell);
  return isExcelError(str) ? '' : str;
}

/** True if ALL the cells in the row are empty or whitespace-only.
 *  Used by the post-extraction filter to ignore visual separators (blank
 *  interleaved rows) that create phantom "Produit N+1" products in the
 *  pipeline. */
export function isRowAllBlank(row: Record<string, string>): boolean {
  for (const v of Object.values(row)) {
    if (v != null && String(v).trim().length > 0) return false;
  }
  return true;
}

/** Finds the probable index of the header row in the raw table.
 *
 *  Typical cases:
 *   - row 0 = real header row (standard case) → return 0
 *   - row 0 = catalog title ("Catalogue 2026"), row 1 = real headers
 *     → return 1
 *   - row 0 = "Edition Printemps", row 1 = "Liste des produits", row 2 = headers
 *     → return 2
 *
 *  Heuristic: we scan the first 5 rows and take the first one that has
 *  >= MIN_HEADER_CELLS non-empty cells (= looks like a tabular header, not a
 *  1-cell title).
 *
 *  If none match: return 0 (safe fallback = legacy behavior). */
export function findHeaderRowIndex(rows: unknown[][]): number {
  const MIN_HEADER_CELLS = 3;
  const MAX_SCAN_ROWS = 5;
  if (rows.length === 0) return 0;
  for (let i = 0; i < Math.min(rows.length, MAX_SCAN_ROWS); i++) {
    const r = rows[i] as unknown[];
    const nonEmptyCount = r.filter(
      (c) => cellToString(c).trim().length > 0,
    ).length;
    if (nonEmptyCount >= MIN_HEADER_CELLS) return i;
  }
  return 0;
}

/** Deduplicates the headers by adding a " (2)", " (3)" suffix etc.
 *  Empty strings replaced by "Col1", "Col2"... */
function uniqueHeaders(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  raw.forEach((h, i) => {
    let name = h.trim() || `Col${i + 1}`;
    const n = seen.get(name) ?? 0;
    if (n > 0) name = `${name} (${n + 1})`;
    seen.set(name, n + 1);
    out.push(name);
  });
  return out;
}

/** Keywords (lowercase) that suggest a sheet contains the main product data.
 *  Multi-language. Weighted positively in pickSheet. */
const PRODUCT_SHEET_KEYWORDS = [
  // FR
  'produit', 'produits', 'article', 'articles', 'catalogue', 'gamme',
  // EN
  'product', 'products', 'item', 'items', 'catalog', 'sku',
  // DE
  'produkt', 'produkte', 'artikel', 'katalog',
  // ES
  'producto', 'productos', 'articulo', 'articulos', 'catalogo',
  // IT
  'prodotto', 'prodotti', 'articolo', 'articoli', 'catalogo',
  // PT
  'produto', 'produtos', 'artigo', 'artigos', 'catalogo',
];

/** Negative keywords: metadata / instructions / config sheets that we do NOT
 *  want to pick as the product sheet. */
const NON_PRODUCT_SHEET_KEYWORDS = [
  'note', 'notes', 'readme', 'lisez-moi', 'instruction', 'instructions',
  'mode emploi', 'aide', 'help', 'config', 'parametre', 'parametres',
  'reference', 'refs', 'glossaire', 'glossary', 'changelog', 'historique',
  'about', 'a propos',
];

/**
 * State of an ExcelJS sheet. 'visible' = visible in the Excel UI, 'hidden'
 * = hidden but re-showable, 'veryHidden' = hidden via VBA, UI-inaccessible.
 */
export type SheetState = 'visible' | 'hidden' | 'veryHidden';

/** Score bonus if the sheet name contains a product keyword
 *  (PRODUCT_SHEET_KEYWORDS). Equivalent to "+200 rows" → typically
 *  outweighs a reasonable cardinality gap. */
const SHEET_KEYWORD_BONUS = 200;
/** Symmetric penalty for the "non-product" keywords (notes, config). */
const SHEET_NEGATIVE_PENALTY = 200;
/** Massive penalty for hidden sheets (hidden/veryHidden).
 *  The goal: NEVER select them unless it's the only one available.
 *  10000 = 10000 equivalent rows → in practice no visible sheet, even a
 *  small one, drops below that. */
const SHEET_HIDDEN_PENALTY = 10000;

/**
 * Selects the sheet most likely to contain the main product data among all
 * non-empty sheets.
 *
 * Score = (rowCount) + bonus_keyword + penalty_non_product + penalty_hidden
 *   - rowCount: number of rows (the most filled sheet wins by default)
 *   - bonus: +200 if name contains "produit"/"product"/etc. (multi-language)
 *   - penalty: -200 if name contains "note"/"readme"/"config"/etc.
 *   - penalty: -10000 if the sheet is hidden (hidden/veryHidden) — we
 *     NEVER want to take it as the main sheet unless it's the only one
 *     available (users typically hide the "config" or "lookup tables"
 *     sheets to declutter the product view)
 *
 * In case of a tie (rare), takes the first sheet (original Excel order).
 */
export function pickProductSheet(
  worksheets: { name: string; rowCount: number; state?: SheetState }[],
): { name: string; index: number } | null {
  if (worksheets.length === 0) return null;
  if (worksheets.length === 1) {
    return { name: worksheets[0].name, index: 0 };
  }

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < worksheets.length; i++) {
    const ws = worksheets[i];
    const nameLower = ws.name.toLowerCase();
    let score = ws.rowCount;
    if (PRODUCT_SHEET_KEYWORDS.some((kw) => nameLower.includes(kw))) {
      score += SHEET_KEYWORD_BONUS;
    }
    if (NON_PRODUCT_SHEET_KEYWORDS.some((kw) => nameLower.includes(kw))) {
      score -= SHEET_NEGATIVE_PENALTY;
    }
    // Strong penalty for hidden sheets: they typically contain lookup tables,
    // parameters, etc. — not the product catalog.
    if (ws.state === 'hidden' || ws.state === 'veryHidden') {
      score -= SHEET_HIDDEN_PENALTY;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return { name: worksheets[bestIdx].name, index: bestIdx };
}

export async function extractXlsx(filePath: string): Promise<XlsxData> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_XLSX_BYTES) {
    throw new Error(`XLSX trop volumineux (${stat.size} octets, max ${MAX_XLSX_BYTES})`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheets = wb.worksheets.map((s) => s.name);

  // Smart product sheet selection: if there are several sheets, we favor the
  // one that contains a "product" keyword in its name or the most filled one.
  // Without this, an XLSX with a first sheet "Notes" would miss the real
  // products.
  const sheetInfos = wb.worksheets.map((s) => ({
    name: s.name,
    rowCount: s.rowCount,
    // ExcelJS exposes s.state: 'visible' / 'hidden' / 'veryHidden'.
    // Safe cast since the value is always within this enum set.
    state: (s as unknown as { state?: SheetState }).state ?? 'visible',
  }));
  const picked = pickProductSheet(sheetInfos);
  const ws = picked ? wb.worksheets[picked.index] : undefined;
  if (!ws) {
    return { kind: 'xlsx', sheets, headers: [], rowCount: 0, rows: [] };
  }

  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    rows.push(values.slice(1));
  });

  // Robust header row detection: skip any titles at the top of the sheet
  // ("Catalogue 2026", "Edition Printemps") that only have 1-2 non-empty
  // cells and are NOT tabular headers.
  const headerIdx = findHeaderRowIndex(rows);
  const rawHeaders = ((rows[headerIdx] as unknown[]) ?? []).map(cellToString);
  const headers = uniqueHeaders(rawHeaders);
  const dataRows = rows.slice(headerIdx + 1);
  // Skip rows where ALL the cells are empty after trim. ExcelJS
  // includeEmpty:false only covers fully empty rows; a row with only
  // whitespace or empty formatted cells passes the filter and pollutes the
  // output (phantom product "Produit N+1").
  const allRows = dataRows
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = cellToString((r as unknown[])[i]);
      });
      return obj;
    })
    .filter((obj) => !isRowAllBlank(obj));

  return {
    kind: 'xlsx',
    sheets,
    headers,
    // rowCount = number of EFFECTIVE rows (post whitespace-only filter). Used
    // for monitoring + UI feedback.
    rowCount: allRows.length,
    rows: allRows,
  };
}
