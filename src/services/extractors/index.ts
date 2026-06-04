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

/** Extensions image acceptees au niveau dispatcher upload. Alignee sur
 *  IMAGE_EXTS de productsAdapter (tour 13 + tour 22 magicBytes).
 *
 *  Niveau 1 : png/jpg/jpeg/gif/webp (rendu PyMuPDF natif)
 *  Niveau 2 : tiff/tif/bmp/jfif/ico (decode Pillow standard)
 *  Niveau 3 : heic/heif/avif (best-effort via pillow-heif / pillow-avif) */
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
    // Détail (signature détectée) gardé en logs serveur pour le debug — pas
    // exposé au client pour éviter le fingerprinting du detector.
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
