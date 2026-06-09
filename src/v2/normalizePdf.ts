/**
 * Post-processing of the PDF to make it bit-exact reproducible.
 *
 * PDFium writes metadata (CreationDate, ModDate, ID hash) that change on
 * every run, which breaks the stable sha256. There is no public API to
 * pin them on the PDFium side.
 *
 * Solution: we re-read the binary as latin1 (= byte-safe), replace the
 * dates and the ID with fixed values of identical length, and rewrite.
 *
 * Pre-conditions:
 * - the PDF is not encrypted (otherwise /CreationDate is in an encrypted area)
 * - the PDF is not linearized (otherwise the xref offsets change)
 *
 * For our use case (PDFium SaveAsCopy with flag 0), these conditions hold.
 */

import { promises as fs } from 'fs';

/** Fixed PDF date: "D:19700101000000Z" (epoch UTC). 17 characters. */
const FIXED_DATE = 'D:19700101000000Z';

/** Fixed PDF ID: 32 hex chars (16 bytes). The PDF has /ID [<H1><H2>] with two
 *  32-hex-char hashes. We replace both with 32 zeros. */
const FIXED_ID_HASH = '00000000000000000000000000000000';

/**
 * Normalizes the dates and ID of a PDF in-place.
 *
 * Strategy: we work in 'latin1' encoding (1 byte = 1 char), so the
 * replacements preserve the offsets as long as we keep the same length.
 * PDFium writes dates in the format "(D:YYYYMMDDHHMMSSZ)" — always 17 chars
 * inside the parentheses + 2 = 19 bytes. Our replacement does the same.
 */
export async function normalizePdfMeta(pdfPath: string): Promise<void> {
  const buf = await fs.readFile(pdfPath);
  const text = buf.toString('latin1');

  let out = text;

  // 1. Dates in the (D:YYYYMMDDHHMMSSZ) format — possible variants with +HH'MM' / -HH'MM'
  // We target any PDF date between parentheses.
  out = out.replace(/\(D:\d{8,}[^)]*\)/g, (match) => {
    // We keep the original length by padding with zeros if necessary,
    // or by truncating. Typical case: `(D:20260505123456Z)` = 19 chars.
    const fixed = `(${FIXED_DATE})`;
    if (match.length === fixed.length) return fixed;
    if (match.length > fixed.length) return fixed + ' '.repeat(match.length - fixed.length);
    return fixed.slice(0, match.length);
  });

  // 2. /ID [<hash1> <hash2>] — for deduplication / fingerprinting
  out = out.replace(
    /\/ID\s*\[\s*<[0-9a-fA-F]+>\s*<[0-9a-fA-F]+>\s*\]/g,
    (match) => {
      const fixed = `/ID [<${FIXED_ID_HASH}> <${FIXED_ID_HASH}>]`;
      if (match.length === fixed.length) return fixed;
      if (match.length > fixed.length) return fixed + ' '.repeat(match.length - fixed.length);
      return fixed.slice(0, match.length);
    },
  );

  // 3. Producer / Creator if present with a version that changes.
  // (Not a problem currently since PDFium sets them fixed by default.)

  // If nothing changed, we don't write so as to preserve the mtime.
  if (out !== text) {
    await fs.writeFile(pdfPath, Buffer.from(out, 'latin1'));
  }
}
