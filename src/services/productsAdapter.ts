import { promises as fs } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import type { CsvData, ExtractedFile, ProductInput, XlsxData } from '../types';
import { claudeColumnMap } from './claudeColumnMapper';
import { claudeMatchAssets } from './claudeAssetMatcher';
import { stripAccents } from '../v2/engine/textNormalize';

// NAME priority: "designation" (often the real commercial name) before just "code"/"ref"
// Multilingual FR/EN/DE/ES/IT/PT/NL/SE/NO/DK/PL
const NAME_PATTERNS = [
  /^designation/i,
  /^(nom|name|titre|title|libelle.*produit|libelle.*designation)/i,
  /^(product|produit|label|bezeichnung|denominacion|denominación|denomination)/i,
  // IT/PT/NL/SE/PL
  /^(prodotto|nome|articolo|descrizione|descrição|descripcion|descripción|description|produkt|produkter|namn|nazwa|nazwa.*produktu)/i,
  // NO/DK: "navn" (name), "vare" (article), "betegnelse" (designation)
  /^(navn|vare|varenavn|betegnelse|beteckning|varunamn)/i,
  // Common EN variants: item name, product name, display name
  /^(item.*name|product.*name|item.*title|item.*description|display.*name|short.*name)/i,
  // ERP variants: intitule (FR), Bezeichnung (DE already), short_desc
  /^(intitule|short.?desc(ription)?|long.?desc(ription)?)/i,
];
// SKU multilingual: ERP codes / refs vary by country
const SKU_RE = /(sku|ref|reference|referenz|referencia|riferimento|referência|code|codigo|código|id\b|ean|gencod|gtin|isbn|article|artikel|articulo|artículo|artigo|barcode|kod|nr\b|numer|nummer|item.*code|product.*code|art\.?\s?nr|varenr|varenummer|artikelnr|model|modello|modelo|modèle|modell|part.?(number|no|nr)|p\/n)/i;
/** "Color / finish / variant" column pattern — multilingual.
 *  FR: couleur, finition, teinte, coloris, tonalite
 *  EN: color, colour, finish, hue, shade, tint
 *  DE: farbe, farbton, ausfuhrung, ausführung
 *  ES: color, tonalidad, acabado, matiz
 *  IT: colore, finitura, tonalita, tonalità, tinta
 *  PT: cor, acabamento, tonalidade
 *  NO/DK: farve
 *  SE: färg, farg
 *  PL: kolor
 *  Numeric prefix tolerated (e.g. "5 Couleur" for ERP codes). */
const DEFAULT_COLOR_PATTERN = /^(\d+\s+)?(couleur|color|colour|finition|finish|teinte|coloris|hue|shade|tint|tonalite|tonalité|farbe|farbton|ausfuhrung|ausführung|tonalidad|acabado|matiz|colore|finitura|tonalita|tonalità|tinta|cor\b|acabamento|tonalidade|farve|färg|farg|kolor)/i;
// IMAGE multilingual: column names for product photo / visual
// FR: image, photo, visuel, illustration, vignette, miniature
// EN: image, photo, picture, img, thumbnail, snapshot, cover, url
// DE: bild, abbildung, grafik
// ES: imagen, foto
// IT: immagine, fotografia
// PT: imagem, foto
// NO/DK: bilde / billede
// PL: obraz, zdjecie
const IMAGE_RE = /^(image|photo|picture|img|visuel|illustration|bild|bilde|billede|imagen|immagine|imagem|foto|abbildung|grafik|fotografia|miniature|thumbnail|vignette|snapshot|cover|obraz|zdjecie|image[_\s-]?url|photo[_\s-]?url|product[_\s-]?image)s?$/i;
// Fallback patterns (simple heuristic without inspecting the data) - used only
// when the cardinality-based detection yields no result.
const DEFAULT_SECTION_PATTERNS = [
  /libelle[_ ]?ssfamille/i,
  /libelle[_ ]?sfamille/i,
  /libelle[_ ]?famille/i,
  /^(section|categorie|category|categoria|categoría|kategorie|rayon|gamme|rubrik|abteilung|seccion|sección)/i,
];
const DEFAULT_FAMILY_PATTERNS = [
  /^libelle[_ ]?famille$/i,
  /^(famille|family|familie|familia|univers|universe)$/i,
];
const DEFAULT_SUBFAMILY_PATTERNS = [
  /^libelle[_ ]?sfamille$/i,
  /^(sous[_ ]?famille|subfamille|subfamily)$/i,
];

/** Keywords to detect a "category" column (at any level of the hierarchy).
 *  Deliberately broad: covers famille/family/univers/categorie/
 *  rayon/gamme/department/domaine/type/classification/groupe/section...
 *  Language-independent + naming-convention-independent (ssfamille, sub-category,
 *  s_famille, type_produit, code_famille, libellé_produit, etc.). */
const CATEGORY_KEYWORD_RE = /famille|family|familie|familia|univers|category|categori|kategorie|rayon|gamme|rubrik|abteilung|seccion|sección|section|department|departement|domaine|domain|classification|groupe|gruppe|grupo|type[_ ]?produit|product[_ ]?type|kind|sorte|categoria|categoría|gamma|chapitre|partie|niveau|collection|colecao|colección|collezione|kollektion|ligne|range|series|serie|seria|avdelning|kategori|kategoria/i;
/** Minimum distinct values to consider a column a useful category. 1 = we
 *  accept single-value levels (e.g. a unique family "SANITAIRE" in a
 *  single-department catalog); they will be collapsed by groupIntoHierarchy
 *  if redundant for display. */
const CATEGORY_MIN_DISTINCT = 1;
/** Maximum distinct values (beyond that = too specific, it's more likely the
 *  product name or a unique code). */
const CATEGORY_MAX_DISTINCT = 200;

/** Detects the category column hierarchy from the data:
 *  1. Selects the columns whose name matches CATEGORY_KEYWORD_RE
 *  2. Counts the distinct values per column
 *  3. Filters the columns with a useful cardinality (2 to 200 values)
 *  4. Sorts by ascending cardinality (few values = high level)
 *  5. Assigns the first 3 to family / subFamily / section
 *
 *  Works for any catalog without hardcoding column names like ssfamille.
 *  Returns {} if no category column is detected. */
