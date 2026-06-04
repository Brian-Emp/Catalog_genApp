/**
 * Helpers de "fit" : estimation de largeur de texte, wrap par mots,
 * shrink-to-fit. Utilises par les reflow specialises (reflowName,
 * reflowSpecs etc.).
 *
 * Ces helpers sont CO-LOCALISES avec le module reflow/ plutot que dans
 * substitutor.ts pour decoupler. substitutor.ts re-exporte
 * estimateTextWidth + TEXT_WIDTH_COEFS pour conserver les callers
 * existants (engineOrchestrator).
 */

/**
 * Coefficients de largeur pour estimateTextWidth.
 * UPPER = majuscules tabulaires (titres, refs). DIGITS = chiffres. MIXED =
 * fallback minuscules/mixed. Calibres sur Almanach-* mais tiennent pour la
 * plupart des fonts sans-serif a corps regulier.
 */
export const TEXT_WIDTH_COEFS = {
  upper: 0.65,
  digits: 0.6,
  mixed: 0.55,
} as const;

/** Estime la largeur en pt d'un texte rendu a fontSize donnee. Heuristique
 *  sans-serif (Almanach/Helvetica), suffisante pour les decisions reflow. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const c of text) {
    if (c >= 'A' && c <= 'Z') w += TEXT_WIDTH_COEFS.upper;
    else if (c >= '0' && c <= '9') w += TEXT_WIDTH_COEFS.digits;
    // Majuscules accentuees (ÉÈÊÀÙÇ...) : meme largeur que majuscules
    else if (c.toUpperCase() === c && c.toLowerCase() !== c) w += TEXT_WIDTH_COEFS.upper;
    // Espaces / ponctuation etroite
    else if (c === ' ' || c === ':' || c === '.' || c === ',') w += 0.3;
    // Caracteres larges (M, W, m, w en minuscule)
    else if ('mwMW'.includes(c)) w += 0.7;
    // Caracteres etroits (i, l, t, f, j, 1, !, |)
    else if ('iltfj!|'.includes(c)) w += 0.35;
    else w += TEXT_WIDTH_COEFS.mixed;
  }
  return w * fontSize;
}

/** Particules en fin de ligne1 a retirer (orphelins typographiques : on
 *  evite de finir une ligne par "et", "de", "ou"...). Utilise apres wrap. */
const TRAILING_PARTICLES_RE = /\s+(à|de|du|des|en|et|ou|le|la|les|un|une|au|aux|par|pour|sur|avec|dans|que|qui|d|l)\s*$/i;
const TRAILING_PUNCT_RE = /[\s,;:.\-]+$/;

/** Nettoie une fin de ligne : ponctuation tombante + particules orphelines. */
export function cleanupLineEnd(line: string): string {
  let cleaned = line.trimEnd();
  cleaned = cleaned.replace(TRAILING_PUNCT_RE, '');
  cleaned = cleaned.replace(TRAILING_PARTICLES_RE, '');
  return cleaned;
}

export interface SplitForWrap {
  /** Texte de la ligne 1 (nettoye). */
  line1: string;
  /** Texte de la ligne 2 (trim left). Vide si tout tient sur ligne 1. */
  line2: string;
  /** True si la coupe est tombee sur un breakpoint semantique (and/or/.../...).
   *  Sert au caller pour decider d'eventuels traitements supplementaires. */
  cleanBreak: boolean;
}

/**
 * Split un texte en 2 lignes pour wrap, en privilegiant les breakpoints
 * semantiques. Ordre de preference des coupes :
 *   1. ';'        — separateur fort
 *   2. ','        — separateur naturel
 *   3. ' / '      — alternative
 *   4. ' - '      — pause longue
 *   5. ' et ', ' ou '  — conjonction (coupe AVANT le mot de liaison pour
 *                       eviter l'orphelin en fin de ligne)
 *   6. ' '        — espace simple (fallback)
 *   7. coupe car a car (fallback ultime)
 *
 * Pour chaque groupe, on prend le breakpoint le plus a droite (=  ligne 1
 * la plus longue) qui fait tenir line1 dans maxWidth.
 */
export function splitForWrap(text: string, maxWidth: number, fontSize: number): SplitForWrap {
  const trimmed = text.trim();
  if (!trimmed) return { line1: '', line2: '', cleanBreak: true };
  if (estimateTextWidth(trimmed, fontSize) <= maxWidth) {
    return { line1: trimmed, line2: '', cleanBreak: true };
  }
  // Collecte des breakpoints candidats. idx = position de coupe (line2 commence
  // a cet idx). group = priorite (plus petit = preference plus forte).
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
      // Detection " et " / " ou " : on coupe AVANT le mot de liaison (l'espace
      // qui le precede), pour que "et"/"ou" demarre la ligne 2 (regle typo fr).
      const next = trimmed.slice(i + 1, i + 4);
      if (next === 'et ' || next === 'ou ') bps.push({ idx: i, group: 5 });
      else bps.push({ idx: i, group: 6 });
    }
  }
  // Pour chaque groupe, prendre le break le plus a droite qui tient.
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
  // Fallback : coupe brute caractere par caractere
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
 * Coupe un texte en lignes qui tiennent dans maxWidth.
 * Greedy par mots : on ajoute le mot suivant si ca tient, sinon on demarre
 * une nouvelle ligne. Si un seul mot depasse → on l'ecrit quand meme sur
 * sa propre ligne (overflow accepte sur cette ligne, le caller decidera).
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
 * Tronque un texte avec ellipse pour qu'il tienne dans maxWidth.
 * Conserve les mots entiers si possible.
 */
