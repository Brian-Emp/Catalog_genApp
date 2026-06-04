import { statSync } from 'fs';
import AdmZip from 'adm-zip';
import type { ZipData } from '../../types';

const MAX_ZIP_ENTRIES = Number(process.env.MAX_ZIP_ENTRIES) || 5000;
const MAX_ZIP_UNCOMPRESSED_BYTES = Number(process.env.MAX_ZIP_UNCOMPRESSED_BYTES) || 2 * 1024 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = Number(process.env.MAX_ZIP_COMPRESSION_RATIO) || 100;

export function extractZip(filePath: string): ZipData {
  const compressedSize = statSync(filePath).size;
  const zip = new AdmZip(filePath);
  const rawEntries = zip.getEntries();
  if (rawEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP avec trop d'entrees (${rawEntries.length}, max ${MAX_ZIP_ENTRIES})`);
  }
  let totalUncompressed = 0;
  const entries = rawEntries.map((e) => {
    if (e.isDirectory) {
      return { name: e.entryName, sizeBytes: 0, isDirectory: true };
    }
    const realSize = e.getData().length;
    totalUncompressed += realSize;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP decompresse trop volumineux (>${MAX_ZIP_UNCOMPRESSED_BYTES} octets)`);
    }
    if (compressedSize > 0 && totalUncompressed / compressedSize > MAX_ZIP_COMPRESSION_RATIO) {
      throw new Error(`ZIP avec ratio de compression suspect (${(totalUncompressed / compressedSize).toFixed(0)}x)`);
    }
    return { name: e.entryName, sizeBytes: realSize, isDirectory: false };
  });
  return { kind: 'zip', entries };
}