function detectCategoryHierarchy(
  headers: string[],
  rows: Record<string, string>[],
): { family?: string; subFamily?: string; section?: string } {
  const candidates = headers.filter((h) => CATEGORY_KEYWORD_RE.test(h));
  if (candidates.length === 0 || rows.length === 0) return {};

  // Cardinality (number of distinct non-empty values) per candidate column
  const cardinality = new Map<string, number>();
  for (const col of candidates) {
    const vals = new Set<string>();
    for (const row of rows) {
      const v = (row[col] ?? '').trim();
      if (v) vals.add(v);
    }
    cardinality.set(col, vals.size);
  }

  // Filter: we keep only the "useful" columns as a category
  const useful = candidates.filter((c) => {
    const n = cardinality.get(c) ?? 0;
    return n >= CATEGORY_MIN_DISTINCT && n <= CATEGORY_MAX_DISTINCT;
  });
  if (useful.length === 0) return {};

  // Sort by ascending cardinality: fewer values = higher in the hierarchy
  // (e.g. 3 families > 12 subfamilies > 50 sub-subfamilies)
  useful.sort((a, b) => (cardinality.get(a) ?? 0) - (cardinality.get(b) ?? 0));

  // Assign according to the number of useful levels found
  if (useful.length === 1) return { section: useful[0] };
  if (useful.length === 2) return { family: useful[0], section: useful[1] };
  // 3+ levels: we keep the first 3 (family/subFamily/section)
  return { family: useful[0], subFamily: useful[1], section: useful[2] };
}
/** "Technical" XLSX columns to ignore in the specs (= don't display as
 *  key:value on the product sheet). Origin of the ERP patterns:
 *   - bdd_*, date_maj, date_creation, date_modification: conventions
 *     observed on French ERP exports (CEGID, Sage, EBP, etc.).
 *     "bdd" = database; "maj" = update.
 *   - libelle famille/sfamille, gencod: Catalogue A naming (reference catalog
 *     of the V2 pipeline). Generalized to FR conventions.
 *   - created_at, updated_at: modern ORM conventions (Rails, Laravel,
 *     Symfony, Django).
 *
 *  Covered by category:
 *   - Internal ERP codes: bdd_*, attribut, statut, code produit
 *   - Family levels already lifted into the hierarchy: libelle famille/sfamille
 *   - Barcodes already lifted into ref: gencod, gtin, ean, upc, isbn
 *   - Technical identifiers: id, uid, uuid, guid
 *   - Marketing/brand (used elsewhere): marque, nf
 *   - Provenance / supply chain (internal): fournisseur, supplier, vendor,
 *     stock, warehouse, entrepot
 *   - State / lifecycle: obsolete, archive, deleted, inactif
 *   - Meta: version, revision, created_at, updated_at, date_*
 *
 *  Configurable via options.technicalKeyPattern (full override). */
const DEFAULT_TECHNICAL_KEY_PATTERN =
  /^(bdd[_.]|libelle[_ ]?(s?s)?famille|sfamille|ssfamille|gencod|gtin|ean|upc|isbn|attribut|statut|marque$|nf$|code\s?produit$|id$|uid$|uuid$|guid$|fournisseur$|supplier$|vendor$|stock$|warehouse$|entrepot$|obsolete$|archive$|deleted$|inactif$|version$|revision$|rev$|created_at$|updated_at$|date_creation$|date_modification$|date_maj$)/i;
const DEFAULT_ASSET_STRIP_PATTERN = /^\d+-[a-z0-9]{6}-/i;
/** Removes a short numeric prefix (ERP attribute codes like "538 Longueur").
 *  If not applicable to your catalog, override with a pattern that matches
 *  nothing (e.g. "^$") to preserve legitimate prefixes. */
const DEFAULT_HUMANIZE_STRIP_PATTERN = /^\d{1,4}\s+/;

export interface FamilyRibbonRule {
  ribbon: string;
  keywords: string[];
}

/** Maps a raw "family" to the vertical ribbon term via an ordered mapping.
 *  No default: if no mapping is provided, we return the raw family in lower
 *  case (the Python pipeline will still attempt an approximate match). */
function familyToRibbon(raw: string, map: FamilyRibbonRule[] = []): string | undefined {
  if (!raw) return undefined;
  const f = stripAccents(raw).toLowerCase();
  for (const rule of map) {
    for (const kw of rule.keywords) {
      const k = stripAccents(kw).toLowerCase();
      if (k && f.includes(k)) return rule.ribbon;
    }
  }
  return raw.toLowerCase();
}
/** "Empty" or non-informative values to filter out on the specs side.
 *  Multilingual: FR/EN/DE/ES/IT/PT + common ERP variants.
 *  Note: "oui" is filtered because it indicates presence with no further info
 *  (absence or the entire spec is more telling than a repeated "oui").
 *  Case-insensitive + trailing punctuation (cleanValue strips before testing).
 *
 *  Variants covered:
 *  - Refusal: non/no/nein/no(IT/ES)/não
 *  - Degenerate affirmation: oui/yes/ja/si/sim (filters "repeated oui")
 *  - Not applicable: n/a, n.a., nc, nd, n.d., ns, n.s., na
 *  - Empty: vide/empty/null/nil/none/keine/nichts/niente/nessuno/ninguno/nenhum
 *  - Unknown: inconnu/unknown/unbekannt/desconocido/sconosciuto
 *  - Nothing: neant/néant/sans/ohne/senza/sin/sem
 *  - To be defined: tbd/tba/to.?be.?(defined|announced)/var/variable
 *  - Cancelled: void/cancelled/storno/anulado
 *  - Single characters: "-", "—", "–", "0", "x", "?", "." */
const NON_INFORMATIVE_VALUE_RE =
  /^(non|no|nein|nao|não|n\/?a|n\.a\.?|na|nc|nd|n\.d\.?|ns|n\.s\.?|none|null|nil|[-—–‐]+|vide|oui|yes|ja|si|sim|empty|inconnu|unknown|unbekannt|desconocido|sconosciuto|neant|néant|sans|ohne|senza|sin|sem|keine|kein|nicht|nichts|niente|nessuno|nessuna|ninguno|ninguna|nenhum|nenhuma|tbd|tba|var|variable|void|cancelled|storno|anulado|0|x|\?+|\.+)$/i;
/** Image extensions supported for product assets.
 *
 *  Level 1 (native PyMuPDF rendering): png/jpg/jpeg/gif/webp.
 *  Level 2 (decode via standard Pillow): tiff/tif/bmp/jfif/ico.
 *  Level 3 (modern formats, decode via pillow-heif / pillow-avif):
 *    heic/heif/avif. Accepted as input — if the decode fails on the Python
 *    side, the image_missing placeholder is rendered.
 *
 *  The list is deliberately permissive: better to try than to ignore a file
 *  the user provided. */
const IMAGE_EXTS = new Set([
  // Level 1 (always supported)
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  // Level 2 (Pillow standard)
  '.tiff', '.tif', '.bmp', '.jfif', '.ico',
  // Level 3 (best-effort decode)
  '.heic', '.heif', '.avif',
]);
const SCHEMA_EXTS = new Set(['.pdf']);

/** ZIP size limits: reject before alloc to avoid OOM-ing AdmZip (in-memory
 *  loading). Audit #9: lifted to module level. */
const MAX_ZIP_COMPRESSED_BYTES = 300 * 1024 * 1024; // 300 MB
const MAX_ZIP_DECOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/** Minimum ratio of products without a matched image to trigger the Claude
 *  smart matching (audit #13). Below this threshold, the deterministic
 *  prefix/slug matching is sufficient — no point paying for an LLM call.
 *  Above it, we ask Claude to align the product↔asset names by semantic
 *  similarity (useful for assets named "produit_premium_v2.jpg" vs XLSX ref
 *  "ABC123"). */
