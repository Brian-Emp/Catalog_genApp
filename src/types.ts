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

/** Product format emitted by productsAdapter, consumed by the V2 orchestrator.
 *  The orchestrator sends it as-is to Claude (via products.json); the
 *  catalog-generator Skill uses it to produce plan.json. */
export interface ProductInput {
  name: string;
  ref?: string;
  color?: string;
  /** Section (e.g. "BARRES DE DOUCHES") — used to group products under a
   *  section banner. */
  section?: string;
  /** Macro family for the vertical ribbon (e.g. "cuisine", "salle de bains"). */
  family?: string;
  /** Sub-family = intermediate level between family and section (e.g.
   *  "Robinetterie"). Used for the 3-level table of contents. */
  subFamily?: string;
  /** Ordered list of specs (key + value), already humanized. */
  specs?: { key: string; value: string }[];
  /** Absolute path to an image (matched from the uploaded assets). */
  image_path?: string;
  /** Absolute path to a technical-schema PDF (optional). */
  schema_path?: string;
  /** Product color variants (optional). */
  variantes?: { name: string; ref?: string }[];
}
