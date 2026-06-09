import path from 'path';
import type { ExtractedFile, FileCategory } from '../../types';
import { extractCsv } from './csv';
import { extractZip } from './zip';
import { extractXlsx } from './xlsx';
import { detectMagicKind, kindMatchesExt } from './magicBytes';

interface UploadedFile {
  originalname: string;
  path: string;
  mimetype: string;
  size: number;
}

/** Image extensions accepted at the upload dispatcher level. Aligned with
 *  IMAGE_EXTS in productsAdapter (round 13 + round 22 magicBytes).
 *
 *  Level 1: png/jpg/jpeg/gif/webp (native PyMuPDF rendering)
 *  Level 2: tiff/tif/bmp/jfif/ico (standard Pillow decode)
 *  Level 3: heic/heif/avif (best-effort via pillow-heif / pillow-avif) */
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.tiff', '.tif', '.bmp', '.jfif', '.ico',
  '.heic', '.heif', '.avif',
]);

export async function extract(
  file: UploadedFile,
  category: FileCategory,
): Promise<ExtractedFile> {
  const ext = path.extname(file.originalname).toLowerCase();
  const base = {
    originalName: file.originalname,
    storedPath: file.path,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    category,
  };

  const detected = await detectMagicKind(file.path);
  if (!kindMatchesExt(detected, ext)) {
    // Detail (detected signature) kept in server logs for debugging — not
    // exposed to the client to avoid fingerprinting the detector.
    console.warn(
      `[extract] rejet "${file.originalname}" ext=${ext || '—'} signature=${detected}`,
    );
    return {
      ...base,
      kind: 'unknown',
      extracted: {
        kind: 'unknown',
        note: `Contenu suspect : extension "${ext || '—'}" ne correspond pas au type réel.`,
      },
    };
  }

  try {
    if (ext === '.csv') {
      return { ...base, kind: 'csv', extracted: await extractCsv(file.path) };
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      return { ...base, kind: 'xlsx', extracted: await extractXlsx(file.path) };
    }
    if (ext === '.zip') {
      return { ...base, kind: 'zip', extracted: extractZip(file.path) };
    }
    if (ext === '.pdf') {
      return { ...base, kind: 'pdf', extracted: { kind: 'pdf' } };
    }
    if (IMAGE_EXTS.has(ext)) {
      return { ...base, kind: 'image', extracted: { kind: 'image', format: ext.slice(1) } };
    }
  } catch (err) {
    return {
      ...base,
      kind: 'unknown',
      extracted: { kind: 'unknown', note: `Extraction échouée: ${(err as Error).message}` },
    };
  }

  return {
    ...base,
    kind: 'unknown',
    extracted: { kind: 'unknown', note: `Type non géré: ${ext || file.mimetype}` },
  };
}