const SMART_MATCH_TRIGGER_UNMATCHED_RATIO = 0.3;

// stripAccents: see v2/engine/textNormalize.ts (factored out from 4 copies,
// audit #6).

function pickColumn(headers: string[], re: RegExp): string | undefined {
  return headers.find((h) => re.test(stripAccents(h)));
}

function pickColumnByPatterns(headers: string[], patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = headers.find((h) => re.test(stripAccents(h)));
    if (m) return m;
  }
  return undefined;
}

/** Common abbreviations in XLSX → expanded form. Case-insensitive.
 *  Matches as a whole word (boundary `\b`) to avoid false positives
 *  ("temp" matches "temp" and "TEMP" but not "tempête"). */
const ABBREVIATION_MAP: { abbr: RegExp; expanded: string }[] = [
  // FR: dimensional
  { abbr: /\bdim\b/gi, expanded: 'Dimensions' },
  { abbr: /\bdimens\b/gi, expanded: 'Dimensions' },
  { abbr: /\blong\b/gi, expanded: 'Longueur' },
  { abbr: /\bdiam\b/gi, expanded: 'Diamètre' },
  { abbr: /\bdiametre\b/gi, expanded: 'Diamètre' },
  { abbr: /\bhaut\b/gi, expanded: 'Hauteur' },
  { abbr: /\bprof\b/gi, expanded: 'Profondeur' },
  { abbr: /\bep\b/gi, expanded: 'Épaisseur' },
  { abbr: /\bepaiss\b/gi, expanded: 'Épaisseur' },
  { abbr: /\blarg\b/gi, expanded: 'Largeur' },
  { abbr: /\bpds\b/gi, expanded: 'Poids' },
  { abbr: /\bvol\b/gi, expanded: 'Volume' },
  { abbr: /\bsurf\b/gi, expanded: 'Surface' },
  // FR: performance / mechanical
  { abbr: /\bdeb\b/gi, expanded: 'Débit' },
  { abbr: /\bdebit\b/gi, expanded: 'Débit' },
  { abbr: /\btemp\b/gi, expanded: 'Température' },
  { abbr: /\btemper\b/gi, expanded: 'Température' },
  { abbr: /\bpress\b/gi, expanded: 'Pression' },
  { abbr: /\bpuiss\b/gi, expanded: 'Puissance' },
  { abbr: /\bpwr\b/gi, expanded: 'Puissance' },
  { abbr: /\btens\b/gi, expanded: 'Tension' },
  { abbr: /\bintens\b/gi, expanded: 'Intensité' },
  { abbr: /\bfreq\b/gi, expanded: 'Fréquence' },
  { abbr: /\bvit\b/gi, expanded: 'Vitesse' },
  { abbr: /\bvitess\b/gi, expanded: 'Vitesse' },
  { abbr: /\bcap\b/gi, expanded: 'Capacité' },
  // FR: product
  { abbr: /\bmat\b/gi, expanded: 'Matière' },
  { abbr: /\bmatiere\b/gi, expanded: 'Matière' },
  { abbr: /\bcoul\b/gi, expanded: 'Couleur' },
  { abbr: /\bfin\b/gi, expanded: 'Finition' },
  { abbr: /\bref\b/gi, expanded: 'Référence' },
  { abbr: /\bgar\b/gi, expanded: 'Garantie' },
  { abbr: /\bgarantie\b/gi, expanded: 'Garantie' },
  { abbr: /\bcond\b/gi, expanded: 'Conditionnement' },
  { abbr: /\bnb\b/gi, expanded: 'Nombre' },
  { abbr: /\bqte\b/gi, expanded: 'Quantité' },
  { abbr: /\bqnte\b/gi, expanded: 'Quantité' },
  // EN: dimensional (non-conflicting additions to FR)
  { abbr: /\blen\b/gi, expanded: 'Length' },
  { abbr: /\bwid\b/gi, expanded: 'Width' },
  { abbr: /\bhgt\b/gi, expanded: 'Height' },
  { abbr: /\bhght\b/gi, expanded: 'Height' },
  { abbr: /\bwgt\b/gi, expanded: 'Weight' },
  { abbr: /\bqty\b/gi, expanded: 'Quantity' },
  { abbr: /\bqnty\b/gi, expanded: 'Quantity' },
  // Note: "min", "max", "moy", "avg" intentionally not expanded — these are
  // qualifiers ("Diam MAX", "Temp MIN") rather than primary keys, and
  // expanding them would break existing compounds.
];

/** Cache of the rebuilt unicode-safe regexes (perf: avoids recompiling on
 *  every call). Key = original ASCII source. */
const UNICODE_ABBR_CACHE = new Map<string, RegExp>();

/** Rebuilds an abbreviation regex with UNICODE-aware boundaries.
 *  JS's native `\b` is ASCII: it treats accented letters (è, é, à...) as
 *  NON-word characters, so `/\bdiam\b/` matches "diam" inside "diamètre"
 *  → bug "Diamètre"+"ètre" = "Diamètreètre". We replace the `\b` with
 *  lookarounds on \p{L}\p{N} (flag u) to treat accents as letters. Exported
 *  for testing. */
export function toUnicodeBoundaryRegex(abbr: RegExp): RegExp {
  const cached = UNICODE_ABBR_CACHE.get(abbr.source);
  if (cached) { cached.lastIndex = 0; return cached; }
  const src = abbr.source
    .replace(/^\\b/, '(?<![\\p{L}\\p{N}_])')
    .replace(/\\b$/, '(?![\\p{L}\\p{N}_])');
  const re = new RegExp(src, 'giu');
  UNICODE_ABBR_CACHE.set(abbr.source, re);
  return re;
}

/** Expands the common abbreviations in a string (without touching the rest). */
export function expandAbbreviations(text: string): string {
  let out = text;
  for (const { abbr, expanded } of ABBREVIATION_MAP) {
    out = out.replace(toUnicodeBoundaryRegex(abbr), expanded);
  }
  return out;
}

/** Humanizes a raw spec key:
 *  "538 Longueur bras de douche" -> "LONGUEUR BRAS DE DOUCHE :"
 *  "538_Longueur"               -> "LONGUEUR :" (ERP separator `_` normalized before strip)
 *  "Mécanisme"                  -> "MÉCANISME :"
 *  "DEB_PRESS"                  -> "DÉBIT PRESSION :" (abbreviations expanded)
 *  Removes numeric prefixes (internal attribute codes), uppercases, appends
 *  " :" at the end to match the style of templates like Catalogue A.
 *
 *  IMPORTANT ORDER: we replace the ERP separators (`_`/`-`) with spaces
 *  BEFORE stripping the numeric prefix. Otherwise "538_Longueur" keeps its
 *  "538" which has no space after it (the strip pattern requires `\s+`). */
