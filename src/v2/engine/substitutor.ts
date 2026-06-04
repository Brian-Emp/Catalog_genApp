/**
 * Phase 3 : substitution in-place d'une page produit du template.
 *
 * Pour chaque bloc du template, on utilise les EXACTES positions+styles
 * (font, size, color, bbox) des spans source comme empreinte. On efface
 * chaque zone et on reecrit le nouveau texte au meme endroit. PAS de
 * recalcul de layout — on respecte le template a la lettre.
 *
 * Si product < blocs : les blocs restants sont effaces (zone blanche).
 * Si product > blocs : on tronque (l'allocator a deja choisi une page de
 * la bonne taille).
 */

import type {
  Bbox,
  ColorHex,
  Operation,
  OpDrawCircle,
  OpDrawImage,
  OpEraseRect,
  OpInsertText,
  PlanProduct,
  TextSpan,
} from '../types';
import type { ProductBlock } from './blockDetector';
import type { TemplateProfile } from './profile';
import { reflowName } from './reflow/reflowName';
import { reflowSpecs as reflowSpecsModule } from './reflow/reflowSpecs';
import { reflowSpecsV2 } from './reflow/reflowSpecsV2';
import { reflowVariants as reflowVariantsModule } from './reflow/reflowVariants';
import { estimateTextWidth } from './reflow/fit';
import { safeText } from './safeText';
import { safeTextColor } from './safeColor';
import { padBbox } from '../utils/bbox';

export interface SubstituteContext {
  pageWidth: number;
  pageHeight: number;
  profile: TemplateProfile;
  /** Tous les spans du template sur cette page. Sert au polish residus :
   *  toute trace textuelle du produit d'origine (bandeaux promo, mentions
   *  "thermostatique a corps froid", etc.) qui n'a pas ete remplacee par
   *  une op insert_text est effacee automatiquement. */
  rawSpans?: TextSpan[];
  /** Toutes les bbox de bitmaps sur la page (pour effacer pictos NF,
   *  tampons "FABRIQUE EN FRANCE", etc. residus dans les blocs). */
  rawImages?: Bbox[];
  /** Bbox de toutes les decorations vectorielles (pictos dessines en
   *  paths). On efface celles dans les blocs qui ne touchent pas les
   *  bords (= pas de rubans structurels). */
  decorationVectors?: Bbox[];
  /** Paths colores (bbox + fill_color) du template. Permet de retrouver
   *  la teinte d'un cartouche section_banner pour substituer le label. */
  rawPaths?: { bbox: Bbox; fill_color: ColorHex }[];
  /** Spans section_banner detectes par le classifier (label text + bbox). */
  sectionBannerSpans?: TextSpan[];
  /** Nouveau label de section a inscrire dans les cartouches (ex
   *  "BARRES DE DOUCHES"). Si vide : on ne substitue pas le banner. */
  newSectionLabel?: string;
  /** Spans verticaux (rotation=90/270) detectes sur le bord droit de la
   *  page = ruban "section_ribbon" template (ex "salle de bains"). */
  ribbonSpans?: TextSpan[];
  /** Nouveau label famille a inscrire sur le ruban vertical (ex "SANITAIRE"
   *  depuis Libellé Famille du XLSX). Si vide : on ne substitue pas. */
  newFamilyLabel?: string;
  /** Mode multi-cols horizontal (S6.5) propage depuis substitutePage vers
   *  substituteBlock puis reflowSpecsV2. Voir ReflowSpecsV2Context. */
  horizontalMode?: 'vertical' | 'horizontal-primary' | 'horizontal-secondary';
  /** X droit de la colonne du bloc courant en mode horizontal. */
  horizontalColRight?: number;
}

/** Calcule pour chaque bloc d'une page horizontale son mode (primary si 1er
 *  de la row Y, secondary sinon) et son horizontalColRight (X du bloc voisin
 *  a droite OU bord page).
 *
 *  Faille review : colRight ne doit JAMAIS etre Infinity (propagation
 *  problematique a PDFium). Pour le dernier bloc d'une row, on retourne
 *  `pageWidth - ribbonMargin` (clamp explicite).
 *  Tolerance Y adaptee a la nameSize moyenne (vs 8pt fixe). */
export function computeHorizontalRowMeta(
  blocks: ProductBlock[],
  pageWidth?: number,
  ribbonMargin?: number,
): Map<ProductBlock, { mode: 'horizontal-primary' | 'horizontal-secondary'; colRight: number }> {
  const meta = new Map<
    ProductBlock,
    { mode: 'horizontal-primary' | 'horizontal-secondary'; colRight: number }
  >();
  if (blocks.length === 0) return meta;
  // Tolerance Y adaptee a la nameSize median (vs 8pt fixe)
  const sizes = blocks.map((b) => b.nameSpan.size).sort((a, b) => a - b);
  const medianSize = sizes[Math.floor(sizes.length / 2)];
  const Y_TOL = Math.max(4, medianSize * 0.30);
  const rows = new Map<number, ProductBlock[]>();
  for (const b of blocks) {
    let rowKey: number | null = null;
    for (const key of rows.keys()) {
      if (Math.abs(b.yTop - key) <= Y_TOL) {
        rowKey = key;
        break;
      }
    }
    if (rowKey === null) {
      rowKey = b.yTop;
      rows.set(rowKey, []);
    }
    rows.get(rowKey)!.push(b);
  }
  // Borne finie pour le dernier bloc de chaque row : pageWidth - ribbonMargin
  // ou fallback raisonnable si pageWidth indispo.
  const lastBlockColRight =
    pageWidth !== undefined && ribbonMargin !== undefined
      ? pageWidth - ribbonMargin
      : pageWidth ?? 600;
  for (const rowBlocks of rows.values()) {
    rowBlocks.sort((a, b) => a.nameSpan.bbox[0] - b.nameSpan.bbox[0]);
    for (let i = 0; i < rowBlocks.length; i++) {
      const block = rowBlocks[i];
      const next = rowBlocks[i + 1];
      const colRight = next ? next.nameSpan.bbox[0] - 4 : lastBlockColRight;
      meta.set(block, {
        mode: i === 0 ? 'horizontal-primary' : 'horizontal-secondary',
        colRight,
      });
    }
  }
  return meta;
}

/**
 * Substitue les blocs d'une page template avec une liste de produits.
 * - blocks.length === products.length → substitution 1:1
 * - blocks.length > products.length → blocs restants effaces (vides propres)
 * - blocks.length < products.length → les produits en surplus ignores (le
 *   allocator a deja gere cette taille)
 */