export function truncateWithEllipsis(text: string, maxWidth: number, fontSize: number): string {
  const ELL = '…';
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const ellW = estimateTextWidth(ELL, fontSize);
  // Coupe au dernier espace tant que ca depasse
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
  /** Largeur max disponible (pt). Si <= 0, no-op. */
  maxWidth: number;
  /** Taille originale (pt). */
  originalSize: number;
  /** Taille minimale acceptable (pt). En dessous on tronque. */
  minSize: number;
  /** Nombre de lignes max. Default 1. */
  maxLines?: number;
  /** Pas de decrement de la font lors du shrink. Default 0.5pt. */
  shrinkStep?: number;
}

export interface FitResult {
  /** Lignes finales (1 ou plusieurs). */
  lines: string[];
  /** Taille de font appliquee (peut etre inferieure a originalSize). */
  fontSize: number;
  /** True si on a du tronquer (ajout d'une ellipse). */
  truncated: boolean;
  /** Strategie appliquee (debug). */
  strategy: 'fits-as-is' | 'wrapped' | 'shrunk' | 'wrapped-shrunk' | 'truncated';
}

/**
 * Strategie "wrap d'abord puis shrink" :
 *   1. Tente 1 ligne a originalSize : si ok → return.
 *   2. Wrap a originalSize jusqu'a maxLines : si toutes les lignes tiennent → return.
 *   3. Shrink la font (de originalSize a minSize par pas shrinkStep) en
 *      gardant maxLines : si une taille fait tenir toutes les lignes → return.
 *   4. Au pire : truncate la derniere ligne avec ellipse a la minSize.
 *
 * Privilegie la taille de font (vs hauteur) — voir choix utilisateur.
 */
export function fitWrapThenShrink(text: string, opts: FitOptions): FitResult {
  const maxLines = Math.max(1, opts.maxLines ?? 1);
  const shrinkStep = opts.shrinkStep ?? 0.5;
  const trimmed = text.trim();
  if (!trimmed || opts.maxWidth <= 0) {
    return { lines: [trimmed], fontSize: opts.originalSize, truncated: false, strategy: 'fits-as-is' };
  }

  // 1. Tente 1 ligne a originalSize
  if (estimateTextWidth(trimmed, opts.originalSize) <= opts.maxWidth) {
    return { lines: [trimmed], fontSize: opts.originalSize, truncated: false, strategy: 'fits-as-is' };
  }

  // 2. Wrap a originalSize, jusqu'a maxLines
  const wrappedOrig = wrapByWords(trimmed, opts.maxWidth, opts.originalSize);
  const allFitOrig = wrappedOrig.length <= maxLines &&
    wrappedOrig.every((l) => estimateTextWidth(l, opts.originalSize) <= opts.maxWidth);
  if (allFitOrig) {
    return { lines: wrappedOrig, fontSize: opts.originalSize, truncated: false, strategy: 'wrapped' };
  }

  // 3. Shrink : on essaie des tailles decroissantes. A chaque taille, on
  //    re-wrap (la coupe peut tomber differemment si les mots tiennent mieux).
  for (let s = opts.originalSize - shrinkStep; s >= opts.minSize; s -= shrinkStep) {
    // Premier check 1 ligne a cette taille
    if (estimateTextWidth(trimmed, s) <= opts.maxWidth) {
      return { lines: [trimmed], fontSize: s, truncated: false, strategy: 'shrunk' };
    }
    // Sinon wrap
    const wrapped = wrapByWords(trimmed, opts.maxWidth, s);
    if (wrapped.length <= maxLines && wrapped.every((l) => estimateTextWidth(l, s) <= opts.maxWidth)) {
      return { lines: wrapped, fontSize: s, truncated: false, strategy: 'wrapped-shrunk' };
    }
  }

  // 4. Truncate a la minSize : on wrap, on garde les maxLines premieres,
  //    on tronque la derniere avec ellipse.
  const wrappedMin = wrapByWords(trimmed, opts.maxWidth, opts.minSize);
  const kept = wrappedMin.slice(0, maxLines);
  if (kept.length === 0) {
    return { lines: [truncateWithEllipsis(trimmed, opts.maxWidth, opts.minSize)],
             fontSize: opts.minSize, truncated: true, strategy: 'truncated' };
  }
  // Si on a coupe au-dela de maxLines, mettre l'ellipse sur la derniere kept
  if (wrappedMin.length > maxLines) {
    const lastIdx = kept.length - 1;
    // Reconstitue le texte residuel (kept[lastIdx] + reste) puis truncate
    const residual = wrappedMin.slice(lastIdx).join(' ');
    kept[lastIdx] = truncateWithEllipsis(residual, opts.maxWidth, opts.minSize);
  } else {
    // Sinon juste la derniere ligne (qui pourrait deja deborder)
    const lastIdx = kept.length - 1;
    if (estimateTextWidth(kept[lastIdx], opts.minSize) > opts.maxWidth) {
      kept[lastIdx] = truncateWithEllipsis(kept[lastIdx], opts.maxWidth, opts.minSize);
    }
  }
  return { lines: kept, fontSize: opts.minSize, truncated: true, strategy: 'truncated' };
}
