/**
 * "Fit" helpers: text width estimation, word wrapping,
 * shrink-to-fit. Used by the specialized reflow modules (reflowName,
 * reflowSpecs etc.).
 *
 * These helpers are CO-LOCATED with the reflow/ module rather than in
 * substitutor.ts to decouple them. substitutor.ts re-exports
 * estimateTextWidth + TEXT_WIDTH_COEFS to keep the existing callers
 * (engineOrchestrator) working.
 */

/**
 * Width coefficients for estimateTextWidth.
 * UPPER = tabular uppercase (titles, refs). DIGITS = digits. MIXED =
 * lowercase/mixed fallback. Calibrated on Almanach-* but hold for most
 * regular-weight sans-serif fonts.
 */
export const TEXT_WIDTH_COEFS = {
  upper: 0.65,
  digits: 0.6,
  mixed: 0.55,
} as const;

/** Estimates the width in pt of a text rendered at a given fontSize.
 *  Sans-serif heuristic (Almanach/Helvetica), good enough for reflow decisions. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const c of text) {
    if (c >= 'A' && c <= 'Z') w += TEXT_WIDTH_COEFS.upper;
    else if (c >= '0' && c <= '9') w += TEXT_WIDTH_COEFS.digits;
    // Accented uppercase (ÉÈÊÀÙÇ...): same width as uppercase
    else if (c.toUpperCase() === c && c.toLowerCase() !== c) w += TEXT_WIDTH_COEFS.upper;
    // Spaces / narrow punctuation
    else if (c === ' ' || c === ':' || c === '.' || c === ',') w += 0.3;
    // Wide characters (M, W, lowercase m, w)
    else if ('mwMW'.includes(c)) w += 0.7;
    // Narrow characters (i, l, t, f, j, 1, !, |)
    else if ('iltfj!|'.includes(c)) w += 0.35;
    else w += TEXT_WIDTH_COEFS.mixed;
  }
  return w * fontSize;
}

/** Particles to strip from the end of line 1 (typographic orphans: we avoid
 *  ending a line with "et", "de", "ou"...). Applied after wrapping. */
const TRAILING_PARTICLES_RE = /\s+(à|de|du|des|en|et|ou|le|la|les|un|une|au|aux|par|pour|sur|avec|dans|que|qui|d|l)\s*$/i;
const TRAILING_PUNCT_RE = /[\s,;:.\-]+$/;

/** Cleans up a line ending: dangling punctuation + orphan particles. */
export function cleanupLineEnd(line: string): string {
  let cleaned = line.trimEnd();
  cleaned = cleaned.replace(TRAILING_PUNCT_RE, '');
  cleaned = cleaned.replace(TRAILING_PARTICLES_RE, '');
  return cleaned;
}

export interface SplitForWrap {
  /** Text of line 1 (cleaned up). */
  line1: string;
  /** Text of line 2 (left-trimmed). Empty if everything fits on line 1. */
  line2: string;
  /** True if the break landed on a semantic breakpoint (and/or/.../...).
   *  Lets the caller decide on any additional processing. */
  cleanBreak: boolean;
}

/**
 * Splits a text into 2 lines for wrapping, favoring semantic breakpoints.
 * Break preference order:
 *   1. ';'        — strong separator
 *   2. ','        — natural separator
 *   3. ' / '      — alternative
 *   4. ' - '      — long pause
 *   5. ' et ', ' ou '  — conjunction (break BEFORE the linking word to
 *                       avoid the orphan at the end of the line)
 *   6. ' '        — plain space (fallback)
 *   7. char-by-char break (ultimate fallback)
 *
 * For each group, we take the rightmost breakpoint (= longest line 1) that
 * still fits line1 within maxWidth.
 */