export function substitutePage(
  blocks: ProductBlock[],
  products: PlanProduct[],
  ctx: SubstituteContext,
): Operation[] {
  const ops: Operation[] = [];
  // Mode horizontal (S6.5) : si la page est en layout horizontal, on groupe
  // les blocs par row Y et on marque le 1er comme primary, les autres
  // comme secondary. Le substituteBlock relaie ces flags a reflowSpecsV2.
  // Activation conservatrice : SEULEMENT si TOUS les blocs ont
  // isHorizontalLayout=true (evite de toucher au comportement Catalogue A vertical).
  const allHorizontal =
    blocks.length > 0 && blocks.every((b) => b.isHorizontalLayout === true);
  const horizontalRowMeta = allHorizontal
    ? computeHorizontalRowMeta(blocks, ctx.pageWidth, ctx.profile.ribbonMargin)
    : null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const product = products[i];
    const meta = horizontalRowMeta?.get(block) ?? null;
    const blockCtx: SubstituteContext = meta
      ? { ...ctx, horizontalMode: meta.mode, horizontalColRight: meta.colRight }
      : ctx;
    if (product) {
      ops.push(...substituteBlock(block, product, blockCtx));
    } else {
      ops.push(...eraseBlock(block, blockCtx));
    }
  }
  // Polish residus textuels : erase les spans du template non substitues
  // dans les zones bloc (bandeaux "Existe en bain-douche", mentions
  // "THERMOSTATIQUE A CORPS FROID", "NOUVEAUTE", etc.).
  if (ctx.rawSpans) {
    ops.push(...polishResidualSpans(ctx.rawSpans, blocks, ops, ctx));
  }
  // Polish residus visuels : erase pictos bitmap (badges NF, "FABRIQUE
  // EN FRANCE", etc.) et pictos vectoriels (cercle "NOUVEAUTE" rouge,
  // demi-cercle thermostatique, etc.) dans les zones bloc, sauf l'image
  // principale produit et les rubans/headers structurels qui touchent
  // les bords de la page.
  if (ctx.rawImages) {
    ops.push(...polishResidualBitmaps(ctx.rawImages, blocks, ops, ctx));
  }
  if (ctx.decorationVectors) {
    ops.push(...polishResidualVectors(ctx.decorationVectors, blocks, ctx));
  }
  // Substitution des section_banner (cartouches "ÉVIERS BAS - MITIGEURS"
  // -> "BARRES DE DOUCHES"). On emet l'insert_text AVANT l'erase colore,
  // pour que le PASS 1 du render fasse :
  //   1) insert_text PASS 1 = auto-erase blanc (annule la teinte du path)
  //   2) erase_rect coloré = repeint la teinte template par-dessus
  // En PASS 2 le texte arrive au-dessus → cartouche teinté + nouveau label.
  if (ctx.sectionBannerSpans && ctx.newSectionLabel && ctx.rawPaths) {
    ops.push(...substituteSectionBanners(ctx));
  }
  // Ruban vertical (famille). Substitue "cuisine"/"salle de bains" du template
  // par la famille du produit ("SANITAIRE", "CHAUFFAGE", etc.).
  if (ctx.ribbonSpans && ctx.newFamilyLabel) {
    ops.push(...substituteFamilyRibbon(ctx));
  }
  return ops;
}

/** Constantes ruban vertical. */
const RIBBON_MARGIN_PT = 4;
/** Taille fallback si span.size < 8pt (artefact d'extraction PDFium sur
 *  texte rotated). */
const RIBBON_FALLBACK_SIZE_PT = 14;
/** Detection artefact d'extraction. */
const RIBBON_ARTIFACT_THRESHOLD_PT = 8;
/** Plancher du shrink : on n'ira pas en dessous, on troncature plutot. */
const RIBBON_MIN_SHRINK_SIZE_PT = 10;
/** Anti-debordement : le texte ne doit pas remplir + de X% de la hauteur
 *  du fond colore. Au-dessus → on shrink AVANT de tolerer l'agrandissement
 *  visuel ("ribbon enorme" sur textes longs). */
const RIBBON_MAX_FILL_RATIO = 0.85;
/** Pas de decrement du shrink (pt). */
const RIBBON_SHRINK_STEP = 0.5;

/** Substitue le ruban vertical (label famille, rotation 90/270 sur bord droit).
 *  Erase + insert avec le nouveau label. Si le ruban template a un fond
 *  COLORÉ (barre orange/verte), on cherche le path correspondant et on
 *  emet un erase_rect coloré pour repeindre la teinte par-dessus l'auto-erase
 *  blanc. Sinon : erase blanc simple (fallback). */
