import { promises as fs } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import type { CsvData, ExtractedFile, ProductInput, XlsxData } from '../types';
import { claudeColumnMap } from './claudeColumnMapper';
import { claudeMatchAssets } from './claudeAssetMatcher';
import { stripAccents } from '../v2/engine/textNormalize';

// Priorite NAME : "designation" (souvent le vrai nom commercial) avant juste "code"/"ref"
// Multilingue FR/EN/DE/ES/IT/PT/NL/SE/NO/DK/PL
const NAME_PATTERNS = [
  /^designation/i,
  /^(nom|name|titre|title|libelle.*produit|libelle.*designation)/i,
  /^(product|produit|label|bezeichnung|denominacion|denominación|denomination)/i,
  // IT/PT/NL/SE/PL
  /^(prodotto|nome|articolo|descrizione|descrição|descripcion|descripción|description|produkt|produkter|namn|nazwa|nazwa.*produktu)/i,
  // NO/DK : "navn" (nom), "vare" (article), "betegnelse" (designation)
  /^(navn|vare|varenavn|betegnelse|beteckning|varunamn)/i,
  // Variantes EN courantes : item name, product name, display name
  /^(item.*name|product.*name|item.*title|item.*description|display.*name|short.*name)/i,
  // Variantes ERP : intitule (FR), Bezeichnung (DE déjà), short_desc
  /^(intitule|short.?desc(ription)?|long.?desc(ription)?)/i,
];
// SKU multilingue : codes ERP / refs varient selon les pays
const SKU_RE = /(sku|ref|reference|referenz|referencia|riferimento|referência|code|codigo|código|id\b|ean|gencod|gtin|isbn|article|artikel|articulo|artículo|artigo|barcode|kod|nr\b|numer|nummer|item.*code|product.*code|art\.?\s?nr|varenr|varenummer|artikelnr|model|modello|modelo|modèle|modell|part.?(number|no|nr)|p\/n)/i;
/** Pattern de colonne "couleur / finition / variante" — multilingue.
 *  FR : couleur, finition, teinte, coloris, tonalite
 *  EN : color, colour, finish, hue, shade, tint
 *  DE : farbe, farbton, ausfuhrung, ausführung
 *  ES : color, tonalidad, acabado, matiz
 *  IT : colore, finitura, tonalita, tonalità, tinta
 *  PT : cor, acabamento, tonalidade
 *  NO/DK : farve
 *  SE : färg, farg
 *  PL : kolor
 *  Prefixe numerique tolere (ex "5 Couleur" pour codes ERP). */
const DEFAULT_COLOR_PATTERN = /^(\d+\s+)?(couleur|color|colour|finition|finish|teinte|coloris|hue|shade|tint|tonalite|tonalité|farbe|farbton|ausfuhrung|ausführung|tonalidad|acabado|matiz|colore|finitura|tonalita|tonalità|tinta|cor\b|acabamento|tonalidade|farve|färg|farg|kolor)/i;
// IMAGE multilingue : noms de colonnes pour photo / visuel produit
// FR : image, photo, visuel, illustration, vignette, miniature
// EN : image, photo, picture, img, thumbnail, snapshot, cover, url
// DE : bild, abbildung, grafik
// ES : imagen, foto
// IT : immagine, fotografia
// PT : imagem, foto
// NO/DK : bilde / billede
// PL : obraz, zdjecie
const IMAGE_RE = /^(image|photo|picture|img|visuel|illustration|bild|bilde|billede|imagen|immagine|imagem|foto|abbildung|grafik|fotografia|miniature|thumbnail|vignette|snapshot|cover|obraz|zdjecie|image[_\s-]?url|photo[_\s-]?url|product[_\s-]?image)s?$/i;
// Patterns de fallback (heuristique simple sans inspecter les data) - utilisés
// uniquement quand la détection par cardinalité ne donne pas de résultat.
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

/** Mots-clés pour détecter une colonne "catégorie" (à tout niveau de la
 *  hiérarchie). Volontairement large : couvre famille/family/univers/categorie/
 *  rayon/gamme/department/domaine/type/classification/groupe/section...
 *  Indépendant de la langue + des conventions de nommage (ssfamille, sub-category,
 *  s_famille, type_produit, code_famille, libellé_produit, etc.). */
