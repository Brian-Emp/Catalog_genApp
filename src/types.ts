export type FileKind = 'csv' | 'pdf' | 'zip' | 'xlsx' | 'image' | 'unknown';
export type FileCategory = 'template' | 'data' | 'assets';

export interface CsvData {
  kind: 'csv';
  headers: string[];
  rowCount: number;
  rows: Record<string, string>[];
}

export interface ZipData {
  kind: 'zip';
  entries: { name: string; sizeBytes: number; isDirectory: boolean }[];
}

export interface XlsxData {
  kind: 'xlsx';
  sheets: string[];
  headers: string[];
  rowCount: number;
  rows: Record<string, string>[];
}

export interface PdfData {
  kind: 'pdf';
}

export interface ImageData {
  kind: 'image';
  format: string;
}

export interface UnknownData {
  kind: 'unknown';
  note: string;
}

export type ExtractedData = CsvData | ZipData | XlsxData | PdfData | ImageData | UnknownData;

export interface ExtractedFile {
  originalName: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
  kind: FileKind;
  category: FileCategory;
  extracted: ExtractedData;
}

/** Format produit en sortie de productsAdapter, consomme par l'orchestrator V2.
 *  L'orchestrator l'envoie tel quel a Claude (via products.json) ; le Skill
 *  catalog-generator s'en sert pour produire le plan.json. */
export interface ProductInput {
  name: string;
  ref?: string;
  color?: string;
  /** Section (ex: "BARRES DE DOUCHES") — utilise pour grouper les produits par
   *  bandeau de section. */
  section?: string;
  /** Famille macro pour le ruban vertical (ex: "cuisine", "salle de bains"). */
  family?: string;
  /** Sous-famille = niveau intermédiaire entre family et section (ex
   *  "Robinetterie"). Utilisée pour le sommaire 3 niveaux. */
  subFamily?: string;
  /** Liste ordonnee de specs (clef + valeur) deja humanisees. */
  specs?: { key: string; value: string }[];
  /** Path absolu d'une image (matchee depuis les assets uploades). */
  image_path?: string;
  /** Path absolu d'un PDF de schema technique (optionnel). */
  schema_path?: string;
  /** Variantes couleur du produit (optionnel). */
  variantes?: { name: string; ref?: string }[];
}