function substituteFamilyRibbon(ctx: SubstituteContext): Operation[] {
  const ops: Operation[] = [];
  const newLabel = (ctx.newFamilyLabel ?? '').trim();
  if (newLabel.length === 0) return ops;
  const paths = ctx.rawPaths ?? [];
  // Anti-double-substitution : si un span est DEJA un section_banner (remplace
  // par le label section, ex "BARRES DE DOUCHES"), il ne doit PAS aussi recevoir
  // le ruban famille ("SANITAIRE") par-dessus. Bug observe (catalogue Catalogue A
  // p6) : le bandeau-haut [303,12,560,27] etait classe a la fois section_banner
  // ET ribbon → 2 insert_text superposes "BARRES DE DOUCHES" + "SANITAIRE".
  const bannerBboxes = ctx.newSectionLabel
    ? (ctx.sectionBannerSpans ?? []).map((b) => b.bbox)
    : [];
  for (const span of ctx.ribbonSpans ?? []) {
    if (bannerBboxes.length > 0 && isCovered(span.bbox, bannerBboxes, 0.5)) continue;
    // Casse template : si span all lower → lower, all upper → upper, sinon
    // capitalize. Respecte la typo originale ("salle de bains" vs "CUISINE").
    const tplText = span.text.trim();
    let styled = newLabel;
    if (tplText.length > 0) {
      const hasUpper = /[A-ZÀ-ſ]/.test(tplText);
      const hasLower = /[a-zà-ſ]/.test(tplText);
      if (hasLower && !hasUpper) styled = newLabel.toLowerCase();
      else if (hasUpper && !hasLower) styled = newLabel.toUpperCase();
      else styled = newLabel.charAt(0).toUpperCase() + newLabel.slice(1).toLowerCase();
    }
    // Détection orientation : si bbox plus large que haute → ribbon horizontal
    // (bandeau page haut/bas). Sinon → vertical (bord gauche/droit).
    const spanW = span.bbox[2] - span.bbox[0];
    const spanH = span.bbox[3] - span.bbox[1];
    const isHorizontalRibbon = spanW > spanH;

    // Recherche du PATH coloré qui fait office de fond du ruban.
    // Critères différents selon orientation : vertical = bande étroite haute,
    // horizontal = bande large peu haute.
    const bg = paths.find((p) => {
      const pw = p.bbox[2] - p.bbox[0];
      const ph = p.bbox[3] - p.bbox[1];
      if (isHorizontalRibbon) {
        // Bandeau horizontal : large + peu haut + contient le span
        if (pw < ctx.pageWidth * 0.20) return false;
        if (ph >= 60) return false;
        if (!(p.bbox[0] - 4 <= span.bbox[0] && p.bbox[2] + 4 >= span.bbox[2])) return false;
        if (!(p.bbox[1] - 4 <= span.bbox[1] && p.bbox[3] + 4 >= span.bbox[3])) return false;
        return true;
      }
      // Vertical : bande étroite + haute
      if (pw >= 50) return false;
      if (ph < ctx.pageHeight * 0.25) return false;
      if (!(p.bbox[1] - 4 <= span.bbox[1] && p.bbox[3] + 4 >= span.bbox[3])) return false;
      if (!(p.bbox[0] - 4 <= span.bbox[0] && p.bbox[2] + 4 >= span.bbox[2])) return false;
      return true;
    });

    // Taille initiale : on PRESERVE la taille du span template (ne pas forcer
    // un MIN_PT artificiel qui agrandit les textes courts inutilement). Si
    // le span est detecte trop petit (artefact d'extraction PDFium sur texte
    // rotated), fallback a RIBBON_FALLBACK_SIZE_PT pour lisibilite.
    let effectiveSize = span.size < RIBBON_ARTIFACT_THRESHOLD_PT
      ? RIBBON_FALLBACK_SIZE_PT
      : span.size;

    // IMPORTANT : pour rotation=90 dans render.cpp (FPDFPageObj_Transform
    // 0,-1,1,0), le texte est dessine depuis l'anchor y1 et progresse
    // VERS LE BAS de l'ecran (y croissant en coords top-left). Donc le
    // texte occupe [y1, y1 + neededH] et NON [y1 - neededH, y1].
    const tplY1 = span.bbox[3];
    const topLimit = bg ? bg.bbox[1] + RIBBON_MARGIN_PT : 0;
    const bottomLimit = bg ? bg.bbox[3] - RIBBON_MARGIN_PT : ctx.pageHeight;
    const fullAvail = bottomLimit - topLimit;
    // Cap "anti-enorme" : le texte ne doit pas occuper + de MAX_FILL_RATIO
    // de la hauteur du fond, pour preserver des marges visuelles.
    const targetMaxH = fullAvail * RIBBON_MAX_FILL_RATIO;

    let neededH = estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT;

    // Etape 1 : shrink si > targetMaxH (anti-debordement esthetique).
    if (neededH > targetMaxH) {
      let s = effectiveSize;
      while (s > RIBBON_MIN_SHRINK_SIZE_PT
          && estimateTextWidth(styled, s) + RIBBON_MARGIN_PT > targetMaxH) {
        s -= RIBBON_SHRINK_STEP;
      }
      effectiveSize = s;
      neededH = estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT;
    }

    // Etape 2 : si meme au shrink min on deborde l'espace dispo total, on
    // tronque avec une ellipse (dernier recours pour textes vraiment longs).
    if (neededH > fullAvail) {
      const ellW = estimateTextWidth('…', effectiveSize);
      while (styled.length > 4
          && estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT + ellW > fullAvail) {
        styled = styled.slice(0, -1);
      }
      styled = styled.replace(/[\s,;:.\-]+$/, '') + '…';
      neededH = estimateTextWidth(styled, effectiveSize) + RIBBON_MARGIN_PT;
    }

    // Position finale : preserve l'anchor template si le texte tient,
    // sinon centre dans la zone dispo pour un rendu visuel propre.
    let finalY1 = tplY1;
    const fitsAtTpl = finalY1 + neededH <= bottomLimit && finalY1 >= topLimit;
    if (!fitsAtTpl) {
      finalY1 = topLimit + (fullAvail - neededH) / 2;
    }
    // ATTENTION sémantique bbox pour rotation 90 :
    // - render.cpp prend bbox[3] (y1) comme ANCHOR PDFium (= pageH - y1).
    // - Le texte est dessiné depuis cet anchor et PROGRESSE VERS LE BAS
    //   de l'écran (y croissant en convention top-left).
    // - Donc la zone occupée par le texte = [y1, y1 + neededH] en top-left.
    // Pour le insert_text, on passe bbox[3] = finalY1 (= anchor).
    // Pour le erase, il faut couvrir la zone du texte rendu = [finalY1, finalY1+neededH].
    const insertBbox: Bbox = [span.bbox[0], finalY1, span.bbox[2], finalY1];
    // Pad elargi (4pt) pour ribbon vertical : les caracteres accentues
    // (É, Ç, À) ont des accents qui depassent en X apres rotation 90°.
    // Faille Catalogue C P7 "ÉVACUATION" → "VACUATION" (É efface incompletement).
    const RIBBON_TEXT_PAD = 4;
    // L'erase doit couvrir AUSSI le span template original (sinon l'ancien
    // texte ribbon reste visible a cote du nouveau). Cas Catalogue C P14 :
    // ÉVACUATION (Y=12-83) + POMPE (Y=83-127) → 2 rubans empiles si l'erase
    // ne couvre que la zone du nouveau texte. On unionne span tpl + zone new.
    const tplY0 = span.bbox[1];
    const tplY1Bottom = span.bbox[3];
    const newY0 = finalY1;
    const newY1Bottom = Math.min(bottomLimit, finalY1 + neededH);
    const textCoverBbox: Bbox = [
      span.bbox[0] - RIBBON_TEXT_PAD,
      Math.min(tplY0, newY0) - RIBBON_TEXT_PAD,
      span.bbox[2] + RIBBON_TEXT_PAD,
      Math.max(tplY1Bottom, newY1Bottom) + RIBBON_TEXT_PAD,
    ];

    // Rotation : 0 si horizontal (bandeau page), 90 si vertical (bord rotated)
    const ribbonRotation = isHorizontalRibbon ? 0 : 90;
    // Pour ribbon horizontal, on conserve l'anchor X-Y du span tpl sans
    // recalcul (le texte s'écrit horizontalement, pas besoin de neededH).
    const finalInsertBbox: Bbox = isHorizontalRibbon
      ? [span.bbox[0], span.bbox[1], span.bbox[2], span.bbox[3]]
      : insertBbox;
    const finalCoverBbox: Bbox = isHorizontalRibbon
      ? [span.bbox[0] - RIBBON_TEXT_PAD, span.bbox[1] - RIBBON_TEXT_PAD,
         span.bbox[2] + RIBBON_TEXT_PAD, span.bbox[3] + RIBBON_TEXT_PAD]
      : textCoverBbox;

    if (bg) {
      // Pattern teinte preservée : insert_text D'ABORD (PASS 1 = auto-erase
      // blanc), puis erase_rect colore (PASS 1 = repaint teinte par-dessus).
      // PASS 2 redessine le texte au-dessus du rect teinté.
      //
      // Premier erase blanc cible la zone du span template (peut être plus
      // large que bg.bbox sur catalogues où le path bg est plus court que
      // le texte). Sans ça, le texte original reste visible si bg < span.
      ops.push({ op: 'erase_rect', bbox: finalCoverBbox });
      ops.push({
        op: 'insert_text',
        bbox: finalInsertBbox,
        text: styled,
        font: span.font,
        size: effectiveSize,
        color: span.color,
        rotation: ribbonRotation,
      });
      ops.push({ op: 'erase_rect', bbox: bg.bbox, color: bg.fill_color });
    } else {
      // Fallback : pas de path colore trouve. Erase blanc + insert.
      ops.push({ op: 'erase_rect', bbox: finalCoverBbox });
      ops.push({
        op: 'insert_text',
        bbox: finalInsertBbox,
        text: styled,
        font: span.font,
        size: effectiveSize,
        color: span.color,
        rotation: ribbonRotation,
      });
    }
  }
  return ops;
}

/**
 * Pour chaque section_banner detecte, trouve le path colore qui fait
 * office de fond (cartouche orange/vert). Emet :
 *  - un insert_text avec le nouveau label
 *  - un erase_rect colore couvrant le path entier (teinte preservee)
 * L'ordre est important : insert AVANT erase pour que le rendu PASS 1
 * applique d'abord l'auto-erase blanc puis le rect colore par-dessus.
 */