const CATEGORY_KEYWORD_RE = /famille|family|familie|familia|univers|category|categori|kategorie|rayon|gamme|rubrik|abteilung|seccion|sección|section|department|departement|domaine|domain|classification|groupe|gruppe|grupo|type[_ ]?produit|product[_ ]?type|kind|sorte|categoria|categoría|gamma|chapitre|partie|niveau|collection|colecao|colección|collezione|kollektion|ligne|range|series|serie|seria|avdelning|kategori|kategoria/i;
/** Min de valeurs distinctes pour considérer une colonne comme catégorie
 *  utile. 1 = on accepte les niveaux mono-valeur (ex famille unique
 *  "SANITAIRE" dans un catalogue mono-département) ; ils seront collapsed
 *  par groupIntoHierarchy si redondants pour l'affichage. */
const CATEGORY_MIN_DISTINCT = 1;
/** Max de valeurs distinctes (au-delà = trop spécifique, c'est plutôt le nom
 *  du produit ou un code unique). */
const CATEGORY_MAX_DISTINCT = 200;

/** Détecte la hiérarchie des colonnes catégorie à partir des données :
 *  1. Sélectionne les colonnes dont le nom matche CATEGORY_KEYWORD_RE
 *  2. Compte les valeurs distinctes par colonne
 *  3. Filtre les colonnes avec une cardinalité utile (2 à 200 valeurs)
 *  4. Trie par cardinalité croissante (peu de valeurs = niveau haut)
 *  5. Assigne les 3 premières à family / subFamily / section
 *
 *  Fonctionne pour n'importe quel catalogue sans hardcoder les noms de
 *  colonnes type ssfamille. Retourne {} si aucune colonne catégorie détectée. */
function detectCategoryHierarchy(
  headers: string[],
  rows: Record<string, string>[],
): { family?: string; subFamily?: string; section?: string } {
  const candidates = headers.filter((h) => CATEGORY_KEYWORD_RE.test(h));
  if (candidates.length === 0 || rows.length === 0) return {};

  // Cardinalité (nombre de valeurs distinctes non vides) par colonne candidate
  const cardinality = new Map<string, number>();
  for (const col of candidates) {
    const vals = new Set<string>();
    for (const row of rows) {
      const v = (row[col] ?? '').trim();
      if (v) vals.add(v);
    }
    cardinality.set(col, vals.size);
  }

  // Filtre : on garde uniquement les colonnes "utiles" comme catégorie
  const useful = candidates.filter((c) => {
    const n = cardinality.get(c) ?? 0;
    return n >= CATEGORY_MIN_DISTINCT && n <= CATEGORY_MAX_DISTINCT;
  });
  if (useful.length === 0) return {};

  // Tri par cardinalité croissante : moins de valeurs = plus haut dans
  // la hiérarchie (ex: 3 familles > 12 sfamilles > 50 ssfamilles)
  useful.sort((a, b) => (cardinality.get(a) ?? 0) - (cardinality.get(b) ?? 0));

  // Assigne selon le nombre de niveaux utiles trouvés
  if (useful.length === 1) return { section: useful[0] };
  if (useful.length === 2) return { family: useful[0], section: useful[1] };
  // 3+ niveaux : on garde les 3 premiers (family/subFamily/section)
  return { family: useful[0], subFamily: useful[1], section: useful[2] };
}
/** Colonnes XLSX "techniques" a ignorer dans les specs (= ne pas afficher
 *  comme cle:valeur sur la fiche produit). Origine des patterns ERP :
 *   - bdd_*, date_maj, date_creation, date_modification : conventions
 *     observees sur des exports d'ERP francais (CEGID, Sage, EBP, etc.).
 *     "bdd" = base de donnees ; "maj" = mise a jour.
 *   - libelle famille/sfamille, gencod : naming Catalogue A (catalogue
 *     de reference du pipeline V2). Generalise aux conventions FR.
 *   - created_at, updated_at : conventions ORM modernes (Rails, Laravel,
 *     Symfony, Django).
 *
 *  Couvre par categorie :
 *   - Codes ERP internes : bdd_*, attribut, statut, code produit
 *   - Niveaux famille deja remontes en hierarchie : libelle famille/sfamille
 *   - Codes barres deja remontes en ref : gencod, gtin, ean, upc, isbn
 *   - Identifiants techniques : id, uid, uuid, guid
 *   - Marketing/marque (utilise ailleurs) : marque, nf
 *   - Provenance / supply chain (interne) : fournisseur, supplier, vendor,
 *     stock, warehouse, entrepot
 *   - Etat / cycle de vie : obsolete, archive, deleted, inactif
 *   - Meta : version, revision, created_at, updated_at, date_*
 *
 *  Configurable via options.technicalKeyPattern (override complet). */
