import { promises as fs } from 'fs';

/**
 * Détection du format réel d'un fichier par ses "magic bytes" (signatures
 * standardisées des premiers octets). Nécessaire parce que :
 *   - multer.mimetype est fourni par le client, facilement falsifiable
 *   - l'extension peut être renommée manuellement
 *   - un fichier binaire .exe renommé en .jpg passerait silencieusement
 *
 * Pas exhaustif : on couvre les formats réellement attendus par l'app
 * (images, PDF, ZIP, XLSX/PPTX = ZIP). Le reste tombe dans "unknown".
 */

/** Signatures connues. Première coïncidence gagne. */
const SIGNATURES: Array<{
  kind: DetectedKind;
  /** Offset dans le fichier. Défaut : 0. */
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
  { kind: 'zip',  magic: [0x50, 0x4b, 0x05, 0x06] }, // zip vide
  { kind: 'zip',  magic: [0x50, 0x4b, 0x07, 0x08] }, // spanned
  // WebP : RIFF????WEBP (les 4 premiers octets + 4 à l'offset 8)
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

/** Vérification fine WebP : header RIFF + marque WEBP à l'offset 8. */
function isWebP(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)
  );
}

/** Détection HEIC / HEIF / AVIF : container ISO Base Media (ISOBMFF).
 *
 *  Structure : 4 octets de taille puis "ftyp" (66 74 79 70) à l'offset 4
 *  puis marque "majorBrand" à l'offset 8 (4 octets ASCII).
 *
 *  Brands HEIF : heic, heix, hevc, hevx, heim, heis, hevm, hevs, mif1, msf1
 *  Brand AVIF : avif (alpha brand : avis pour image sequence)
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

/** Detecte un BOM UTF-16 (LE ou BE) ou UTF-8 en debut de buffer. */
function hasUtf16Bom(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  // UTF-16 LE BOM : FF FE
  if (buf[0] === 0xff && buf[1] === 0xfe) return true;
  // UTF-16 BE BOM : FE FF
  if (buf[0] === 0xfe && buf[1] === 0xff) return true;
  return false;
}

/**
 * Heuristique "contenu textuel" :
 *  - cas UTF-8 : pas d'octet nul dans les 512 premiers octets, et
 *    seulement des caractères imprimables ou contrôles standards.
 *  - cas UTF-16 : BOM (FF FE / FE FF) en debut → considere comme textuel.
 *    Sinon le test "no null byte" echouerait sur tout UTF-16 (chaque
 *    char ASCII a un byte nul de padding).
 *
 *  Suffit pour distinguer un CSV/SVG d'un binaire.
 */
function looksTextual(buf: Buffer): boolean {
  if (hasUtf16Bom(buf)) return true; // UTF-16 BOM → textuel
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
 * Lit les 512 premiers octets et renvoie le format détecté.
 * 'unknown' si rien ne match (fichier suspect / type non géré).
 */
export async function detectMagicKind(filePath: string): Promise<DetectedKind> {
  const fd = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fd.read(buf, 0, 512, 0);
    const head = buf.subarray(0, bytesRead);
    if (isWebP(head)) return 'webp';
    // HEIC / AVIF (containers ISOBMFF) : verifier ftyp brand avant les
    // signatures classiques (sinon "ftyp..." matche rien et tombe en text).
    if (isAvif(head)) return 'avif';
    if (isHeic(head)) return 'heic';
    for (const sig of SIGNATURES) {
      if (sig.kind === 'webp') continue; // traité ci-dessus
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
 * Vérifie qu'un format détecté est cohérent avec une extension annoncée.
 * Renvoie true si le fichier est légitime, false sinon.
 * - Les extensions basées ZIP (xlsx, pptx, docx) acceptent un magic 'zip'.
 * - CSV n'accepte que du texte brut, pas du SVG (qui est aussi "textuel" mais
 *   reste un vecteur d'attaque inutile dans une zone data tabulaire).
 */
export function kindMatchesExt(kind: DetectedKind, ext: string): boolean {
  const e = ext.toLowerCase().replace(/^\./, '');
  switch (e) {
    case 'png': return kind === 'png';
    case 'jpg':
    case 'jpeg':
    case 'jfif': return kind === 'jpeg'; // JFIF est un sous-format JPEG
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
    case 'docx': return kind === 'zip'; // tous basés sur ZIP (OOXML)
    case 'csv': return kind === 'text';
    default: return false;
  }
}