function substituteSectionBanners(ctx: SubstituteContext): Operation[] {
  const ops: Operation[] = [];
  const label = (ctx.newSectionLabel ?? '').toUpperCase().trim();
  if (label.length === 0) return ops;
  const banners = ctx.sectionBannerSpans ?? [];
  const paths = ctx.rawPaths ?? [];
  const pageW = ctx.pageWidth;
  for (const span of banners) {
    // Path candidat : large (> 50% page) + bbox contient le span.
    const bg = paths.find((p) => {
      const pw = p.bbox[2] - p.bbox[0];
      if (pw < pageW * 0.5) return false;
      if (!(p.bbox[1] - 2 <= span.bbox[1] && p.bbox[3] + 2 >= span.bbox[3])) return false;
      if (!(p.bbox[0] - 2 <= span.bbox[0] && p.bbox[2] + 2 >= span.bbox[2])) return false;
      return true;
    });
    if (!bg) {
      // Fallback sans path colore : erase le texte d'origine + insert le
      // nouveau label. Pas de fond colore preserve, mais au moins le label
      // est correct (evite "EVIER" quand la section est "BARRES DE DOUCHES").
      // Erase elargi proportionnel a la largeur du nouveau label (cas Catalogue C
      // P6 "EVIER" → "EAUX CLAIRES" : nouveau label 2.4x plus long que
      // template → erase doit s'etendre suffisamment a droite pour effacer
      // toute la zone susceptible d'afficher l'ancien text).
      const newLabelWidth = estimateTextWidth(label, span.size);
      const tplWidth = span.bbox[2] - span.bbox[0];
      const eraseWidth = Math.max(newLabelWidth + 8, tplWidth + 10);
      const spanPad: Bbox = [
        span.bbox[0] - 5,
        span.bbox[1] - 3,
        span.bbox[0] + eraseWidth,
        span.bbox[3] + 3,
      ];
      ops.push({ op: 'erase_rect', bbox: spanPad });
      ops.push({
        op: 'insert_text',
        bbox: [span.bbox[0], span.bbox[1], span.bbox[0] + newLabelWidth + 10, span.bbox[3]],
        text: label,
        font: span.font,
        size: span.size,
        color: span.color,
      });
      continue;
    }
    // Erase blanc preliminaire couvrant la zone span template (faille Catalogue C
    // P6 "EAUX CLAIRES" : le span template "EVIER" deborde du bg orange a
    // gauche → "E" template residuel visible apres erase colore).
    const preEraseBbox: Bbox = [
      Math.min(span.bbox[0], bg.bbox[0]) - 4,
      span.bbox[1] - 3,
      Math.max(span.bbox[2], bg.bbox[2]) + 4,
      span.bbox[3] + 3,
    ];
    ops.push({ op: 'erase_rect', bbox: preEraseBbox });
    // Insert texte (l'auto-erase blanc PASS 1 sera ensuite recouvert par
    // l'erase colore qui vient juste apres).
    ops.push({
      op: 'insert_text',
      bbox: [span.bbox[0], span.bbox[1], bg.bbox[2], span.bbox[3]],
      text: label,
      font: span.font,
      size: span.size,
      color: span.color,
    });
    ops.push({ op: 'erase_rect', bbox: bg.bbox, color: bg.fill_color });
  }
  return ops;
}

/**
 * Polish : pour chaque span du template situe dans la zone d'un bloc et
 * NON couvert par une op existante (erase_rect ou insert_text), emet un
 * erase_rect cible. Nettoie les vestiges du produit d'origine qui
 * traineraient en arriere-plan apres la substitution.
 */
function polishResidualSpans(
  spans: TextSpan[],
  blocks: ProductBlock[],
  existingOps: Operation[],
  ctx: SubstituteContext,
): Operation[] {
  // Bbox deja couvertes par les ops emises (erase_rect ou insert_text)
  const coveredBboxes: Bbox[] = [];
  for (const op of existingOps) {
    if (op.op === 'erase_rect') coveredBboxes.push(op.bbox);
    else if (op.op === 'insert_text') coveredBboxes.push(op.bbox);
  }
  // Zone de chaque bloc (header + image + specs + variants), dernier bloc
  // etendu vers le footer pour absorber residus en bas de page.
  const blockZones = computeBlockZones(blocks, ctx);
  // Zone produit globale (bloquant #3) : UNION blocs + padding pour absorber
  // decoratifs hors-blocks (drapeaux ACS, etiquettes inter-blocs Catalogue E).
  // Active SEULEMENT si tous les blocs sont en horizontal layout
  // (preservation Catalogue A vertical : comportement legacy maintenu).
  const allHorizontal =
    blocks.length > 0 && blocks.every((b) => b.isHorizontalLayout === true);
  const globalZone = allHorizontal
    ? computeProductZoneGlobal(blocks, ctx)
    : null;
  const residuals: Bbox[] = [];
  for (const span of spans) {
    if (span.text.trim().length === 0) continue;
    // Le span doit etre DANS au moins une zone bloc OU dans la zone globale
    // (mode horizontal uniquement)
    const inBlock = blockZones.some((z) => intersects(span.bbox, z));
    const inGlobal = globalZone !== null && intersects(span.bbox, globalZone);
    if (!inBlock && !inGlobal) continue;
    // Pas couvert au-dessus de 40% par les ops existantes (anciennement 50%).
    // Plus permissif pour absorber les sous-titres template residuels type
    // "Exemple" sur Catalogue C P5 qui chevauchent partiellement les ops nouvelles.
    if (isCovered(span.bbox, coveredBboxes, 0.4)) continue;
    // Padding 4pt : les bbox extracted ne couvrent pas exactement la
    // hauteur reelle rendue (ascenders/descenders). 1pt etait insuffisant,
    // pixels residuels visibles sur Catalogue A variants p-5. 4pt absorbe glyphs
    // Catalogue C grands (nameSize 24-28pt).
    residuals.push(padBbox(span.bbox, 4));
  }
  return residuals.map((b) => ({ op: 'erase_rect' as const, bbox: b }));
}

/** Polish bitmap residuels : badges, pictos NF/Fabriques en France. Garde
 *  uniquement la mainImageBbox du bloc et les variantImages. */
function polishResidualBitmaps(
  images: Bbox[],
  blocks: ProductBlock[],
  existingOps: Operation[],
  ctx: SubstituteContext,
): Operation[] {
  const keepBboxes: Bbox[] = [];
  for (const block of blocks) {
    if (block.mainImageBbox) keepBboxes.push(block.mainImageBbox);
    keepBboxes.push(...block.variantImages);
  }
  // Ne pas re-erase ce qui l'a deja ete
  const erased: Bbox[] = existingOps
    .filter((o): o is OpEraseRect => o.op === 'erase_rect')
    .map((o) => o.bbox);
  const blockZones = computeBlockZones(blocks, ctx);
  const ops: Operation[] = [];
  for (const img of images) {
    if (!blockZones.some((z) => intersects(img, z))) continue;
    if (isCovered(img, keepBboxes, 0.5)) continue;
    if (isCovered(img, erased, 0.8)) continue;
    ops.push({ op: 'erase_rect', bbox: padBbox(img, 1) });
  }
  return ops;
}

/** Polish vectoriels : badges/pictos vectoriels dans les blocs. Garde les
 *  decorations structurelles (rubans, headers qui touchent les bords). */
