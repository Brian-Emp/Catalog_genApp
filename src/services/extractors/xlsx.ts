import { promises as fs } from 'fs';
import ExcelJS from 'exceljs';
import type { XlsxData } from '../../types';

const MAX_XLSX_BYTES = Number(process.env.MAX_XLSX_BYTES) || 100 * 1024 * 1024;

/** Convertit une cellule ExcelJS en string lisible.
 *  Gere : strings, nombres, Date, formules (.result), hyperliens (.text),
 *  RichText (.richText[]), null/undefined. */
/** Erreurs Excel (#REF!, #N/A, etc.) traitees comme cellules vides : leur
 *  injection dans les specs polluerait les fiches produit avec du bruit
 *  technique non-informatif. */
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
    // Erreur Excel → cellule vide (evite "#REF!" dans une fiche produit).
    return isExcelError(cell) ? '' : cell;
  }
  if (typeof cell === 'object') {
    const c = cell as Record<string, unknown>;
    // ExcelJS encode les erreurs en { error: '#REF!' } ou { result: { error: ... } }.
    if ('error' in c && typeof c.error === 'string') {
      return ''; // erreur explicite → vide
    }
    if (Array.isArray((c as { richText?: unknown[] }).richText)) {
      return (c.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if ('text' in c && c.text != null) {
      return cellToString(c.text);
    }
    if ('result' in c && c.result != null) {
      // result d'une formule : peut etre un nombre, string, ou erreur
      return cellToString(c.result);
    }
    if ('hyperlink' in c && typeof c.hyperlink === 'string') return c.hyperlink;
    return '';
  }
  const str = String(cell);
  return isExcelError(str) ? '' : str;
}

/** True si TOUTES les cellules de la row sont vides ou whitespace-only.
 *  Sert au filtre post-extraction pour ignorer les separateurs visuels
 *  (lignes vides intercalaires) qui creent des produits fantomes
 *  "Produit N+1" dans le pipeline. */
export function isRowAllBlank(row: Record<string, string>): boolean {
  for (const v of Object.values(row)) {
    if (v != null && String(v).trim().length > 0) return false;
  }
  return true;
}

/** Trouve l'index probable de la ligne header dans le tableau brut.
 *
 *  Cas typiques :
 *   - row 0 = vraie ligne header (cas standard) → return 0
 *   - row 0 = titre du catalogue ("Catalogue 2026"), row 1 = vrais headers
 *     → return 1
 *   - row 0 = "Edition Printemps", row 1 = "Liste des produits", row 2 = headers
 *     → return 2
 *
 *  Heuristique : on scanne les 5 premieres rows et on prend la 1ere qui a
 *  >= MIN_HEADER_CELLS cellules non vides (= ressemble a un header tabulaire,
 *  pas a un titre 1-cell).
 *
 *  Si aucune ne match : return 0 (fallback safe = comportement legacy). */
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

/** Dedupliques les en-tetes en ajoutant un suffixe " (2)", " (3)" etc.
 *  Strings vides remplacees par "Col1", "Col2"... */
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

/** Mots-cles (lowercase) qui suggerent qu'un onglet contient les donnees
 *  produit principales. Multi-langue. Pondere positivement dans pickSheet. */
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

/** Mots-cles negatifs : onglets metadata / instructions / config qu'on ne
 *  veut PAS prendre comme onglet produit. */
const NON_PRODUCT_SHEET_KEYWORDS = [
  'note', 'notes', 'readme', 'lisez-moi', 'instruction', 'instructions',
  'mode emploi', 'aide', 'help', 'config', 'parametre', 'parametres',
  'reference', 'refs', 'glossaire', 'glossary', 'changelog', 'historique',
  'about', 'a propos',
];

/**
 * Etat d'un onglet ExcelJS. 'visible' = visible dans l'UI Excel, 'hidden'
 * = caché mais reaffichable, 'veryHidden' = cache via VBA inacessible UI.
 */
export type SheetState = 'visible' | 'hidden' | 'veryHidden';

/** Bonus de score si le nom de l'onglet contient un mot-cle produit
 *  (PRODUCT_SHEET_KEYWORDS). Equivalent a "+200 rows" → typiquement
 *  prevaut sur un ecart de cardinalite raisonnable. */
const SHEET_KEYWORD_BONUS = 200;
/** Penalite symetrique pour les mots-cles "non-product" (notes, config). */
const SHEET_NEGATIVE_PENALTY = 200;
/** Penalite massive pour les onglets masques (hidden/veryHidden).
 *  Le but : ne JAMAIS les selectionner sauf si c'est le seul disponible.
 *  10000 = 10000 rows equivalentes → en pratique aucun onglet visible
 *  meme petit ne descend en dessous. */
const SHEET_HIDDEN_PENALTY = 10000;

/**
 * Selectionne l'onglet le plus probable de contenir les donnees produit
 * principales parmi tous les onglets non vides.
 *
 * Score = (rowCount) + bonus_keyword + penalty_non_product + penalty_hidden
 *   - rowCount : nb de lignes (l'onglet le plus rempli gagne par defaut)
 *   - bonus : +200 si nom contient "produit"/"product"/etc. (multi-langue)
 *   - penalty : -200 si nom contient "note"/"readme"/"config"/etc.
 *   - penalty : -10000 si l'onglet est masque (hidden/veryHidden) — on
 *     ne veut JAMAIS le prendre comme onglet principal sauf si c'est le
 *     seul disponible (les utilisateurs masquent typiquement les onglets
 *     "config" ou "lookup tables" pour clarifier la vue produit)
 *
 * En cas d'egalite (rare), prend le 1er onglet (ordre Excel original).
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
    // Penalite forte pour les onglets masques : ils contiennent typiquement
    // des tables de lookup, parametres, etc. — pas le catalogue produit.
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

  // Selection intelligente de l'onglet produit : si plusieurs onglets, on
  // privilegie celui qui contient un mot-cle "produit" dans son nom ou le
  // plus rempli. Sans ca, un XLSX avec 1er onglet "Notes" ferait rater les
  // vrais produits.
  const sheetInfos = wb.worksheets.map((s) => ({
    name: s.name,
    rowCount: s.rowCount,
    // ExcelJS expose s.state : 'visible' / 'hidden' / 'veryHidden'.
    // Cast safe car la valeur est toujours dans ce set d'enum.
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

  // Detection robuste de la ligne header : skip eventuels titres en tete
  // de feuille ("Catalogue 2026", "Edition Printemps") qui n'ont qu'1-2
  // cellules non vides et ne sont PAS des headers tabulaires.
  const headerIdx = findHeaderRowIndex(rows);
  const rawHeaders = ((rows[headerIdx] as unknown[]) ?? []).map(cellToString);
  const headers = uniqueHeaders(rawHeaders);
  const dataRows = rows.slice(headerIdx + 1);
  // Skip rows ou TOUTES les cellules sont vides apres trim. ExcelJS
  // includeEmpty:false ne couvre QUE les rows totalement vides ; une row
  // avec uniquement whitespace ou des cellules formatees vides passe le
  // filtre et pollue la sortie (produit fantome "Produit N+1").
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
    // rowCount = nb rows EFFECTIVES (post-filter whitespace-only). Sert au
    // monitoring + UI feedback.
    rowCount: allRows.length,
    rows: allRows,
  };
}