export function splitForWrap(text: string, maxWidth: number, fontSize: number): SplitForWrap {
  const trimmed = text.trim();
  if (!trimmed) return { line1: '', line2: '', cleanBreak: true };
  if (estimateTextWidth(trimmed, fontSize) <= maxWidth) {
    return { line1: trimmed, line2: '', cleanBreak: true };
  }
  // Collect candidate breakpoints. idx = break position (line2 starts at
  // this idx). group = priority (smaller = stronger preference).
  interface BP { idx: number; group: number }
  const bps: BP[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === ';') bps.push({ idx: i + 1, group: 1 });
    else if (c === ',') bps.push({ idx: i + 1, group: 2 });
    else if (c === '/' && trimmed[i - 1] === ' ' && trimmed[i + 1] === ' ')
      bps.push({ idx: i + 1, group: 3 });
    else if (c === '-' && trimmed[i - 1] === ' ' && trimmed[i + 1] === ' ')
      bps.push({ idx: i + 1, group: 4 });
    else if (c === ' ') {
      // " et " / " ou " detection: break BEFORE the linking word (the space
      // preceding it), so "et"/"ou" starts line 2 (French typography rule).
      const next = trimmed.slice(i + 1, i + 4);
      if (next === 'et ' || next === 'ou ') bps.push({ idx: i, group: 5 });
      else bps.push({ idx: i, group: 6 });
    }
  }
  // For each group, take the rightmost break that fits.
  for (const group of [1, 2, 3, 4, 5, 6]) {
    const candidates = bps.filter((b) => b.group === group).sort((a, b) => b.idx - a.idx);
    for (const bp of candidates) {
      const line1Raw = trimmed.slice(0, bp.idx);
      if (estimateTextWidth(line1Raw.trimEnd(), fontSize) <= maxWidth) {
        const line1 = cleanupLineEnd(line1Raw);
        const line2 = trimmed.slice(bp.idx).trimStart();
        return { line1, line2, cleanBreak: group < 6 };
      }
    }
  }
  // Fallback: brute char-by-char break
  for (let i = trimmed.length; i > 0; i--) {
    if (estimateTextWidth(trimmed.slice(0, i), fontSize) <= maxWidth) {
      return {
        line1: trimmed.slice(0, i),
        line2: trimmed.slice(i).trimStart(),
        cleanBreak: false,
      };
    }
  }
  return { line1: trimmed.slice(0, 1), line2: trimmed.slice(1).trimStart(), cleanBreak: false };
}

/**
 * Breaks a text into lines that fit within maxWidth.
 * Greedy by words: we add the next word if it fits, otherwise we start a
 * new line. If a single word overflows → we still write it on its own line
 * (overflow accepted on that line, the caller will decide).
 */