function polishResidualVectors(
  vectors: Bbox[],
  blocks: ProductBlock[],
  ctx: SubstituteContext,
): Operation[] {
  const margin = 30;
  const blockZones = computeBlockZones(blocks, ctx);
  const ops: Operation[] = [];
  for (const v of vectors) {
    if (!blockZones.some((z) => intersects(v, z))) continue;
    const w = v[2] - v[0];
    const h = v[3] - v[1];

    // Structurel : couvre DEUX bords opposes (= banner pleine largeur,
    // ruban vertical, header band). Plus strict que "touche UN bord" qui
    // ratait les bandes longues partant d'un cote.
    const touchesLeft = v[0] < margin;
    const touchesRight = v[2] > ctx.pageWidth - margin;
    const touchesTop = v[1] < margin;
    const touchesBottom = v[3] > ctx.pageHeight - margin;
    if ((touchesLeft && touchesRight) || (touchesTop && touchesBottom)) {
      continue;
    }

    // P1.5 : ribbon long structurel touchant UN bord. Un cartouche vertical
    // etroit (w<30, h>30%) qui touche le top OU le bottom est probablement
    // un ruban de section qui ne descend qu'a mi-page (vu sur Catalogue A pages
    // produit secondaires). Ne pas effacer.
    const isVerticalRibbon = w < 30 && h > ctx.pageHeight * 0.3;
    const isHorizontalRibbon = h < 30 && w > ctx.pageWidth * 0.3;
    if (isVerticalRibbon && (touchesTop || touchesBottom)) continue;
    if (isHorizontalRibbon && (touchesLeft || touchesRight)) continue;

    // Fond / header band trop massif
    if (w > ctx.pageWidth * 0.7 || h > ctx.pageHeight * 0.5) continue;
    // Petits pictos < 6pt : trait de separation utile, on garde
    if (w < 6 && h < 6) continue;

    // Ligne fine horizontale ou verticale ANORMALEMENT longue : trait
    // decoratif (w/h > 30 et fine = < 3pt) → on l'efface meme si elle
    // touche un bord (la "ligne sous le nom" qui depasse).
    const aspectRatio = Math.max(w, h) / Math.max(1, Math.min(w, h));
    if (aspectRatio > 30 && Math.min(w, h) < 3) {
      ops.push({ op: 'erase_rect', bbox: padBbox(v, 1) });
      continue;
    }

    ops.push({ op: 'erase_rect', bbox: padBbox(v, 1) });
  }
  return ops;
}

export function computeBlockZones(
  blocks: ProductBlock[],
  ctx: SubstituteContext,
): Bbox[] {
  // Tri par yTop pour identifier le dernier bloc de la page (= celui dont
  // yBottom est le plus bas). On etend SA zone vers le bas jusqu'au footer
  // pour absorber les variants couleur / image lifestyle / badges qui
  // trainent entre le dernier produit et le pied de page.
  const sorted = [...blocks].sort((a, b) => a.yTop - b.yTop);
  const lastBlock = sorted[sorted.length - 1];
  // Padding vers le haut : 4pt par defaut, mais on etend jusqu'a 12pt sur
  // les blocs qui ont un voisin AU-DESSUS suffisamment espace, pour absorber
  // les badges type "NOUVEAUTE" / "PROMO" / pictos saisonniers qui flottent
  // entre 2 blocs et echappent au polish (faille review #8).
  // Limite par le yBottom du bloc precedent (pas de chevauchement).
  const BLOCK_TOP_PADDING_DEFAULT = 4;
  const BLOCK_TOP_PADDING_MAX = 12;
  return blocks.map((block) => {
    const isLast = block === lastBlock;
    // Trouver le bloc immediatement au-dessus (yBottom < block.yTop)
    const prevBlock = sorted
      .filter((b) => b.yBottom < block.yTop)
      .sort((a, b) => b.yBottom - a.yBottom)[0];
    const gapAbove = prevBlock
      ? block.yTop - prevBlock.yBottom
      : block.yTop; // pas de bloc au-dessus → toute la zone jusqu'au top page
    const topPadding = Math.min(
      BLOCK_TOP_PADDING_MAX,
      Math.max(BLOCK_TOP_PADDING_DEFAULT, gapAbove / 2 - 1),
    );
    const yBottom = isLast
      ? Math.max(block.yBottom + 4, ctx.pageHeight - 30)
      : block.yBottom + 4;
    return [
      Math.min(block.nameSpan.bbox[0], block.specsXLeft) - 4,
      block.yTop - topPadding,
      ctx.pageWidth - ctx.profile.ribbonMargin,
      yBottom,
    ] as Bbox;
  });
}

/** Calcule UNE bbox UNION couvrant tous les blocs produit de la page +
 *  padding modere. Sert au polish "zone produit globale" : on absorbe
 *  les decoratifs (drapeaux ACS/CSTBat, etiquettes "Diametre 12/16/20"
 *  sur Catalogue E) qui flottent ENTRE les blocs et echappaient au polish
 *  block-zone individuel.
 *
 *  Bornes :
 *   - x : min/max parmi tous les blocs + padding margin
 *   - y : top du 1er bloc - paddingTop, bottom du dernier - paddingBottom
 *
 *  Exclusion : ne couvre PAS les marges header/footer (top 30pt, bottom 30pt)
 *  pour preserver titres section + pagination.
 *
 *  Retourne null si pas de blocs (rien a polish au global). */
export function computeProductZoneGlobal(
  blocks: ProductBlock[],
  ctx: SubstituteContext,
  options: { paddingX?: number; paddingY?: number; headerMargin?: number; footerMargin?: number } = {},
): Bbox | null {
  if (blocks.length === 0) return null;
  const paddingX = options.paddingX ?? 8;
  const paddingY = options.paddingY ?? 6;
  const headerMargin = options.headerMargin ?? 30;
  const footerMargin = options.footerMargin ?? 30;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const b of blocks) {
    xMin = Math.min(xMin, b.nameSpan.bbox[0], b.specsXLeft);
    xMax = Math.max(xMax, b.nameSpan.bbox[2], b.specsXLeft + 200);
    yMin = Math.min(yMin, b.yTop);
    yMax = Math.max(yMax, b.yBottom);
  }
  return [
    Math.max(0, xMin - paddingX),
    Math.max(headerMargin, yMin - paddingY),
    Math.min(ctx.pageWidth, xMax + paddingX),
    Math.min(ctx.pageHeight - footerMargin, yMax + paddingY),
  ];
}

function intersects(a: Bbox, b: Bbox): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

function isCovered(span: Bbox, covered: Bbox[], threshold: number): boolean {
  const spanArea = Math.max(0, (span[2] - span[0]) * (span[3] - span[1]));
  if (spanArea <= 0) return true;
  for (const c of covered) {
    const ix0 = Math.max(span[0], c[0]);
    const iy0 = Math.max(span[1], c[1]);
    const ix1 = Math.min(span[2], c[2]);
    const iy1 = Math.min(span[3], c[3]);
    if (ix1 <= ix0 || iy1 <= iy0) continue;
    const interArea = (ix1 - ix0) * (iy1 - iy0);
    if (interArea / spanArea >= threshold) return true;
  }
  return false;
}

// padBbox : voir utils/bbox.ts (factorisation audit #12).

