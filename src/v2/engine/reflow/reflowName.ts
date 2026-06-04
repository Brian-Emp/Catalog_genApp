/**
 * reflowName — substitue le nom d'un produit en respectant les contraintes
 * geometriques du slot template (largeur disponible + budget vertical).
 *
 * Strategie "wrap d'abord puis shrink" (cf. fit.fitWrapThenShrink) :
 *   1. Essaye 1 ligne a la taille originale.
 *   2. Wrap 2 lignes (si le budget vertical le permet) a la taille originale.
 *   3. Shrink la font jusqu'a 70% en re-essayant 1 puis 2 lignes.
 *   4. Truncate avec "…" si rien ne tient.
 *
 * Output : Operation[] (erase_rect + insert_text par ligne) + metadata pour
 * que le caller (substitutor) puisse savoir si la zone du nom a deborde
 * et eventuellement decaler les zones voisines (color/ref).
 */

import type { Bbox, Operation, TextSpan } from '../../types';
import { fitWrapThenShrink, type FitResult } from './fit';
import { safeTextColor } from '../safeColor';

/** Ratio interligne (line-height / fontSize) standard sans-serif. */
const LINE_HEIGHT_RATIO = 1.15;
/** Ratio minimum de la font (par rapport a l'original) avant de tronquer. */
const MIN_FONT_RATIO = 0.70;
/** Marge de securite ajoutee au padding erase (pt). */
const ERASE_PAD = 2;
/** Marge verticale haute additionnelle pour couvrir d'éventuels fragments
 *  serrés sous des décorations / banners de section. Calibré conservatif :
 *  proportionnel à origSize pour s'adapter aux typos variées. Sur Catalogue A (16pt)
 *  → ~3pt de marge, sur Catalogue C / Catalogue B (15pt) → ~2.8pt. */
const ERASE_TOP_RATIO = 0.25;

export interface ReflowNameInput {
  /** Texte du nouveau nom a inserer. */
  text: string;
  /** Span template du nom (porte font, size, color, bbox de reference). */
  span: TextSpan;
  /** Limite droite absolue (pt). En general pageWidth - ribbonMargin. */
  rightBound: number;
  /** Limite basse acceptable (pt). En general top du color/ref ou de la
   *  zone specs. Si fournie, le wrap multi-lignes ne s'autorise que si
   *  les lignes additionnelles tiennent au-dessus de cette limite. */
  bottomBound?: number;
  /** Nombre max de lignes (independamment du budget vertical). Default 2. */
  maxLines?: number;
}

export interface ReflowNameResult {
  /** Operations a appliquer (erase global + 1 insert_text par ligne). */
  ops: Operation[];
  /** Lignes finales rendues. */
  lines: string[];
  /** Taille de police effective (peut etre < originale). */
  fontSize: number;
  /** Hauteur totale occupee (du top a la fin de la derniere ligne). */
  totalHeight: number;
  /** Decalage Y a appliquer aux elements en dessous (color/ref) pour
   *  ne pas chevaucher si le nom occupe plus de hauteur que le template. */
  yShift: number;
  /** True si on a du tronquer (perte d'information). */
  truncated: boolean;
  /** Strategie appliquee (debug). */
  strategy: FitResult['strategy'];
}

export function reflowName(input: ReflowNameInput): ReflowNameResult {
  const text = (input.text ?? '').trim();
  const span = input.span;
  const origSize = span.size;
  const minSize = origSize * MIN_FONT_RATIO;
  const lineHRatio = LINE_HEIGHT_RATIO;
  const origHeight = span.bbox[3] - span.bbox[1];

  // Largeur disponible : du x0 du nom jusqu'a la limite droite.
  const maxWidth = Math.max(0, input.rightBound - span.bbox[0]);

  // Budget vertical pour decider maxLines : si bottomBound fourni, calcule
  // combien de lignes tiennent. Sinon laisse passer maxLines complet.
  let effectiveMaxLines = Math.max(1, input.maxLines ?? 2);
  if (input.bottomBound !== undefined) {
    const verticalBudget = input.bottomBound - span.bbox[1];
    const lineH = origSize * lineHRatio;
    const fits = Math.max(1, Math.floor(verticalBudget / lineH));
    effectiveMaxLines = Math.min(effectiveMaxLines, fits);
  }

  // Fit
  const fit = fitWrapThenShrink(text, {
    maxWidth,
    originalSize: origSize,
    minSize,
    maxLines: effectiveMaxLines,
  });

  const lineH = fit.fontSize * lineHRatio;
  const lines = fit.lines.length > 0 ? fit.lines : [''];
  const totalHeight = (lines.length - 1) * lineH + origHeight;
  const yShift = Math.max(0, totalHeight - origHeight);

  // Erase global : couvre toute la zone du nom (largeur jusqu'a rightBound,
  // hauteur jusqu'au nb de lignes effectif), avec padding adaptatif.
  // Padding haut élargi (ERASE_TOP_RATIO * origSize) pour couvrir les
  // fragments serrés type code-barre / sous-titre collé au nom dans des
  // templates denses.
  // Padding bas proportionnel (faille Catalogue C P5 : "Exemple" template reste
  // visible derrière nouveau nom). Sur grand format (nameSize 24-28pt), le
  // ERASE_PAD=2 ne couvre pas les descenders + le line spacing. Avec ratio
  // 0.25 sur 28pt = 7pt, on capture les glyphs render bbox > baseline bbox.
  const eraseTopPad = Math.max(ERASE_PAD, origSize * ERASE_TOP_RATIO);
  const eraseBottomPad = Math.max(ERASE_PAD, origSize * 0.25);
  const eraseBbox: Bbox = [
    span.bbox[0] - ERASE_PAD,
    span.bbox[1] - eraseTopPad,
    Math.max(span.bbox[2], input.rightBound) + ERASE_PAD,
    span.bbox[1] + totalHeight + eraseBottomPad,
  ];

  const ops: Operation[] = [
    { op: 'erase_rect', bbox: eraseBbox },
  ];

  // 1 insert_text par ligne. La 1ere ligne garde la y du span original,
  // les suivantes decalees de lineH. no_erase=true car on a fait un erase
  // global plus large que l'auto-erase de chaque insert_text.
  for (let i = 0; i < lines.length; i++) {
    const yOffset = i * lineH;
    ops.push({
      op: 'insert_text',
      bbox: [
        span.bbox[0],
        span.bbox[1] + yOffset,
        Math.min(input.rightBound, span.bbox[2] + 200),  // bbox-right indicative
        span.bbox[3] + yOffset,
      ],
      text: lines[i],
      font: span.font,
      size: fit.fontSize,
      // safeTextColor : bascule en noir si template = blanc/clair (cartouche
      // colore efface par erase fond bloc => sinon nom invisible).
      color: safeTextColor(span.color),
      no_erase: true,
    });
  }

  return {
    ops,
    lines,
    fontSize: fit.fontSize,
    totalHeight,
    yShift,
    truncated: fit.truncated,
    strategy: fit.strategy,
  };
}
