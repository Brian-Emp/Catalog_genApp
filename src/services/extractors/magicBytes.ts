import { promises as fs } from 'fs';

/**
 * Detection of a file's real format via its "magic bytes" (standardized
 * signatures of the first few bytes). Necessary because:
 *   - multer.mimetype is provided by the client, easily forged
 *   - the extension can be renamed manually
 *   - a binary .exe file renamed to .jpg would pass silently
 *
 * Not exhaustive: we cover the formats actually expected by the app
 * (images, PDF, ZIP, XLSX/PPTX = ZIP). The rest falls into "unknown".
 */

/** Known signatures. First match wins. */
const SIGNATURES: Array<{
  kind: DetectedKind;
  /** Offset in the file. Default: 0. */
  offset?: number;
  magic: number[];
}> = [
  { kind: 'png',  magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: 'jpeg', magic: [0xff, 0xd8, 0xff] },
  { kind: 'gif',  magic: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
  { kind: 'gif',  magic: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }, // GIF89a
  { kind: 'bmp',  magic: [0x42, 0x4d] },
  { kind: 'tiff', magic: [0x49, 0x49, 0x2a, 0x00] }, // TIFF little-endian
  { kind: 'tiff', magic: [0x4d, 0x4d, 0x00, 0x2a] }, // TIFF big-endian
  { kind: 'pdf',  magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { kind: 'zip',  magic: [0x50, 0x4b, 0x03, 0x04] },
  { kind: 'zip',  magic: [0x50, 0x4b, 0x05, 0x06] }, // empty zip
  { kind: 'zip',  magic: [0x50, 0x4b, 0x07, 0x08] }, // spanned
  // WebP: RIFF????WEBP (the first 4 bytes + 4 at offset 8)
  { kind: 'webp', offset: 0, magic: [0x52, 0x49, 0x46, 0x46] },
];

export type DetectedKind =
  | 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'tiff'
  | 'heic' | 'avif' | 'svg'
  | 'pdf' | 'zip' | 'text' | 'unknown';

function startsWith(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** Fine-grained WebP check: RIFF header + WEBP marker at offset 8. */
function isWebP(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)
  );
}

/** HEIC / HEIF / AVIF detection: ISO Base Media container (ISOBMFF).
 *
 *  Structure: 4 size bytes then "ftyp" (66 74 79 70) at offset 4, then the
 *  "majorBrand" marker at offset 8 (4 ASCII bytes).
 *
 *  HEIF brands: heic, heix, hevc, hevx, heim, heis, hevm, hevs, mif1, msf1
 *  AVIF brand: avif (alpha brand: avis for image sequence)
 */
function isHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (!startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return false;
  const brand = buf.toString('ascii', 8, 12);
  const HEIF_BRANDS = new Set([
    'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs',
    'mif1', 'msf1',
  ]);
  return HEIF_BRANDS.has(brand);
}

function isAvif(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (!startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4)) return false;
  const brand = buf.toString('ascii', 8, 12);
  return brand === 'avif' || brand === 'avis';
}

/** Detects a UTF-16 (LE or BE) or UTF-8 BOM at the start of the buffer. */
function hasUtf16Bom(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  // UTF-16 LE BOM: FF FE
  if (buf[0] === 0xff && buf[1] === 0xfe) return true;
  // UTF-16 BE BOM: FE FF
  if (buf[0] === 0xfe && buf[1] === 0xff) return true;
  return false;
}

/**
 * "Textual content" heuristic:
 *  - UTF-8 case: no null byte in the first 512 bytes, and only printable
 *    characters or standard control codes.
 *  - UTF-16 case: a BOM (FF FE / FE FF) at the start → considered textual.
 *    Otherwise the "no null byte" test would fail on any UTF-16 (each ASCII
 *    char has a null padding byte).
 *
 *  Sufficient to distinguish a CSV/SVG from a binary.
 */
function looksTextual(buf: Buffer): boolean {
  if (hasUtf16Bom(buf)) return true; // UTF-16 BOM → textual
  for (let i = 0; i < Math.min(buf.length, 512); i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 0x09) return false;
    if (b > 0x0d && b < 0x20) return false;
  }
  return true;
}

function isSvg(buf: Buffer): boolean {
  if (!looksTextual(buf)) return false;
  const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).trimStart();
  return head.startsWith('<?xml') || head.startsWith('<svg');
}

/**
 * Reads the first 512 bytes and returns the detected format.
 * 'unknown' if nothing matches (suspicious file / unsupported type).
 */
export async function detectMagicKind(filePath: string): Promise<DetectedKind> {
  const fd = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fd.read(buf, 0, 512, 0);
    const head = buf.subarray(0, bytesRead);
    if (isWebP(head)) return 'webp';
    // HEIC / AVIF (ISOBMFF containers): check the ftyp brand before the
    // classic signatures (otherwise "ftyp..." matches nothing and falls to text).
    if (isAvif(head)) return 'avif';
    if (isHeic(head)) return 'heic';
    for (const sig of SIGNATURES) {
      if (sig.kind === 'webp') continue; // handled above
      if (startsWith(head, sig.magic, sig.offset ?? 0)) return sig.kind;
    }
    if (isSvg(head)) return 'svg';
    if (looksTextual(head)) return 'text';
    return 'unknown';
  } finally {
    await fd.close();
  }
}

/**
 * Verifies that a detected format is consistent with an announced extension.
 * Returns true if the file is legitimate, false otherwise.
 * - ZIP-based extensions (xlsx, pptx, docx) accept a 'zip' magic.
 * - CSV only accepts plain text, not SVG (which is also "textual" but remains
 *   a pointless attack vector in a tabular data area).
 */
export function kindMatchesExt(kind: DetectedKind, ext: string): boolean {
  const e = ext.toLowerCase().replace(/^\./, '');
  switch (e) {
    case 'png': return kind === 'png';
    case 'jpg':
    case 'jpeg':
    case 'jfif': return kind === 'jpeg'; // JFIF is a JPEG sub-format
    case 'gif': return kind === 'gif';
    case 'webp': return kind === 'webp';
    case 'bmp': return kind === 'bmp';
    case 'tif':
    case 'tiff': return kind === 'tiff';
    case 'heic':
    case 'heif': return kind === 'heic';
    case 'avif': return kind === 'avif';
    case 'svg': return kind === 'svg';
    case 'pdf': return kind === 'pdf';
    case 'zip': return kind === 'zip';
    case 'xlsx':
    case 'xlsm':
    case 'pptx':
    case 'docx': return kind === 'zip'; // all ZIP-based (OOXML)
    case 'csv': return kind === 'text';
    default: return false;
  }
}