/** Substitue un bloc template avec un produit nouveau (style emprunte). */
export function substituteBlock(
  block: ProductBlock,
  product: PlanProduct,
  ctx: SubstituteContext,
): Operation[] {
  const ops: Operation[] = [];

  // 0. Erase de fond du bloc complet AVANT toute insertion. Couvre les
  // spans permanents du template qui ne sont pas explicitement substitués
  // par les étapes 1-5 ci-dessous (codes-barres, sous-titres "LES + PRODUITS",
  // étiquettes décoratives, etc.). Sans ce nettoyage, le contenu original
  // se superpose au nouveau produit.
  //
  // Zone : du X gauche (min nameSpan / specsXLeft) au X droit (avant
  // ribbon), Y du haut du nom au bas du bloc. PAD modéré pour ne pas
  // déborder sur des éléments décoratifs adjacents (banners section,
  // ribbon vertical).
  //
  // Extension haute : couvre une zone supplémentaire de ~2 lignes au-dessus
  // du nameSpan pour capturer les titres internes / sous-headers serrés
  // (ex Catalogue C "LES + PRODUITS" à Y_titre = yTop - 11pt). Calibré sur
  // 2 * nameSize → ~30pt à 15pt. Sur Catalogue A (3 blocs/page), cette extension
  // n'atteint pas le bloc précédent (gap typique ~150pt entre 2 blocs).
  //
  // Garde-fou : ne s'applique QUE si le bloc a une zone bien définie
  // (yBottom > yTop + 20pt). Évite d'effacer toute la page en cas de
  // bloc dégénéré.
  const BLOCK_ERASE_PAD = 2;
  const BLOCK_ERASE_TOP_EXTRA_LINES = 2;
  // Clamp yBottom (faille Catalogue C P6 vide) : si yBottom > 85% pageH, on est
  // sur le dernier bloc avec yBottom estime jusqu'au footer. Sans clamp,
  // l'erase fond efface 50%+ de la page sans pouvoir remplir → page blanche.
  // Limite raisonnable : max(yTop + 300, 85% pageH). 300pt couvre une fiche
  // produit standard (header + image + 5-7 specs).
  // Cap conservateur Catalogue A : sur Catalogue A les blocs font ~250pt → 300pt suffit.
  const blockHeight = block.yBottom - block.yTop;
  if (blockHeight > 20) {
    const xLeft = Math.min(block.nameSpan.bbox[0], block.specsXLeft) - BLOCK_ERASE_PAD;
    // En mode horizontal : clamp xRight a la col du bloc (sinon le erase fond
    // couvre la page entiere et detruit les blocs voisins). Cas Catalogue C P14 :
    // 3 blocs ECOP/ECL/ECL cote a cote → chaque erase pleine largeur effacait
    // les autres.
    const xRight =
      ctx.horizontalMode !== undefined && ctx.horizontalColRight !== undefined
        ? ctx.horizontalColRight
        : ctx.pageWidth - ctx.profile.ribbonMargin;
    const topExtra = block.nameSpan.size * BLOCK_ERASE_TOP_EXTRA_LINES;
    const yBottomCap = ctx.pageHeight * 0.85;
    const safeYBottom =
      block.yBottom > yBottomCap
        ? Math.max(block.yTop + 300, yBottomCap)
        : block.yBottom;
    ops.push({
      op: 'erase_rect',
      bbox: [
        Math.max(0, xLeft),
        Math.max(0, block.yTop - BLOCK_ERASE_PAD - topExtra),
        xRight,
        safeYBottom + BLOCK_ERASE_PAD,
      ],
    });
  }

  // 1. Nom produit : reflow adaptatif. Tente 1 ligne a taille originale,
  // wrap 2 lignes si necessaire, shrink jusqu'a 70%, ellipse en dernier
  // recours. Bottom-bound = top du color/ref pour ne pas chevaucher.
  // Mode horizontal (S6.5) : rightBound = col du bloc voisin (eviter le nom
  // de wrapper sur le produit a droite). Sinon legacy = pleine page.
  const colorTopY = block.colorSpan
    ? block.colorSpan.bbox[1] - 2
    : block.nameSpan.bbox[3] + 12;
  const nameRightBound =
    ctx.horizontalColRight !== undefined && ctx.horizontalMode !== undefined
      ? ctx.horizontalColRight - 4
      : ctx.pageWidth - ctx.profile.ribbonMargin - 6;
  const nameReflow = reflowName({
    text: product.name ?? '',
    span: block.nameSpan,
    rightBound: nameRightBound,
    bottomBound: colorTopY,
    maxLines: 2,
  });
  ops.push(...nameReflow.ops);

  // 2. Color + Ref sous le nom
  ops.push(...substituteColorAndRef(block, product, ctx.profile));

  // 3. Specs : reecriture aux memes positions. V2 = tableau categorise avec
  // dot leader + headers de categorie + layout responsive. V1 = layout legacy
  // (selectionnable via env REFLOW_SPECS=v1 pour comparaison/rollback).
  // V1 deprecated (refacto Phase 2) : warning emis si active.
  const useSpecsV1 = process.env.REFLOW_SPECS === 'v1';
  if (useSpecsV1) {
    warnDeprecatedReflowV1();
    ops.push(...reflowSpecsModule(block, product, ctx));
  } else {
    // Propagation mode horizontal (S6.5) depuis SubstituteContext vers
    // ReflowSpecsV2Context.
    ops.push(
      ...reflowSpecsV2(block, product, {
        ...ctx,
        horizontalMode: ctx.horizontalMode,
        horizontalColRight: ctx.horizontalColRight,
      }),
    );
  }

  // 4. Variantes (drop si rien, sinon dessine avec layout MULTI-LIGNES si
  // plus de variants que de positions template)
  ops.push(...reflowVariantsModule(block, product, ctx.profile));

  // 5. Image principale : on calcule une bbox GENEREUSE qui prend toute la
  // zone disponible du bloc (entre header et bas, jusqu'a la colonne specs).
  // Ainsi une image produit carree (500x500) n'est plus reduite a 86x86 dans
  // la bbox etriquee du faucet template, mais inscrite dans 200x200 typique.
  // Image template : on l'efface TOUJOURS (qu'on ait une image source ou
  // non). Sinon l'ancien mitigeur Athena/Ravea persiste a cote du nouveau
  // produit (incoherent visuellement). Si block.mainImageBbox detecte =
  // erase explicite de cette bbox + 2pt padding. Sinon erase de la zone
  // calculee par computeImageBbox.
  const imageBbox = computeImageBbox(block, ctx);
  if (block.mainImageBbox) {
    const m = block.mainImageBbox;
    ops.push({
      op: 'erase_rect',
      bbox: [m[0] - 2, m[1] - 2, m[2] + 2, m[3] + 2],
    });
  } else {
    ops.push({ op: 'erase_rect', bbox: imageBbox });
  }
  if (product.image_path) {
    const drawImg: OpDrawImage = {
      op: 'draw_image',
      bbox: imageBbox,
      image_path: product.image_path,
      fit: 'contain',
    };
    ops.push(drawImg);
  } else {
    // Tracking : pas d'image source pour ce produit. Le bloc apparait erase
    // mais sans nouvelle image → zone blanche. Utile pour audit assets.zip
    // incomplet (faille audit pipeline).
    recordMissingProductImage(block.pageNumber, product.name ?? '(sans nom)');
  }

  return ops;
}

// ─── Deprecation reflowSpecs V1 (Phase 2 refacto) ──────────────────────────
let v1DeprecationWarned = false;
function warnDeprecatedReflowV1() {
  if (v1DeprecationWarned) return;
  v1DeprecationWarned = true;
  console.warn(
    '[substitutor] REFLOW_SPECS=v1 est DEPRECATED. Sera supprime dans une '
      + 'version future. Utilisez REFLOW_SPECS=v2 (default) ou unset.',
  );
}