export function wrapByWords(text: string, maxWidth: number, fontSize: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Truncates a text with an ellipsis so it fits within maxWidth.
 * Keeps whole words where possible.
 */
export function truncateWithEllipsis(text: string, maxWidth: number, fontSize: number): string {
  const ELL = '…';
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const ellW = estimateTextWidth(ELL, fontSize);
  // Cut at the last space as long as it overflows
  let cut = text.length;
  while (cut > 0) {
    const lastSpace = text.lastIndexOf(' ', cut - 1);
    const candidate = lastSpace >= 0 ? text.slice(0, lastSpace) : text.slice(0, cut - 1);
    if (estimateTextWidth(candidate, fontSize) + ellW <= maxWidth) {
      return (candidate.replace(/[\s,;:.-]+$/, '') + ELL);
    }
    cut = lastSpace >= 0 ? lastSpace : cut - 1;
  }
  return ELL;
}

export interface FitOptions {
  /** Max available width (pt). If <= 0, no-op. */
  maxWidth: number;
  /** Original size (pt). */
  originalSize: number;
  /** Minimum acceptable size (pt). Below this we truncate. */
  minSize: number;
  /** Max number of lines. Default 1. */
  maxLines?: number;
  /** Font decrement step during shrink. Default 0.5pt. */
  shrinkStep?: number;
}

export interface FitResult {
  /** Final lines (1 or more). */
  lines: string[];
  /** Applied font size (may be smaller than originalSize). */
  fontSize: number;
  /** True if we had to truncate (ellipsis added). */
  truncated: boolean;
  /** Applied strategy (debug). */
  strategy: 'fits-as-is' | 'wrapped' | 'shrunk' | 'wrapped-shrunk' | 'truncated';
}

/**
 * "Wrap first then shrink" strategy:
 *   1. Try 1 line at originalSize: if ok → return.
 *   2. Wrap at originalSize up to maxLines: if all lines fit → return.
 *   3. Shrink the font (from originalSize to minSize in shrinkStep steps)
 *      keeping maxLines: if a size makes all lines fit → return.
 *   4. Worst case: truncate the last line with an ellipsis at minSize.
 *
 * Favors font size (vs height) — see user's choice.
 */
export function fitWrapThenShrink(text: string, opts: FitOptions): FitResult {
  const maxLines = Math.max(1, opts.maxLines ?? 1);
  const shrinkStep = opts.shrinkStep ?? 0.5;
  const trimmed = text.trim();
  if (!trimmed || opts.maxWidth <= 0) {
    return { lines: [trimmed], fontSize: opts.originalSize, truncated: false, strategy: 'fits-as-is' };
  }

  // 1. Try 1 line at originalSize
  if (estimateTextWidth(trimmed, opts.originalSize) <= opts.maxWidth) {
    return { lines: [trimmed], fontSize: opts.originalSize, truncated: false, strategy: 'fits-as-is' };
  }

  // 2. Wrap at originalSize, up to maxLines
  const wrappedOrig = wrapByWords(trimmed, opts.maxWidth, opts.originalSize);
  const allFitOrig = wrappedOrig.length <= maxLines &&
    wrappedOrig.every((l) => estimateTextWidth(l, opts.originalSize) <= opts.maxWidth);
  if (allFitOrig) {
    return { lines: wrappedOrig, fontSize: opts.originalSize, truncated: false, strategy: 'wrapped' };
  }

  // 3. Shrink: try decreasing sizes. At each size, re-wrap (the break may
  //    land differently if the words fit better).
  for (let s = opts.originalSize - shrinkStep; s >= opts.minSize; s -= shrinkStep) {
    // First check 1 line at this size
    if (estimateTextWidth(trimmed, s) <= opts.maxWidth) {
      return { lines: [trimmed], fontSize: s, truncated: false, strategy: 'shrunk' };
    }
    // Otherwise wrap
    const wrapped = wrapByWords(trimmed, opts.maxWidth, s);
    if (wrapped.length <= maxLines && wrapped.every((l) => estimateTextWidth(l, s) <= opts.maxWidth)) {
      return { lines: wrapped, fontSize: s, truncated: false, strategy: 'wrapped-shrunk' };
    }
  }

  // 4. Truncate at minSize: wrap, keep the first maxLines, truncate the
  //    last one with an ellipsis.
  const wrappedMin = wrapByWords(trimmed, opts.maxWidth, opts.minSize);
  const kept = wrappedMin.slice(0, maxLines);
  if (kept.length === 0) {
    return { lines: [truncateWithEllipsis(trimmed, opts.maxWidth, opts.minSize)],
             fontSize: opts.minSize, truncated: true, strategy: 'truncated' };
  }
  // If we cut beyond maxLines, put the ellipsis on the last kept line
  if (wrappedMin.length > maxLines) {
    const lastIdx = kept.length - 1;
    // Rebuild the residual text (kept[lastIdx] + remainder) then truncate
    const residual = wrappedMin.slice(lastIdx).join(' ');
    kept[lastIdx] = truncateWithEllipsis(residual, opts.maxWidth, opts.minSize);
  } else {
    // Otherwise just the last line (which might already overflow)
    const lastIdx = kept.length - 1;
    if (estimateTextWidth(kept[lastIdx], opts.minSize) > opts.maxWidth) {
      kept[lastIdx] = truncateWithEllipsis(kept[lastIdx], opts.maxWidth, opts.minSize);
    }
  }
  return { lines: kept, fontSize: opts.minSize, truncated: true, strategy: 'truncated' };
}