const DEFAULT_TECHNICAL_KEY_PATTERN =
  /^(bdd[_.]|libelle[_ ]?(s?s)?famille|sfamille|ssfamille|gencod|gtin|ean|upc|isbn|attribut|statut|marque$|nf$|code\s?produit$|id$|uid$|uuid$|guid$|fournisseur$|supplier$|vendor$|stock$|warehouse$|entrepot$|obsolete$|archive$|deleted$|inactif$|version$|revision$|rev$|created_at$|updated_at$|date_creation$|date_modification$|date_maj$)/i;
const DEFAULT_ASSET_STRIP_PATTERN = /^\d+-[a-z0-9]{6}-/i;
/** Retire un prefixe numerique court (codes attributs ERP type "538 Longueur").
 *  Si non applicable a ton catalogue, override avec un pattern qui ne matche
 *  rien (ex: "^$") pour preserver les prefixes legitimes. */
const DEFAULT_HUMANIZE_STRIP_PATTERN = /^\d{1,4}\s+/;

export interface FamilyRibbonRule {
  ribbon: string;
  keywords: string[];
}

/** Mappe une "famille" brute vers le terme du ruban vertical via mapping ordonne.
 *  Aucun defaut : si aucun mapping fourni, on retourne la famille brute en lower
 *  (le pipeline Python tentera quand meme un match approximatif). */
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
/** Valeurs "vides" ou non-informatives à filtrer côté specs.
 *  Multilingue : FR/EN/DE/ES/IT/PT + variantes ERP courantes.
 *  Note : "oui" est filtré car indique présence sans plus d'info (l'absence
 *  ou la spec entière est plus parlante que "oui" répété).
 *  Insensible casse + ponctuation finale (cleanValue strip avant test).
 *
 *  Variantes couvertes :
 *  - Refus : non/no/nein/no(IT/ES)/não
 *  - Affirmation degénérante : oui/yes/ja/si/sim (filtre "oui répété")
 *  - Non applicable : n/a, n.a., nc, nd, n.d., ns, n.s., na
 *  - Vide : vide/empty/null/nil/none/keine/nichts/niente/nessuno/ninguno/nenhum
 *  - Inconnu : inconnu/unknown/unbekannt/desconocido/sconosciuto
 *  - Néant : neant/néant/sans/ohne/senza/sin/sem
 *  - À définir : tbd/tba/to.?be.?(defined|announced)/var/variable
 *  - Annulé : void/cancelled/storno/anulado
 *  - Caractères seuls : "-", "—", "–", "0", "x", "?", "." */
const NON_INFORMATIVE_VALUE_RE =
  /^(non|no|nein|nao|não|n\/?a|n\.a\.?|na|nc|nd|n\.d\.?|ns|n\.s\.?|none|null|nil|[-—–‐]+|vide|oui|yes|ja|si|sim|empty|inconnu|unknown|unbekannt|desconocido|sconosciuto|neant|néant|sans|ohne|senza|sin|sem|keine|kein|nicht|nichts|niente|nessuno|nessuna|ninguno|ninguna|nenhum|nenhuma|tbd|tba|var|variable|void|cancelled|storno|anulado|0|x|\?+|\.+)$/i;