// ─── Stats produits sans image (audit assets.zip) ───────────────────────────
export interface MissingImageInfo {
  pageNumber: number;
  productName: string;
}
const missingImages: MissingImageInfo[] = [];
function recordMissingProductImage(pageNumber: number, productName: string) {
  missingImages.push({ pageNumber, productName });
  if (process.env.DEBUG_SUBSTITUTOR) {
    console.warn(
      `[substitutor] page=${pageNumber} produit="${productName}" sans image (assets.zip incomplet ?)`,
    );
  }
}
export function getMissingProductImages(): readonly MissingImageInfo[] {
  return missingImages;
}
export function resetMissingProductImages(): void {
  missingImages.length = 0;
}

/**
 * Calcule la bbox CIBLE de l'image principale du nouveau produit dans
 * le bloc. Le render applique fit:'contain' donc l'image source garde
 * son ratio et est centree dans cette bbox.
 *
 * Strategie : grande bbox = toute la zone dispo entre header et bas du
 * bloc, du nom jusqu'a la colonne specs. fit:contain donnera :
 *   - image carree (mitigeur) → s'inscrit a la taille de la zone
 *   - image verticale (barre douche 1:5) → remplit la hauteur, largeur
 *     proportionnelle, centree horizontalement
 *   - image paysage → remplit la largeur, hauteur proportionnelle,
 *     centree verticalement
 *
 * On NE prend PAS la bbox du template (souvent etroite = mitigeur ~80x80)
 * car elle ecraserait une image verticale a quelques pt de large.
 */
/** Seuil minimum largeur image (pt) en deca duquel on considere l'image
 *  visuellement degeneree (peu lisible). Cas typique : Catalogue E dense ou
 *  template compact ou specsXLeft est proche du nameSpan. */
const IMAGE_MIN_VISIBLE_WIDTH = 60;
/** Seuil minimum hauteur image (pt) en deca duquel on considere l'image
 *  visuellement degeneree (bloc trop court). */
const IMAGE_MIN_VISIBLE_HEIGHT = 60;

export interface DegenerateImageInfo {
  pageNumber: number;
  productName: string;
  bbox: Bbox;
  width: number;
  height: number;
  reason: 'narrow' | 'short' | 'narrow+short';
}
const degenerateImages: DegenerateImageInfo[] = [];
function recordDegenerateImage(info: DegenerateImageInfo) {
  degenerateImages.push(info);
  if (process.env.DEBUG_SUBSTITUTOR) {
    console.warn(
      `[substitutor] page=${info.pageNumber} produit="${info.productName}" image bbox degeneree (${info.width.toFixed(1)}x${info.height.toFixed(1)}pt, raison=${info.reason})`,
    );
  }
}
export function getDegenerateImages(): readonly DegenerateImageInfo[] {
  return degenerateImages;
}
export function resetDegenerateImages(): void {
  degenerateImages.length = 0;
}

function computeImageBbox(block: ProductBlock, _ctx: SubstituteContext): Bbox {
  const xLeftZone = block.nameSpan.bbox[0];
  // Guard : sur templates compacts, specsXLeft peut etre <= nameSpan.bbox[0]
  // → bbox degeneree x1 < x0 → PDFium reçoit une matrice negative.
  const xRightZone = Math.max(xLeftZone + 20, block.specsXLeft - 10);
  const headerBottom =
    (block.colorSpan ? block.colorSpan.bbox[3] : block.nameSpan.bbox[3]) + 12;
  const yTopZone = Math.max(block.yTop + 8, headerBottom);
  // Bottom : zone du bloc complet, PLAFONNEE a 320pt pour homogeneiser les
  // tailles d'image entre blocs. Sinon le dernier bloc de la page prend
  // toute la place jusqu'au footer (~440pt), tandis qu'un bloc au milieu
  // est limite par le bloc suivant (~330pt) → asymetrie visible.
  const yBotZoneMax = block.yBottom - 6;
  // Plafond adaptatif : 50% de la hauteur de page (vs 40% trop conservateur
  // qui rendait les images trop petites sur les pages 1-produit ou 2-produits
  // avec beaucoup d'espace dispo). Sur A4 portrait (842pt) → 421pt.
  const maxH = _ctx.pageHeight * 0.5;
  const targetH = Math.min(yBotZoneMax - yTopZone, maxH);
  // Clamp : si le bloc fait < 30pt de haut, yTopZone+30 deborderait hors
  // de yBotZoneMax → l'image chevauche le bloc suivant.
  const yBotZone = Math.min(yTopZone + Math.max(targetH, 30), yBotZoneMax);
  const bbox: Bbox = [xLeftZone, yTopZone, xRightZone, yBotZone];

  // Audit : si la bbox finale est visuellement degeneree, on l'enregistre.
  const w = xRightZone - xLeftZone;
  const h = yBotZone - yTopZone;
  const isNarrow = w < IMAGE_MIN_VISIBLE_WIDTH;
  const isShort = h < IMAGE_MIN_VISIBLE_HEIGHT;
  if (isNarrow || isShort) {
    const reason: DegenerateImageInfo['reason'] = isNarrow && isShort
      ? 'narrow+short'
      : isNarrow
        ? 'narrow'
        : 'short';
    recordDegenerateImage({
      pageNumber: block.pageNumber,
      productName: block.nameSpan.text,
      bbox,
      width: w,
      height: h,
      reason,
    });
  }
  return bbox;
}

/** Efface le contenu d'un bloc (cas "produit manquant"). Resultat : zone blanche. */
function eraseBlock(block: ProductBlock, ctx: SubstituteContext): Operation[] {
  const ops: Operation[] = [];
  const eraseRight = ctx.pageWidth - ctx.profile.ribbonMargin;
  const eraseLeft = Math.min(block.nameSpan.bbox[0], block.specsXLeft) - 4;
  const yTop = block.yTop - 4;
  const yBot = block.yBottom + 4;
  const blockZone: Bbox = [eraseLeft, yTop, eraseRight, yBot];
  ops.push({ op: 'erase_rect', bbox: blockZone });
  // Image principale aussi
  if (block.mainImageBbox) {
    ops.push({ op: 'erase_rect', bbox: block.mainImageBbox });
  }
  // Variantes images aussi
  for (const v of block.variantImages) {
    ops.push({ op: 'erase_rect', bbox: v });
  }
  // Pictos vectoriels qui debordent du bloc (cercles promo, badges) :
  // l'erase_rect global couvre l'interieur du bloc mais un picto peut
  // depasser (ex cercle "NOUVEAUTE" ancre en haut-gauche). On efface
  // individuellement ceux qui intersectent la zone bloc.
  if (ctx.decorationVectors) {
    for (const v of ctx.decorationVectors) {
      if (!intersects(v, blockZone)) continue;
      // Skip structurels (rubans pleine largeur)
      const w = v[2] - v[0];
      if (w > ctx.pageWidth * 0.7) continue;
      ops.push({ op: 'erase_rect', bbox: padBbox(v, 1) });
    }
  }
  // Bitmaps residuels dans le bloc (badges NF, pictos) sauf image principale
  if (ctx.rawImages) {
    const keepBboxes: Bbox[] = [];
    if (block.mainImageBbox) keepBboxes.push(block.mainImageBbox);
    keepBboxes.push(...block.variantImages);
    for (const img of ctx.rawImages) {
      if (!intersects(img, blockZone)) continue;
      if (isCovered(img, keepBboxes, 0.5)) continue;
      ops.push({ op: 'erase_rect', bbox: padBbox(img, 1) });
    }
  }
  return ops;
}