function humanizeKey(raw: string, stripPattern: RegExp = DEFAULT_HUMANIZE_STRIP_PATTERN): string {
  let k = raw.trim();
  // 1. ERP separators → spaces (before strip to expose "538 X" to the pattern)
  k = k.replace(/[_\-]+/g, ' ');
  // 2. Strip short numeric prefix ("538 ")
  k = k.replace(stripPattern, '');
  // 3. Expand abbreviations + normalize spaces
  k = expandAbbreviations(k);
  k = k.replace(/\s+/g, ' ').trim();
  if (!k) return '';
  return k.toUpperCase() + ' :';
}

/** Strips symmetric surrounding quotes (', ", `, «», ‹›, “”) if they wrap the
 *  whole string. Useful for XLSX or CSV exported with excessive quoting
 *  ("'Inox'" becomes "Inox", '«Eco»' becomes "Eco").
 *  Keeps internal quotes (e.g. Butée «Eco-stop» keeps the guillemets). */
function stripSurroundingQuotes(s: string): string {
  const QUOTE_PAIRS: Array<[string, string]> = [
    ["'", "'"], ['"', '"'], ['`', '`'],
    ['«', '»'], ['‹', '›'], ['“', '”'],
  ];
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length) {
      const inner = s.slice(open.length, s.length - close.length).trim();
      // Returns the trimmed content (can be empty for "''" → "").
      return inner;
    }
  }
  return s;
}

function cleanValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s) return null;
  // Strip surrounding quotes (XLSX/CSV with excessive quoting)
  s = stripSurroundingQuotes(s);
  if (!s) return null;
  // Strip common trailing punctuation (".", "...", ",", ";", ":") before the
  // test to match "N/A.", "N.D.,", "tbd..." as non-informative.
  const stripped = s.replace(/[.,;:]+$/g, '').trim();
  if (!stripped) return null;
  if (NON_INFORMATIVE_VALUE_RE.test(stripped)) return null;
  return s;
}

/**
 * Splits an XLSX/CSV cell into several logical values when the content uses
 * an EXPLICIT separator (newline, pipe " | ", semicolon " ; ").
 * Does NOT split on a plain comma or on "x" (ambiguous with composite
 * dimensions and compound names).
 *
 * Cases covered:
 *   "60 cm\n80 cm\n100 cm"  → ["60 cm", "80 cm", "100 cm"]
 *   "Inox | Chrome | Doré"  → ["Inox", "Chrome", "Doré"]
 *   "5 ans ; 2 ans accessoires" → ["5 ans", "2 ans accessoires"]
 *   "Acier inox"            → ["Acier inox"]  (no separator)
 *   "60x80x30"              → ["60x80x30"]    (no newline/pipe/semi)
 *   "Mat, brillant"         → ["Mat, brillant"] (plain comma: ambiguous)
 *
 * Filters empty or non-informative segments after the split. */