/** Extensions image supportees pour les assets produit.
 *
 *  Niveau 1 (rendu PyMuPDF natif) : png/jpg/jpeg/gif/webp.
 *  Niveau 2 (decode via Pillow standard) : tiff/tif/bmp/jfif/ico.
 *  Niveau 3 (formats modernes, decode via pillow-heif / pillow-avif) :
 *    heic/heif/avif. Acceptes en input — si le decode echoue cote Python,
 *    le placeholder image_missing est rendu.
 *
 *  La liste est volontairement permissive : mieux vaut tenter qu'ignorer
 *  un fichier que l'utilisateur a fourni. */
const IMAGE_EXTS = new Set([
  // Niveau 1 (always supported)
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  // Niveau 2 (Pillow standard)
  '.tiff', '.tif', '.bmp', '.jfif', '.ico',
  // Niveau 3 (best-effort decode)
  '.heic', '.heif', '.avif',
]);
const SCHEMA_EXTS = new Set(['.pdf']);

/** Limites taille ZIP : refus avant alloc pour eviter d'OOM AdmZip
 *  (chargement en memoire). Audit #9 : hisses au niveau module. */
const MAX_ZIP_COMPRESSED_BYTES = 300 * 1024 * 1024; // 300 MB
const MAX_ZIP_DECOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/** Ratio minimum de produits sans image matchee pour declencher le smart
 *  matching Claude (audit #13). Sous ce seuil, le matching deterministe
 *  par prefix/slug est suffisant — pas la peine de payer un appel LLM.
 *  Au-dessus, on demande a Claude d'aligner les noms produit↔asset par
 *  similarite semantique (utile pour assets nommes "produit_premium_v2.jpg"
 *  vs ref XLSX "ABC123"). */
const SMART_MATCH_TRIGGER_UNMATCHED_RATIO = 0.3;

// stripAccents : voir v2/engine/textNormalize.ts (factorise depuis 4 copies,
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

/** Abbréviations courantes dans les XLSX → forme étendue. Insensible casse.
 *  Match en tant que mot entier (boundary `\b`) pour éviter les faux positifs
 *  ("temp" matche "temp" et "TEMP" mais pas "tempête"). */
const ABBREVIATION_MAP: { abbr: RegExp; expanded: string }[] = [
  // FR : dimensionnel
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
  // FR : performance / mecanique
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
  // FR : produit
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
  // EN : dimensionnel (ajouts non conflictuels FR)
  { abbr: /\blen\b/gi, expanded: 'Length' },
  { abbr: /\bwid\b/gi, expanded: 'Width' },
  { abbr: /\bhgt\b/gi, expanded: 'Height' },
  { abbr: /\bhght\b/gi, expanded: 'Height' },
  { abbr: /\bwgt\b/gi, expanded: 'Weight' },
  { abbr: /\bqty\b/gi, expanded: 'Quantity' },
  { abbr: /\bqnty\b/gi, expanded: 'Quantity' },
  // Note : "min", "max", "moy", "avg" intentionnellement non expansés —
  // ce sont des qualifiers ("Diam MAX", "Temp MIN") plutot que des keys
  // principales, et leur expansion casserait des composes existants.
];

/** Cache des regex unicode-safe reconstruites (perf : evite de recompiler a
 *  chaque appel). Clé = source ASCII d'origine. */
const UNICODE_ABBR_CACHE = new Map<string, RegExp>();

/** Reconstruit une regex d'abreviation avec des frontieres UNICODE-aware.
 *  Le `\b` natif de JS est ASCII : il considere les lettres accentuees (è, é,
 *  à...) comme des NON-mots, donc `/\bdiam\b/` matche "diam" dans "diamètre"
 *  → bug "Diamètre"+"ètre" = "Diamètreètre". On remplace les `\b` par des
 *  lookaround sur \p{L}\p{N} (flag u) pour traiter les accents comme des
 *  lettres. Exporte pour test. */
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

/** Expand les abbréviations courantes dans une chaîne (sans toucher au reste). */
export function expandAbbreviations(text: string): string {
  let out = text;
  for (const { abbr, expanded } of ABBREVIATION_MAP) {
    out = out.replace(toUnicodeBoundaryRegex(abbr), expanded);
  }
  return out;
}

