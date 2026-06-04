/**
 * Post-traitement du PDF pour le rendre bit-exact reproductible.
 *
 * PDFium ecrit des metadata (CreationDate, ModDate, ID hash) qui changent
 * a chaque run, ce qui casse le sha256 stable. Pas d'API publique pour
 * les fixer cote PDFium.
 *
 * Solution : on relit le binaire en latin1 (= byte-safe), on remplace les
 * dates et l'ID par des valeurs fixes a longueur identique, on reecrit.
 *
 * Pre-conditions :
 * - le PDF n'est pas chiffre (sinon /CreationDate est dans une zone encryptee)
 * - le PDF n'est pas linearise (sinon les xref offsets changent)
 *
 * Pour notre usage (PDFium SaveAsCopy avec flag 0), ces conditions sont OK.
 */

import { promises as fs } from 'fs';

/** Date PDF fixe : "D:19700101000000Z" (epoch UTC). 17 caracteres. */
const FIXED_DATE = 'D:19700101000000Z';

/** ID PDF fixe : 32 chars hexa (16 octets). Le PDF a /ID [<H1><H2>] avec deux
 *  hashes de 32 hex chars. On remplace les deux par 32 zeros. */
const FIXED_ID_HASH = '00000000000000000000000000000000';

/**
 * Normalise les dates et ID d'un PDF in-place.
 *
 * Strategie : on travaille en encoding 'latin1' (1 byte = 1 char), donc les
 * remplacements preservent les offsets si on garde la meme longueur. PDFium
 * ecrit les dates au format "(D:YYYYMMDDHHMMSSZ)" — toujours 17 chars dans
 * les parentheses + 2 = 19 octets. Notre remplacement fait pareil.
 */
export async function normalizePdfMeta(pdfPath: string): Promise<void> {
  const buf = await fs.readFile(pdfPath);
  const text = buf.toString('latin1');

  let out = text;

  // 1. Dates au format (D:YYYYMMDDHHMMSSZ) — variantes possibles avec +HH'MM' / -HH'MM'
  // On cible toute date PDF entre parentheses.
  out = out.replace(/\(D:\d{8,}[^)]*\)/g, (match) => {
    // On garde la longueur originale en padant avec des zeros si necessaire,
    // ou en tronquant. Cas typique : `(D:20260505123456Z)` = 19 chars.
    const fixed = `(${FIXED_DATE})`;
    if (match.length === fixed.length) return fixed;
    if (match.length > fixed.length) return fixed + ' '.repeat(match.length - fixed.length);
    return fixed.slice(0, match.length);
  });

  // 2. /ID [<hash1> <hash2>] — pour deduplicate / fingerprinting
  out = out.replace(
    /\/ID\s*\[\s*<[0-9a-fA-F]+>\s*<[0-9a-fA-F]+>\s*\]/g,
    (match) => {
      const fixed = `/ID [<${FIXED_ID_HASH}> <${FIXED_ID_HASH}>]`;
      if (match.length === fixed.length) return fixed;
      if (match.length > fixed.length) return fixed + ' '.repeat(match.length - fixed.length);
      return fixed.slice(0, match.length);
    },
  );

  // 3. Producer / Creator si presents avec une version qui change.
  // (Pas de probleme actuellement avec PDFium qui les met fixes par defaut.)

  // Si rien n'a change, on n'ecrit pas pour preserver le mtime.
  if (out !== text) {
    await fs.writeFile(pdfPath, Buffer.from(out, 'latin1'));
  }
}