export function splitMultiValue(value: string): string[] {
  if (!value) return [];
  // Pattern: newline OR " | " OR " ; " (pipe and semicolon must be
  // surrounded by whitespace to avoid splitting "5|6" internal code or
  // "n;n" formula).
  const parts = value
    .split(/\r?\n|\s+\|\s+|\s+;\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Filter out non-informative segments (after the split, "N/A" / "-" can
  // appear as a separate element).
  return parts.filter((p) => {
    const stripped = p.replace(/[.,;:]+$/g, '').trim();
    return stripped.length > 0 && !NON_INFORMATIVE_VALUE_RE.test(stripped);
  });
}

interface AssetEntry {
  /** Absolute path accessible by the Python engine. */
  absPath: string;
  /** Base name without extension, lowercase. For prefix matching. */
  baseLower: string;
  /** image = product photo (jpg/png/...), schema = technical schema (pdf). */
  kind: 'image' | 'schema';
}

interface AssetIndex {
  entries: AssetEntry[];
  byBaseLower: Map<string, AssetEntry>;
}

/** Loads the images from the asset files (direct images + ZIPs) and copies
 *  them into assetsOutDir. Returns an index for later matching. */
async function buildAssetIndex(
  assetFiles: ExtractedFile[],
  assetsOutDir: string,
  stripPattern: RegExp | null = DEFAULT_ASSET_STRIP_PATTERN,
): Promise<AssetIndex> {
  await fs.mkdir(assetsOutDir, { recursive: true });
  const taken = new Set<string>();
  const entries: AssetEntry[] = [];

  function uniqueName(base: string): string {
    let candidate = base;
    let i = 1;
    while (taken.has(candidate.toLowerCase())) {
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      candidate = `${stem}_${i}${ext}`;
      i++;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  }

  for (const f of assetFiles) {
    if (f.kind === 'image') {
      const original = path.basename(f.originalName);
      const cleaned = stripPattern ? original.replace(stripPattern, '') : original;
      const finalName = uniqueName(cleaned);
      const absPath = path.join(assetsOutDir, finalName);
      await fs.copyFile(f.storedPath, absPath);
      entries.push({
        absPath,
        baseLower: finalName.replace(/\.[^.]+$/, '').toLowerCase(),
        kind: 'image',
      });
    } else if (f.kind === 'zip') {
      // Guard before alloc: AdmZip loads the entire file into memory.
      // Reject ZIPs > MAX_ZIP_COMPRESSED_BYTES to avoid OOM-ing the server.
      try {
        const st = await fs.stat(f.storedPath);
        if (st.size > MAX_ZIP_COMPRESSED_BYTES) {
          throw new Error(
            `ZIP trop volumineux (${Math.round(st.size / 1024 / 1024)}MB > ${
              MAX_ZIP_COMPRESSED_BYTES / 1024 / 1024
            }MB) : ${f.originalName}`,
          );
        }
      } catch (err) {
        throw new Error(`ZIP inaccessible (${f.originalName}) : ${(err as Error).message}`);
      }
      let zip: AdmZip;
      try {
        zip = new AdmZip(f.storedPath);
      } catch (err) {
        throw new Error(`ZIP corrompu (${f.originalName}) : ${(err as Error).message}`);
      }
      let totalWritten = 0;
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        // Zip-slip defense: we ignore entries with separators or ".."
        // (POSIX and Windows). Plus path.basename to keep only the name.
        const rawName = entry.entryName ?? '';
        if (rawName.includes('..') || /[\\\\]/.test(rawName)) continue;
        const base = path.basename(rawName);
        const ext = path.extname(base).toLowerCase();
        const isImage = IMAGE_EXTS.has(ext);
        const isSchema = SCHEMA_EXTS.has(ext);
        if (!isImage && !isSchema) continue;
        if (base.startsWith('.')) continue;
        const data = entry.getData();
        totalWritten += data.length;
        if (totalWritten > MAX_ZIP_DECOMPRESSED_BYTES) {
          throw new Error(
            `ZIP assets decompresse trop volumineux (>${MAX_ZIP_DECOMPRESSED_BYTES} octets)`,
          );
        }
        const finalName = uniqueName(base);
        const absPath = path.join(assetsOutDir, finalName);
        // Final check: absPath must stay under the resolved assetsOutDir.
        const resolved = path.resolve(absPath);
        const baseAbs = path.resolve(assetsOutDir);
        if (!resolved.startsWith(baseAbs + path.sep)) continue;
        await fs.writeFile(absPath, data);
        entries.push({
          absPath,
          baseLower: finalName.replace(/\.[^.]+$/, '').toLowerCase(),
          kind: isSchema ? 'schema' : 'image',
        });
      }
    }
  }
  // Lookup map: raw baseLower (with accents) + accent-stripped variant to
  // match XLSX refs entered without accents.
  // Example: asset "Mégère.jpg" → keys "mégère" AND "megere".
  // The raw entry takes precedence on conflict (rare in practice).
  const byBaseLower = new Map<string, AssetEntry>();
  for (const e of entries) {
    byBaseLower.set(e.baseLower, e);
    const stripped = stripAccents(e.baseLower);
    if (stripped !== e.baseLower && !byBaseLower.has(stripped)) {
      byBaseLower.set(stripped, e);
    }
  }
  return { entries, byBaseLower };
}

/** All the values of the "identifier" columns (sku/ref/ean/gencod) of a row,
 *  sorted by decreasing length (matching prioritizes full codes over prefixes). */
function identifierValues(row: Record<string, string>, headers: string[]): string[] {
  const cols = headers.filter((h) => SKU_RE.test(stripAccents(h)));
  const vals = cols
    .map((c) => row[c]?.trim())
    .filter((v): v is string => !!v && v.length >= 3);
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}

/** Normalizes a string for tolerant matching: lowercase + alphanumeric +
 *  no accents. Allows matching:
 *   - "999100 0001234" with "999100_0001234" or "9991000001234"
 *   - "Mégère" (asset) with "MEGERE" (XLSX ref without accents)
 *   - "Cafetière" with "cafetiere"
 *
 *  Before: the accents fell into the [^a-z0-9] strip → "Mégère" became
 *  "mgre" (4 chars lost). Now: strip accents NFD first, then filter to ASCII
 *  → "megere" (semantic preservation). */
function normForMatch(s: string): string {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findByPrefix(index: AssetIndex, candidate: string, kind: 'image' | 'schema' = 'image'): AssetEntry | undefined {
  const c = candidate.toLowerCase();
  const exact = index.byBaseLower.get(c);
  if (exact && exact.kind === kind) return exact;
  // Symmetric accent-insensitive lookup: also try the stripped candidate.
  // Typical case: XLSX candidate "Mégère" + asset "megere.jpg" (without
  // accent) → Map key "megere" matches.
  const cStripped = stripAccents(c);
  if (cStripped !== c) {
    const exactStripped = index.byBaseLower.get(cStripped);
    if (exactStripped && exactStripped.kind === kind) return exactStripped;
  }
  for (const e of index.entries) if (e.kind === kind && e.baseLower.startsWith(c)) return e;
  for (const e of index.entries) if (e.kind === kind && e.baseLower.includes(c)) return e;
  // Inverse match: the candidate (XLSX ref) CONTAINS the asset's baseLower.
  // Typical case: a zero-padded or prefixed/suffixed XLSX ref ("REF-AB12-2024")
  // matches asset "ab12.jpg". We require baseLower >= 4 chars to avoid
  // matching stems that are too short and would create false positives.
  for (const e of index.entries) {
    if (e.kind !== kind) continue;
    if (e.baseLower.length >= 4 && c.includes(e.baseLower)) return e;
  }
  // Tolerant matching: we remove punctuation/spaces on both sides
  const cn = normForMatch(candidate);
  if (cn.length >= 3) {
    for (const e of index.entries) {
      if (e.kind === kind && normForMatch(e.baseLower).includes(cn)) return e;
    }
    // Tolerant inverse match
    for (const e of index.entries) {
      if (e.kind !== kind) continue;
      const bn = normForMatch(e.baseLower);
      if (bn.length >= 4 && cn.includes(bn)) return e;
    }
  }
  // Leading-zeros variant: an ERP often exports refs zero-padded ("0012345"
  // XLSX) whereas the assets are named without ("12345.jpg"). We try the
  // candidate without leading zeros, AND we try adding zeros if the candidate
  // is shorter than the baseLower.
  const cnNoZeros = cn.replace(/^0+/, '');
  if (cnNoZeros.length >= 3 && cnNoZeros !== cn) {
    for (const e of index.entries) {
      if (e.kind === kind && normForMatch(e.baseLower).includes(cnNoZeros)) return e;
    }
  }
  // Inverse: candidate without zeros, baseLower with → we also strip the
  // leading zeros of the baseLower before comparing.
  if (cn.length >= 3) {
    for (const e of index.entries) {
      if (e.kind !== kind) continue;
      const bnNoZeros = normForMatch(e.baseLower).replace(/^0+/, '');
      if (bnNoZeros.length >= 3 && bnNoZeros.includes(cn)) return e;
    }
  }
  return undefined;
}

/** Non-decomposable transliterations (characters that have no NFD form with
 *  separable diacritics). Essential to preserve the informative content when
 *  slugifying multilingual names (German "ß", Scandinavian "ø", Polish "ł",
 *  Icelandic "ð/þ", Latin ligatures).
 *
 *  Without this table, "Straße" becomes "stra-e" instead of "strasse" and no
 *  longer matches the asset "strasse.jpg". */
const TRANSLIT_MAP: Record<string, string> = {
  // German
  'ß': 'ss', 'ẞ': 'SS',
  // Latin ligatures
  'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE',
  'ﬁ': 'fi', 'ﬂ': 'fl',
  // Scandinavian / Nordic
  'ø': 'o', 'Ø': 'O',
  'å': 'a', 'Å': 'A', // also handled by NFD but explicit here
  // Icelandic
  'ð': 'd', 'Ð': 'D',
  'þ': 'th', 'Þ': 'TH',
  // Polish
  'ł': 'l', 'Ł': 'L',
  // Turkish / Central Europe
  'ı': 'i', 'İ': 'I',
  // Common symbols in commercial names
  '&': 'and', '@': 'at', '+': 'plus',
};

/** Applies the transliterations before stripAccents. Idempotent. */
function transliterate(s: string): string {
  let out = '';
  for (const ch of s) {
    out += TRANSLIT_MAP[ch] ?? ch;
  }
  return out;
}

function slugify(s: string): string {
  return stripAccents(transliterate(s).toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Finds the image corresponding to a product row:
 *  1) explicit 'image' column if present
 *  2) otherwise by identifiers (ref, sku, ean, gencod) — prefix match
 *  3) otherwise by name slug — substring match
 */
function matchAsset(
  row: Record<string, string>,
  headers: string[],
  cols: { name?: string; image?: string },
  index: AssetIndex,
  kind: 'image' | 'schema' = 'image',
): AssetEntry | undefined {
  if (kind === 'image' && cols.image && row[cols.image]) {
    const v = row[cols.image].trim();
    // Strip query params (?v=2) and fragment (#anchor) BEFORE path.basename:
    // a CSV exported from a CMS often contains URLs like
    // "https://cdn.example.com/products/AB1234.jpg?v=2&w=800". Without
    // stripping, baseNoExt would become "AB1234.jpg?v=2&w=800" (wrong match).
    const cleaned = v.split(/[?#]/)[0];
    const baseNoExt = path.basename(cleaned).replace(/\.[^.]+$/, '').toLowerCase();
    const exact = index.byBaseLower.get(baseNoExt);
    if (exact && exact.kind === kind) return exact;
    return findByPrefix(index, baseNoExt, kind);
  }
  for (const id of identifierValues(row, headers)) {
    const hit = findByPrefix(index, id, kind);
    if (hit) return hit;
  }
  if (cols.name && row[cols.name]) {
    const slug = slugify(row[cols.name]);
    if (slug) {
      // findByPrefix uses startsWith / includes / inverse match / tolerant
      // normForMatch → covers long names ("Mitigeur Évier Pro Avec Bec
      // Pivotant" matches asset "mitigeur-pro.jpg" via inverse).
      const hit = findByPrefix(index, slug, kind);
      if (hit) return hit;
    }
  }
  return undefined;
}

function buildProductFromRow(
  row: Record<string, string>,
  headers: string[],
  cols: { name?: string; sku?: string; color?: string; image?: string; section?: string; family?: string; subFamily?: string },
  fallbackIdx: number,
  assetIndex: AssetIndex,
  ribbonMap: FamilyRibbonRule[],
  technicalKeyRe: RegExp,
  humanizeStripRe: RegExp,
): ProductInput | null {
  // Fallback cascade for the name:
  //   1. detected name column (designation/nom/etc.)
  //   2. sku/ref column (if name is empty, better than a generic placeholder)
  //   3. generic "Produit N+1" as a last resort
  const nameFromCol = cols.name && row[cols.name] ? String(row[cols.name]).trim() : '';
  const refFromCol = cols.sku && row[cols.sku] ? String(row[cols.sku]).trim() : '';
  const rawName = nameFromCol || refFromCol || `Produit ${fallbackIdx + 1}`;
  const name = String(rawName).trim();
  if (!name) return null;

  const ref = cols.sku ? cleanValue(row[cols.sku]) ?? '' : '';
  const color = cols.color ? cleanValue(row[cols.color]) ?? '' : '';
  const section = cols.section ? cleanValue(row[cols.section]) ?? '' : '';
  const subFamily = cols.subFamily ? cleanValue(row[cols.subFamily]) ?? '' : '';
  const familyRaw = cols.family ? cleanValue(row[cols.family]) ?? '' : '';
  const family = familyToRibbon(familyRaw, ribbonMap) ?? familyToRibbon(section, ribbonMap);

  const specs: { key: string; value: string }[] = [];
  const skipped = new Set(
    [cols.name, cols.sku, cols.color, cols.image, cols.section, cols.family, cols.subFamily].filter(Boolean) as string[],
  );
  for (const h of headers) {
    if (skipped.has(h)) continue;
    if (technicalKeyRe.test(stripAccents(h))) continue;
    const v = cleanValue(row[h]);
    if (!v) continue;
    const k = humanizeKey(h, humanizeStripRe);
    if (!k) continue;
    specs.push({ key: k, value: v });
  }

  const matched = matchAsset(row, headers, cols, assetIndex, 'image');
  const matchedSchema = matchAsset(row, headers, cols, assetIndex, 'schema');

  return {
    name,
    ref: ref || undefined,
    color: color || undefined,
    section: section || undefined,
    family: family || undefined,
    subFamily: subFamily || undefined,
    specs: specs.length ? specs : undefined,
    image_path: matched ? matched.absPath : undefined,
    schema_path: matchedSchema ? matchedSchema.absPath : undefined,
  };
}

export interface BuildProductOptions {
  /** Override of the family -> vertical ribbon mapping. Default = empty. */
  familyRibbonMap?: FamilyRibbonRule[];
  /** Regex patterns (string) for the section/sub-category column. */
  sectionColumnPatterns?: string[];
  /** Regex patterns (string) for the macro family column. */
  familyColumnPatterns?: string[];
  /** Regex pattern (string) for the color/finish column. */
  colorColumnPattern?: string;
  /** Regex pattern (string) for the technical columns to ignore. */
  technicalKeyPattern?: string;
  /** Regex pattern (string) to clean up asset names. Empty = no cleanup;
   *  null/absent = default (timestamp-hash- from multer uploads). */
  assetNameStripPattern?: string;
  /** Regex pattern (string) to remove a prefix from a spec key during
   *  humanization (e.g. "538 Longueur" -> "Longueur"). Empty = no cleanup;
   *  absent = default (short ERP numeric prefix). */
  humanizeStripPattern?: string;
  /** Enables smart mapping via Claude when the heuristic has a gap (name
   *  falls back to first col, sku/section/family missing). Default true. */
  enableSmartMapping?: boolean;
  /** Enables image matching via Claude when the heuristic fails (> 30% of
   *  products without an image and assets available). Default true. */
  enableSmartImageMatching?: boolean;
  /** Project root directory (to expose .claude/skills/ to the CLI). */
  projectDir?: string;
  /** Path of the claude binary (override of PATH/CLAUDE_BIN). */
  claudeBin?: string;
}

function compileRegex(
  pattern: string | undefined,
  fallback: RegExp,
  label?: string,
  warnings?: string[],
): RegExp {
  if (!pattern) return fallback;
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    if (warnings && label) {
      warnings.push(`Pattern ${label} invalide ("${pattern}") : ${(err as Error).message}. Defaut applique.`);
    }
    return fallback;
  }
}

function compileRegexList(
  patterns: string[] | undefined,
  fallback: RegExp[],
  label?: string,
  warnings?: string[],
): RegExp[] {
  if (!patterns || !patterns.length) return fallback;
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, 'i'));
    } catch (err) {
      if (warnings && label) {
        warnings.push(`Pattern ${label} invalide ("${p}") : ${(err as Error).message}. Ignore.`);
      }
    }
  }
  return out.length ? out : fallback;
}