// ─── Substitutions atomiques ─────────────────────────────────────────────────

interface InsertAtSpanOptions {
  /** Force le bord droit de la bbox d'erase a ce X. Utile pour le nom
   *  produit (efface la ligne decorative horizontale du template). */
  eraseToRight?: number;
}

/**
 * Insert_text au meme endroit qu'un span existant. Extension de bbox a
 * droite si le nouveau texte est plus long, ou si eraseToRight est fourni
 * (force l'erase plus loin pour absorber des elements decoratifs).
 */
function insertAtSpan(
  span: TextSpan,
  newText: string,
  options: InsertAtSpanOptions = {},
): OpInsertText {
  // P0.4 : translate les glyphes exotiques (smart quotes, ligatures, …)
  // en ASCII proche. Sans ça, Helvetica fallback (font name non trouvee)
  // affiche `.notdef` (rectangle vide) sur '–', 'œ', '…', etc.
  const safe = safeText(newText);
  const oldLen = span.text.trim().length;
  const newLen = safe.length;
  const naturalExtension =
    newLen > oldLen ? (newLen - oldLen) * span.size * TEXT_WIDTH_COEFS.mixed : 0;
  const xRight = options.eraseToRight
    ? Math.max(span.bbox[2] + naturalExtension, options.eraseToRight)
    : span.bbox[2] + naturalExtension;
  const bbox: Bbox = [span.bbox[0], span.bbox[1], xRight, span.bbox[3]];
  return {
    op: 'insert_text',
    bbox,
    text: safe,
    font: span.font,
    size: span.size,
    // safeTextColor : bascule au noir si span.color est tres clair (cas
    // Catalogue C ou` les noms produit sont en blanc sur cartouche colore qui
    // est efface par le erase fond bloc → texte blanc invisible).
    color: safeTextColor(span.color),
  };
}

/**
 * Substitue color + ref. 3 cas :
 *  1. 2 spans distincts (color + ref separes) → 2 inserts independants
 *  2. 1 seul span detecte (cas "Chromé 304740 4050955" en 1 span) → 1 insert combine
 *  3. Aucun span → fallback sous le nom
 */
function substituteColorAndRef(
  block: ProductBlock,
  product: PlanProduct,
  profile: TemplateProfile,
): Operation[] {
  const ops: Operation[] = [];
  const newColor = (product.color ?? '').trim();
  const newRef = (product.ref ?? '').trim();
  if (!newColor && !newRef) return ops;

  // Cas 1 : 2 spans distincts
  if (block.colorSpan && block.refSpan && block.colorSpan !== block.refSpan) {
    // Erase EXPLICITE qui couvre toute la zone color+ref AVANT les inserts.
    // Sinon l'auto-erase blanc de chaque insert_text laisse un trou entre
    // la fin de l'insert color (auto-erase blanc x0..x_color_end) et le
    // debut de l'insert ref (auto-erase blanc refX..refX_end), dans lequel
    // l'ancien debut du ref template ("304740") reste visible (vu "₃₀"
    // entre "Chromé" et la nouvelle ref).
    const colorWidth = newColor
      ? newColor.length * block.colorSpan.size * TEXT_WIDTH_COEFS.upper
      : 0;
    const renderedColorEnd = block.colorSpan.bbox[0] + colorWidth;
    const minRefX = renderedColorEnd + profile.colorRefSpacing;
    const refX = Math.max(block.refSpan.bbox[0], minRefX);
    const shift = refX - block.refSpan.bbox[0];
    const eraseY0 = Math.min(block.colorSpan.bbox[1], block.refSpan.bbox[1]) - 2;
    const eraseY1 = Math.max(block.colorSpan.bbox[3], block.refSpan.bbox[3]) + 2;
    const eraseX1 = block.refSpan.bbox[2] + shift + 2;
    ops.push({
      op: 'erase_rect',
      bbox: [block.colorSpan.bbox[0] - 2, eraseY0, eraseX1, eraseY1],
    });
    if (newColor) ops.push(insertAtSpan(block.colorSpan, newColor));
    if (newRef) {
      ops.push({
        op: 'insert_text',
        bbox: [refX, block.refSpan.bbox[1], block.refSpan.bbox[2] + shift, block.refSpan.bbox[3]],
        text: safeText(newRef),
        font: block.refSpan.font,
        size: block.refSpan.size,
        color: block.refSpan.color,
      });
    }
    return ops;
  }

  // Cas 2 : un seul span combine
  const singleSpan = block.colorSpan ?? block.refSpan;
  if (singleSpan) {
    const combined = [newColor, newRef].filter(Boolean).join('  ');
    ops.push(insertAtSpan(singleSpan, combined));
    return ops;
  }

  // Cas 3 : fallback sous le nom
  // Gap eleve (= size + 6) pour eviter un overlap si le render C++ interprete
  // bbox[1] comme TOP du texte vs baseline (cas observe sur Catalogue C : la ref
  // remontait dans le nom → "AG2236TAR 900" au lieu de "AQUASTAR 900").
  // En plus on emet un erase explicite de la zone sous le nom AVANT l'insert
  // pour garantir qu'aucun residu template n'apparait derriere la ref.
  const fallbackText = [newColor, newRef].filter(Boolean).join('  ');
  if (!fallbackText.trim()) return ops;
  const nameBbox = block.nameSpan.bbox;
  const fbSize = profile.colorRefSizeRange[0];
  const fbY0 = nameBbox[3] + fbSize + 6.0;
  const fbY1 = fbY0 + fbSize + 4.0;
  const fbX0 = nameBbox[0];
  const fbX1 = nameBbox[2] + 150;
  // Erase explicite SOUS le nom (separe le nom de la ref visuellement et
  // efface tout span template residuel dans cette zone).
  ops.push({
    op: 'erase_rect',
    bbox: [fbX0 - 2, nameBbox[3] + 2, fbX1, fbY1 + 2],
  });
  ops.push({
    op: 'insert_text',
    bbox: [fbX0, fbY0, fbX1, fbY1],
    text: safeText(fallbackText),
    font: profile.headerColorFontPattern,
    size: fbSize,
    color: '#231f20',
  });
  return ops;
}

// ─── Helper largeur texte ────────────────────────────────────────────────────

/**
 * Coefficients de largeur pour estimateTextWidth.
 * UPPER = majuscules tabulaires (titres, refs). DIGITS = chiffres. MIXED =
 * fallback minuscules/mixed. Ces valeurs sont calibrees sur Almanach-* mais
 * tiennent pour la plupart des fonts sans-serif a corps regulier.
 *
 * Si tu changes ces coefs, vérifie le rendu sur :
 *   - noms produits longs (estimateTextWidth dans reflowSpecs)
 *   - extension naturelle dans insertAtSpan ligne ~360
 */
export const TEXT_WIDTH_COEFS = {
  upper: 0.65,
  digits: 0.6,
  mixed: 0.55,
} as const;