/** Humanise une cle de spec brute :
 *  "538 Longueur bras de douche" -> "LONGUEUR BRAS DE DOUCHE :"
 *  "538_Longueur"               -> "LONGUEUR :" (separateur ERP `_` normalize avant strip)
 *  "Mécanisme"                  -> "MÉCANISME :"
 *  "DEB_PRESS"                  -> "DÉBIT PRESSION :" (abbréviations expandées)
 *  Retire prefixes numeriques (codes attributs internes), met en majuscules,
 *  ajoute " :" en fin pour matcher le style des templates type Catalogue A.
 *
 *  ORDRE IMPORTANT : on remplace les separateurs ERP (`_`/`-`) par des
 *  espaces AVANT le strip prefix numerique. Sinon "538_Longueur" garde
 *  son "538" qui n'a pas d'espace apres (le strip pattern exige `\s+`). */
function humanizeKey(raw: string, stripPattern: RegExp = DEFAULT_HUMANIZE_STRIP_PATTERN): string {
  let k = raw.trim();
  // 1. Separateurs ERP → espaces (avant strip pour exposer "538 X" au pattern)
  k = k.replace(/[_\-]+/g, ' ');
  // 2. Strip prefix numerique court ("538 ")
  k = k.replace(stripPattern, '');
  // 3. Expand abbreviations + normalize spaces
  k = expandAbbreviations(k);
  k = k.replace(/\s+/g, ' ').trim();
  if (!k) return '';
  return k.toUpperCase() + ' :';
}

/** Strip les quotes englobantes symetriques (', ", `, «», ‹›, “”) si elles
 *  encadrent toute la chaine. Utile pour XLSX ou CSV exportes avec quoting
 *  excessif ("'Inox'" devient "Inox", '«Eco»' devient "Eco").
 *  Conserve les quotes internes (ex Butée «Eco-stop» garde les guillemets). */
function stripSurroundingQuotes(s: string): string {
  const QUOTE_PAIRS: Array<[string, string]> = [
    ["'", "'"], ['"', '"'], ['`', '`'],
    ['«', '»'], ['‹', '›'], ['“', '”'],
  ];
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length) {
      const inner = s.slice(open.length, s.length - close.length).trim();
      // Retourne le contenu trim (peut etre vide pour "''" → "").
      return inner;
    }
  }
  return s;
}

function cleanValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s) return null;
  // Strip quotes englobantes (XLSX/CSV avec quoting excessif)
  s = stripSurroundingQuotes(s);
  if (!s) return null;
  // Strip ponctuation finale courante (".", "...", ",", ";", ":") avant
  // test pour matcher "N/A.", "N.D.,", "tbd..." comme non-informatives.
  const stripped = s.replace(/[.,;:]+$/g, '').trim();
  if (!stripped) return null;
  if (NON_INFORMATIVE_VALUE_RE.test(stripped)) return null;
  return s;
}

/**
 * Split une cell XLSX/CSV en plusieurs values logiques quand le contenu
 * utilise un separateur EXPLICITE (newline, pipe " | ", semi-colon " ; ").
 * Ne split PAS sur virgule simple ni sur "x" (ambigus avec dimensions
 * composites et noms composes).
 *
 * Cas couverts :
 *   "60 cm\n80 cm\n100 cm"  → ["60 cm", "80 cm", "100 cm"]
 *   "Inox | Chrome | Doré"  → ["Inox", "Chrome", "Doré"]
 *   "5 ans ; 2 ans accessoires" → ["5 ans", "2 ans accessoires"]
 *   "Acier inox"            → ["Acier inox"]  (pas de separateur)
 *   "60x80x30"              → ["60x80x30"]    (pas de newline/pipe/semi)
 *   "Mat, brillant"         → ["Mat, brillant"] (virgule simple : ambigu)
 *
 * Filtre les segments vides ou non-informatives apres split. */