export interface BuiltProductInputs {
  products: ProductInput[];
  assetsDir: string;
  matchedImageCount: number;
  /** Rows or files skipped with their cause (regex not matched, unexpected
   *  type, etc.). Does NOT fail the pipeline. */
  warnings: string[];
}

/** Converts the CSV/XLSX files + assets into a list of ProductInput (with image_path if matched).
 *  Robust to exotic data: each row is processed in an isolated try/catch,
 *  failures are surfaced as warnings without blocking the batch. */
export async function buildProductInputs(
  files: ExtractedFile[],
  workDir: string,
  options: BuildProductOptions = {},
): Promise<BuiltProductInputs> {
  const warnings: string[] = [];
  const ribbonMap = options.familyRibbonMap ?? [];
  const sectionPatterns = compileRegexList(options.sectionColumnPatterns, DEFAULT_SECTION_PATTERNS, 'section_column_patterns', warnings);
  const familyPatterns = compileRegexList(options.familyColumnPatterns, DEFAULT_FAMILY_PATTERNS, 'family_column_patterns', warnings);
  const colorRe = compileRegex(options.colorColumnPattern, DEFAULT_COLOR_PATTERN, 'color_column_pattern', warnings);
  const technicalKeyRe = compileRegex(options.technicalKeyPattern, DEFAULT_TECHNICAL_KEY_PATTERN, 'technical_key_pattern', warnings);
  const humanizeStripRe = options.humanizeStripPattern === ''
    ? /(?!)/  // never matches => no strip
    : compileRegex(options.humanizeStripPattern, DEFAULT_HUMANIZE_STRIP_PATTERN, 'humanize_strip_pattern', warnings);
  let assetStripRe: RegExp | null = DEFAULT_ASSET_STRIP_PATTERN;
  if (options.assetNameStripPattern !== undefined) {
    if (options.assetNameStripPattern === '') {
      assetStripRe = null;
    } else {
      try {
        assetStripRe = new RegExp(options.assetNameStripPattern, 'i');
      } catch (err) {
        warnings.push(`Pattern asset_name_strip_pattern invalide ("${options.assetNameStripPattern}") : ${(err as Error).message}. Defaut applique.`);
      }
    }
  }

  const dataFiles = files.filter(
    (f) => f.category === 'data' && (f.kind === 'csv' || f.kind === 'xlsx'),
  );
  const assetFiles = files.filter(
    (f) => f.category === 'assets' && (f.kind === 'image' || f.kind === 'zip'),
  );

  const assetsDir = path.join(workDir, 'assets');
  const assetIndex = await buildAssetIndex(assetFiles, assetsDir, assetStripRe);

  if (!dataFiles.length) {
    warnings.push('Aucun fichier de donnees (CSV/XLSX) detecte dans les uploads.');
  }
  if (!assetFiles.length) {
    warnings.push('Aucun fichier d\'assets detecte (les images produits ne pourront pas etre substituees).');
  }

  const products: ProductInput[] = [];
  const refSeen = new Map<string, number>();
  for (const f of dataFiles) {
    let data: CsvData | XlsxData;
    try {
      data = f.extracted as CsvData | XlsxData;
      if (!Array.isArray(data.headers) || !Array.isArray(data.rows)) {
        warnings.push(`Fichier ${f.originalName} ignore : structure inattendue (headers/rows manquants)`);
        continue;
      }
    } catch (err) {
      warnings.push(`Fichier ${f.originalName} ignore : ${(err as Error).message}`);
      continue;
    }

    if (!data.rows.length) {
      warnings.push(`Fichier ${f.originalName} : aucune ligne de donnees.`);
      continue;
    }

    let cols: ReturnType<typeof detectCols>;
    try {
      cols = detectCols(
        data.headers,
        { sectionPatterns, familyPatterns, colorRe },
        data.rows as Record<string, string>[],
      );
    } catch (err) {
      warnings.push(`Fichier ${f.originalName} : detection des colonnes echouee (${(err as Error).message})`);
      continue;
    }
    if (!cols.name) {
      warnings.push(`Fichier ${f.originalName} : aucune colonne de nom detectable`);
      continue;
    }
    // Surface the detected category columns (useful for debugging XLSX where
    // the coarse hierarchy doesn't trigger as expected).
    {
      const parts: string[] = [];
      if (cols.family) parts.push(`famille="${cols.family}"`);
      if (cols.subFamily) parts.push(`sfamille="${cols.subFamily}"`);
      if (cols.section) parts.push(`section="${cols.section}"`);
      if (parts.length > 0) {
        warnings.push(`Colonnes catégorie détectées dans ${f.originalName} : ${parts.join(', ')}`);
      } else {
        warnings.push(`${f.originalName} : aucune colonne catégorie détectée (vérifie noms : famille/family/univers/section/categorie/rayon/gamme/...)`);
      }
    }
    const nameByPattern = pickColumnByPatterns(data.headers, NAME_PATTERNS);
    const heuristicHasGap = !nameByPattern || !cols.sku || !cols.section || !cols.family;

    // Claude smart mapping: called only if the heuristic has a gap, to avoid
    // unnecessary costs when the regex mapping is complete.
    if (heuristicHasGap && options.enableSmartMapping !== false && options.projectDir) {
      try {
        // Try Gemini first (free + no auth expiration). If unavailable or it
        // fails, fall back to the Claude CLI (which can also fail if the token
        // is expired).
        const heuristic = {
          name: nameByPattern ?? null,
          sku: cols.sku ?? null,
          color: cols.color ?? null,
          image: cols.image ?? null,
          section: cols.section ?? null,
          family: cols.family ?? null,
        };
        const { geminiColumnMap } = await import('../v2/gemini/smartMapping');
        let mapped = await geminiColumnMap({
          headers: data.headers,
          sampleRows: data.rows.slice(0, 3) as Record<string, string>[],
          heuristic,
          enabled: true,
        });
        // Claude fallback if Gemini failed (no key, API error)
        if (!mapped.ran || !mapped.mapping) {
          mapped = await claudeColumnMap({
            headers: data.headers,
            sampleRows: data.rows.slice(0, 3) as Record<string, string>[],
            workDir,
            projectDir: options.projectDir,
            claudeBin: options.claudeBin,
            heuristic,
            enabled: true,
          });
        }
        if (mapped.ran && mapped.mapping) {
          const added: string[] = [];
          if (!nameByPattern && mapped.mapping.name && mapped.mapping.name !== cols.name) {
            cols.name = mapped.mapping.name;
            added.push(`name="${mapped.mapping.name}"`);
          }
          if (!cols.sku && mapped.mapping.sku) {
            cols.sku = mapped.mapping.sku;
            added.push(`sku="${mapped.mapping.sku}"`);
          }
          if (!cols.color && mapped.mapping.color) {
            cols.color = mapped.mapping.color;
            added.push(`color="${mapped.mapping.color}"`);
          }
          if (!cols.image && mapped.mapping.image) {
            cols.image = mapped.mapping.image;
            added.push(`image="${mapped.mapping.image}"`);
          }
          if (!cols.section && mapped.mapping.section) {
            cols.section = mapped.mapping.section;
            added.push(`section="${mapped.mapping.section}"`);
          }
          if (!cols.family && mapped.mapping.family) {
            cols.family = mapped.mapping.family;
            added.push(`family="${mapped.mapping.family}"`);
          }
          if (added.length) {
            warnings.push(
              `${f.originalName} : Claude a complete le mapping (${added.join(', ')})`
                + (mapped.costUsd !== undefined ? ` cout ~$${mapped.costUsd.toFixed(3)}` : ''),
            );
          }
        } else if (mapped.notes.length) {
          warnings.push(`${f.originalName} : claude column mapping skip — ${mapped.notes[0]}`);
        }
      } catch (err) {
        warnings.push(`${f.originalName} : claude column mapping echec (${(err as Error).message})`);
      }
    }

    // Residual warnings after smart mapping. `cols.name` is never null
    // because detectCols falls back to headers[0]. We flag the fallback when
    // NO pattern matched (= the heuristic guessed, it may be wrong).
    if (!nameByPattern) {
      warnings.push(
        `${f.originalName} : aucune colonne de nom matchee. Fallback sur "${cols.name}" (1ere colonne). `
        + `Verifie les headers ou ajuste les patterns.`,
      );
    }
    if (!cols.sku) {
      warnings.push(`${f.originalName} : aucune colonne ref/SKU detectee. Le matching d'images par ref sera moins fiable.`);
    }
    if (!cols.family) {
      warnings.push(`${f.originalName} : aucune colonne famille detectee. Le ruban vertical de section ne sera pas substitue.`);
    }
    if (!cols.section) {
      warnings.push(`${f.originalName} : aucune colonne sous-categorie/section detectee. Le bandeau de section ne sera pas substitue.`);
    }

    let added = 0;
    for (let i = 0; i < data.rows.length; i++) {
      try {
        const product = buildProductFromRow(data.rows[i], data.headers, cols, i, assetIndex, ribbonMap, technicalKeyRe, humanizeStripRe);
        if (product) {
          if (product.ref) {
            const seen = refSeen.get(product.ref);
            if (seen !== undefined) {
              warnings.push(
                `${f.originalName} ligne ${i + 2} : ref "${product.ref}" deja vue ligne ${seen + 2} (le second produit ecrasera l'image matchee si meme asset).`,
              );
            } else {
              refSeen.set(product.ref, i);
            }
          }
          products.push(product);
          added += 1;
        }
      } catch (err) {
        warnings.push(`${f.originalName} ligne ${i + 2} : ${(err as Error).message}`);
      }
    }
    if (added === 0) {
      warnings.push(`${f.originalName} : aucun produit construit (toutes les lignes vides ou invalides).`);
    }
  }

  if (!products.length) {
    warnings.push('Aucun produit construit au total. Le pipeline va echouer cote moteur.');
  }
  let matchedImageCount = products.filter((p) => p.image_path).length;

  // Claude smart image matching: a second pass over the orphaned products
  // when > 30% have no image AND assets are available. Helps recover the
  // cases where the slug/ref heuristic doesn't match (exotic asset names).
  if (
    products.length > 0
    && assetIndex.entries.length > 0
    && options.enableSmartImageMatching !== false
    && options.projectDir
  ) {
    const unmatchedRatio = (products.length - matchedImageCount) / products.length;
    if (unmatchedRatio > SMART_MATCH_TRIGGER_UNMATCHED_RATIO) {
      const unmatched = products
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => !p.image_path)
        .map(({ p, idx }) => ({ idx, name: p.name, ref: p.ref ?? null }));
      const assetsForMatch = assetIndex.entries.map((e) => ({ baseName: e.baseLower, absPath: e.absPath }));
      try {
        // Try Gemini first (free + no expiration). Claude fallback if Gemini
        // is unavailable / API error.
        const { geminiMatchAssets } = await import('../v2/gemini/imageMatcher');
        let matched: {
          matched: { idx: number; absPath: string }[];
          ran: boolean;
          notes: string[];
          costUsd?: number;
        } = await geminiMatchAssets({
          unmatchedProducts: unmatched,
          assets: assetsForMatch,
          enabled: true,
        });
        if (!matched.ran || matched.matched.length === 0) {
          matched = await claudeMatchAssets({
            unmatchedProducts: unmatched,
            assets: assetsForMatch,
            workDir,
            projectDir: options.projectDir,
            claudeBin: options.claudeBin,
            enabled: true,
          });
        }
        for (const m of matched.matched) {
          if (products[m.idx] && !products[m.idx].image_path) {
            products[m.idx].image_path = m.absPath;
            matchedImageCount++;
          }
        }
        if (matched.matched.length > 0) {
          warnings.push(
            `Claude a matche ${matched.matched.length} image(s) supplementaire(s)`
              + (matched.costUsd !== undefined ? ` (cout ~$${matched.costUsd.toFixed(3)})` : ''),
          );
        } else if (matched.notes.length > 0) {
          warnings.push(`asset matcher skip : ${matched.notes[0]}`);
        }
      } catch (err) {
        warnings.push(`asset matcher echec : ${(err as Error).message}`);
      }
    }
  }

  if (products.length && matchedImageCount === 0 && assetFiles.length) {
    warnings.push(
      `${products.length} produit(s) construits mais aucune image matchee. `
      + `Verifie les noms d'assets vs les refs/noms produits, ou la colonne image.`,
    );
  } else if (products.length && matchedImageCount < products.length) {
    warnings.push(
      `${products.length - matchedImageCount} produit(s) sur ${products.length} sans image matchee.`,
    );
  }
  return { products, assetsDir, matchedImageCount, warnings };
}