export function splitMultiValue(value: string): string[] {
  if (!value) return [];
  // Pattern : newline OU " | " OU " ; " (pipe et semicolon doivent etre
  // entoures de whitespace pour eviter de split "5|6" code interne ou
  // "n;n" formule).
  const parts = value
    .split(/\r?\n|\s+\|\s+|\s+;\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // Filtre les segments non-informatives (apres split, "N/A" / "-" peuvent
  // apparaitre comme element separe).
  return parts.filter((p) => {
    const stripped = p.replace(/[.,;:]+$/g, '').trim();
    return stripped.length > 0 && !NON_INFORMATIVE_VALUE_RE.test(stripped);
  });
}

interface AssetEntry {
  /** Path absolu accessible par le moteur Python. */
  absPath: string;
  /** Nom de base sans extension, en lowercase. Pour matching par prefix. */
  baseLower: string;
  /** image = photo produit (jpg/png/...), schema = schema technique (pdf). */
  kind: 'image' | 'schema';
}

interface AssetIndex {
  entries: AssetEntry[];
  byBaseLower: Map<string, AssetEntry>;
}

/** Charge les images depuis les fichiers assets (images directes + ZIPs)
 *  et les copie dans assetsOutDir. Retourne un index pour matching ulterieur. */
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
      // Garde-fou avant alloc : AdmZip charge le fichier entier en memoire.
      // Refuse les ZIPs > MAX_ZIP_COMPRESSED_BYTES pour eviter d'OOM le serveur.
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
        // Defense zip-slip : on ignore les entries avec separateurs ou ".."
        // (POSIX et Windows). Plus path.basename pour ne garder que le nom.
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
        // Verif finale : absPath doit rester sous assetsOutDir resolve.
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
  // Map de lookup : baseLower brut (avec accents) + variante stripped
  // accents pour matcher des refs XLSX saisies sans accents.
  // Exemple : asset "Mégère.jpg" → keys "mégère" ET "megere".
  // L'entry brute prime si conflit (rare en pratique).
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

/** Toutes les valeurs des colonnes "identifiant" (sku/ref/ean/gencod) d'une ligne,
 *  triees par longueur decroissante (matching priorise les codes complets sur les prefixes). */
function identifierValues(row: Record<string, string>, headers: string[]): string[] {
  const cols = headers.filter((h) => SKU_RE.test(stripAccents(h)));
  const vals = cols
    .map((c) => row[c]?.trim())
    .filter((v): v is string => !!v && v.length >= 3);
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}

/** Normalise une chaine pour matching tolerant : minuscules + alphanum + sans
 *  accents. Permet de matcher :
 *   - "999100 0001234" avec "999100_0001234" ou "9991000001234"
 *   - "Mégère" (asset) avec "MEGERE" (ref XLSX sans accents)
 *   - "Cafetière" avec "cafetiere"
 *
 *  Avant : les accents tombaient dans le strip [^a-z0-9] → "Mégère" devenait
 *  "mgre" (4 chars perdus). Maintenant : strip accents NFD d'abord, puis
 *  filtre ASCII → "megere" (preservation semantique). */
function normForMatch(s: string): string {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findByPrefix(index: AssetIndex, candidate: string, kind: 'image' | 'schema' = 'image'): AssetEntry | undefined {
  const c = candidate.toLowerCase();
  const exact = index.byBaseLower.get(c);
  if (exact && exact.kind === kind) return exact;
  // Lookup symetrique accent-insensible : essaye aussi le candidate
  // stripped. Cas typique : candidate XLSX "Mégère" + asset "megere.jpg"
  // (sans accent) → cle Map "megere" matche.
  const cStripped = stripAccents(c);
  if (cStripped !== c) {
    const exactStripped = index.byBaseLower.get(cStripped);
    if (exactStripped && exactStripped.kind === kind) return exactStripped;
  }
  for (const e of index.entries) if (e.kind === kind && e.baseLower.startsWith(c)) return e;
  for (const e of index.entries) if (e.kind === kind && e.baseLower.includes(c)) return e;
  // Match inverse : candidate (ref XLSX) CONTIENT le baseLower de l'asset.
  // Cas typique : ref XLSX zero-padded ou prefixee/suffixee ("REF-AB12-2024")
  // matche asset "ab12.jpg". On exige baseLower >= 4 chars pour eviter de
  // matcher des stems trop courts qui creeraient des faux positifs.
  for (const e of index.entries) {
    if (e.kind !== kind) continue;
    if (e.baseLower.length >= 4 && c.includes(e.baseLower)) return e;
  }
  // Matching tolerant : on retire ponctuation/espaces des deux cotes
  const cn = normForMatch(candidate);
  if (cn.length >= 3) {
    for (const e of index.entries) {
      if (e.kind === kind && normForMatch(e.baseLower).includes(cn)) return e;
    }
    // Match inverse tolerant
    for (const e of index.entries) {
      if (e.kind !== kind) continue;
      const bn = normForMatch(e.baseLower);
      if (bn.length >= 4 && cn.includes(bn)) return e;
    }
  }
  // Variante leading zeros : un ERP exporte souvent les refs zero-padded
  // ("0012345" XLSX) tandis que les assets sont nommes sans ("12345.jpg").
  // On essaye le candidate sans leading zeros, ET on essaye d'ajouter des
  // zeros si le candidate est plus court que le baseLower.
  const cnNoZeros = cn.replace(/^0+/, '');
  if (cnNoZeros.length >= 3 && cnNoZeros !== cn) {
    for (const e of index.entries) {
      if (e.kind === kind && normForMatch(e.baseLower).includes(cnNoZeros)) return e;
    }
  }
  // Inverse : candidate sans zeros, baseLower avec → on strip aussi les
  // leading zeros du baseLower avant compare.
  if (cn.length >= 3) {
    for (const e of index.entries) {
      if (e.kind !== kind) continue;
      const bnNoZeros = normForMatch(e.baseLower).replace(/^0+/, '');
      if (bnNoZeros.length >= 3 && bnNoZeros.includes(cn)) return e;
    }
  }
  return undefined;
}

/** Translitterations non-decomposables (caracteres qui n'ont pas de forme
 *  NFD avec diacritiques separables). Indispensable pour preserver le
 *  contenu informatif lors du slugify de noms multilingues (allemand "ß",
 *  scandinave "ø", polonais "ł", islandais "ð/þ", ligatures latines).
 *
 *  Sans cette table, "Straße" devient "stra-e" au lieu de "strasse" et
 *  ne match plus l'asset "strasse.jpg". */
const TRANSLIT_MAP: Record<string, string> = {
  // Allemand
  'ß': 'ss', 'ẞ': 'SS',
  // Ligatures latines
  'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE',
  'ﬁ': 'fi', 'ﬂ': 'fl',
  // Scandinave / nordique
  'ø': 'o', 'Ø': 'O',
  'å': 'a', 'Å': 'A', // gere aussi par NFD mais explicite ici
  // Islandais
  'ð': 'd', 'Ð': 'D',
  'þ': 'th', 'Þ': 'TH',
  // Polonais
  'ł': 'l', 'Ł': 'L',
  // Turc / centre-europe
  'ı': 'i', 'İ': 'I',
  // Symboles courants dans noms commerciaux
  '&': 'and', '@': 'at', '+': 'plus',
};

/** Applique les translitterations avant stripAccents. Idempotent. */
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

/** Trouve l'image correspondant a une ligne produit :
 *  1) colonne 'image' explicite si presente
 *  2) sinon par identifiants (ref, sku, ean, gencod) — prefix match
 *  3) sinon par slug du nom — substring match
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
    // Strip query params (?v=2) et fragment (#anchor) AVANT path.basename :
    // CSV exporte depuis CMS contient souvent des URLs type
    // "https://cdn.example.com/products/AB1234.jpg?v=2&w=800". Sans strip,
    // baseNoExt deviendrait "AB1234.jpg?v=2&w=800" (faux match).
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
      // findByPrefix utilise startsWith / includes / match inverse /
      // normForMatch tolerant → couvre les noms longs ("Mitigeur Évier Pro
      // Avec Bec Pivotant" matche asset "mitigeur-pro.jpg" via inverse).
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
  // Cascade de fallback pour le nom :
  //   1. colonne name detectee (designation/nom/etc.)
  //   2. colonne sku/ref (si name vide, mieux qu'un placeholder generique)
  //   3. "Produit N+1" generique en dernier recours
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
  /** Override du mapping famille -> ruban vertical. Defaut = vide. */
  familyRibbonMap?: FamilyRibbonRule[];
  /** Patterns regex (string) pour la colonne section/sous-categorie. */
  sectionColumnPatterns?: string[];
  /** Patterns regex (string) pour la colonne famille macro. */
  familyColumnPatterns?: string[];
  /** Pattern regex (string) pour la colonne couleur/finition. */
  colorColumnPattern?: string;
  /** Pattern regex (string) pour les colonnes techniques a ignorer. */
  technicalKeyPattern?: string;
  /** Pattern regex (string) pour nettoyer les noms d'assets. Vide = pas de
   *  nettoyage ; null/absent = defaut (timestamp-hash- d'uploads multer). */
  assetNameStripPattern?: string;
  /** Pattern regex (string) pour retirer un prefixe d'une cle de spec lors de
   *  l'humanisation (ex: "538 Longueur" -> "Longueur"). Vide = pas de
   *  nettoyage ; absent = defaut (prefixe numerique court ERP). */
  humanizeStripPattern?: string;
  /** Active le mapping intelligent par Claude quand l'heuristique a un trou
   *  (name fallback sur 1ere col, sku/section/family absents). Default true. */
  enableSmartMapping?: boolean;
  /** Active le matching d'images par Claude quand l'heuristique echoue
   *  (> 30% des produits sans image et assets dispo). Default true. */
  enableSmartImageMatching?: boolean;
  /** Repertoire racine du projet (pour exposer .claude/skills/ a la CLI). */
  projectDir?: string;
  /** Path du binaire claude (override de PATH/CLAUDE_BIN). */
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
  /** Lignes ou fichiers ignores avec leur cause (regex non matchee, type
   *  inattendu, etc.). Ne fait PAS echouer le pipeline. */
  warnings: string[];
}

/** Convertit les fichiers CSV/XLSX + assets en liste de ProductInput (avec image_path si matchee).
 *  Robuste aux donnees exotiques : chaque ligne est traitee dans un try/catch
 *  isole, les echecs sont remontes en warnings sans bloquer le batch. */
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
    ? /(?!)/  // ne matche jamais => pas de strip
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
    // Surface des colonnes catégorie détectées (utile pour debug XLSX où la
    // hiérarchie sommaire ne se déclenche pas comme prévu).
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

    // Smart mapping Claude : appele uniquement si l'heuristique a un trou,
    // pour eviter les couts inutiles quand le mapping regex est complet.
    if (heuristicHasGap && options.enableSmartMapping !== false && options.projectDir) {
      try {
        // Tente Gemini en premier (gratuit + pas d'expiration auth). Si
        // indispo ou echec, fallback sur Claude CLI (qui peut aussi echouer
        // si token expire).
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
        // Fallback Claude si Gemini a echoue (pas de cle, erreur API)
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

    // Warnings residuels apres smart mapping. Le `cols.name` n'est jamais
    // null car detectCols fallback sur headers[0]. On signale le fallback
    // quand AUCUN pattern n'a matché (= heuristique a deviné, peut être faux).
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

  // Smart image matching par Claude : second pass sur les produits orphelins
  // quand > 30% sans image ET assets dispo. Permet de rattraper les cas ou
  // l'heuristique de slug/ref ne matche pas (noms d'assets exotiques).
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
        // Tente Gemini en premier (gratuit + sans expiration). Fallback Claude
        // si Gemini indispo / erreur API.
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

/** Detecte les colonnes via les patterns. Isole pour pouvoir try/catch
 *  individuellement (ex : header avec caractere Unicode bizarre qui fait
 *  exploser un regex). */
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
  /** Si fourni : on detecte automatiquement la hierarchie via la cardinalité
   *  des valeurs (générique, indépendant des noms de colonnes spécifiques). */
  rows?: Record<string, string>[],
) {
  // Priorité 1 : détection auto via cardinalité (générique, marche pour tout
  // catalogue où les colonnes catégorie contiennent un mot-clé hierarchique)
  const auto = rows && rows.length > 0
    ? detectCategoryHierarchy(headers, rows)
    : {};

  // Priorité 2 : fallback regex patterns (heuristique simple si auto donne rien)
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

/** Helpers exposes pour les tests unitaires uniquement. Ne pas consommer
 *  depuis le code de production. */
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