/** Detects the columns via the patterns. Isolated so it can be try/catch'd
 *  individually (e.g. a header with a weird Unicode character that blows up a
 *  regex). */
function detectCols(
  headers: string[],
  patterns: {
    sectionPatterns: RegExp[];
    familyPatterns: RegExp[];
    subFamilyPatterns?: RegExp[];
    colorRe: RegExp;
  } = {
    sectionPatterns: DEFAULT_SECTION_PATTERNS,
    familyPatterns: DEFAULT_FAMILY_PATTERNS,
    subFamilyPatterns: DEFAULT_SUBFAMILY_PATTERNS,
    colorRe: DEFAULT_COLOR_PATTERN,
  },
  /** If provided: we automatically detect the hierarchy via the cardinality
   *  of the values (generic, independent of specific column names). */
  rows?: Record<string, string>[],
) {
  // Priority 1: auto-detection via cardinality (generic, works for any
  // catalog where the category columns contain a hierarchical keyword)
  const auto = rows && rows.length > 0
    ? detectCategoryHierarchy(headers, rows)
    : {};

  // Priority 2: fallback regex patterns (simple heuristic if auto yields nothing)
  const sectionCol = auto.section ?? pickColumnByPatterns(headers, patterns.sectionPatterns);
  const familyCol = auto.family ?? pickColumnByPatterns(headers, patterns.familyPatterns);
  const subFamilyCol = auto.subFamily
    ?? pickColumnByPatterns(headers, patterns.subFamilyPatterns ?? DEFAULT_SUBFAMILY_PATTERNS);

  return {
    name: pickColumnByPatterns(headers, NAME_PATTERNS) ?? headers[0],
    sku: pickColumn(headers, SKU_RE),
    color: pickColumn(headers, patterns.colorRe),
    image: pickColumn(headers, IMAGE_RE),
    section: sectionCol,
    family: familyCol,
    subFamily: subFamilyCol,
  };
}

/** Helpers exposed for unit tests only. Do not consume from production
 *  code. */
export const __testing = {
  stripAccents,
  humanizeKey,
  cleanValue,
  slugify,
  normForMatch,
  identifierValues,
  findByPrefix,
  matchAsset,
  familyToRibbon,
  detectCols,
  expandAbbreviations,
  splitMultiValue,
  IMAGE_EXTS,
  SCHEMA_EXTS,
  DEFAULT_TECHNICAL_KEY_PATTERN,
  CATEGORY_KEYWORD_RE,
};
