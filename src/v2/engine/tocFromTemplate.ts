/**
 * Sommaire intelligent : reutilise la page sommaire ORIGINALE du template
 * (avec sa deco, son titre, sa typo) et substitue les entries avec les
 * sections du catalogue genere.
 *
 * Strategie :
 *   1. Trouver la 1ere page kind='toc' qui contient des spans pattern "p.\d+"
 *      (= vrai sommaire avec page references)
 *   2. Parser les entries originales : pour chaque "p.XX", retrouver le label
 *      a gauche sur la meme ligne Y
 *   3. Generer ops :
 *      - erase_rect sur chaque label + page number
 *      - insert_text avec nouveau label + nouveau numero de page (style template
 *        preserve : meme font / size / color / bbox)
 *   4. Le caller positionne cette page juste avant la 1ere page produit
 */
import type { Bbox, ExtractedPage, Operation, TextSpan } from '../types';
import type { PageClassification } from './classify';
import type { PageAllocation } from './allocator';
import { padBbox } from '../utils/bbox';

/**
 * Match un span "numero de page de TOC". Couvre les formats courants
 * multi-langue :
 *  - "12"               (numero seul, design moderne)
 *  - "12."              (avec point final)
 *  - "p.12" / "p. 12" / "p 12"   (FR/EN abrégé)
 *  - "page 12" / "Page 12"       (FR/EN long)
 *  - "pg 12" / "pgs 12"          (EN)
 *  - "pag. 12" / "pag 12"        (IT/ES abrégé)
 *  - "pág. 12"                   (ES)
 *  - "pagina 12" / "página 12"   (IT/ES long)
 *  - "S. 12" / "S.12" / "Seite 12" (DE)
 *  - "→ 12" / "▸ 12" / "● 12"    (TOC design avec puce)
 *
 * Le span doit etre court (= prefixe optionnel + chiffres + suffixe rien
 * ou point). Filtre supplementaire ensuite : position bbox + label a gauche.
 */
export const PAGE_NUM_RE = new RegExp(
  '^\\s*' +
    '(?:' +
      // Prefixes textuels (FR/EN/DE/IT/ES). Tous optionnels.
      'p(?:age|ag|ág|gs?|agina|ágina)?\\.?\\s+|' +
      'p\\.?\\s*|' +
      'seite\\s+|s\\.\\s*|' +
      'pag(?:ina)?\\.?\\s+|pág(?:ina)?\\.?\\s+|' +
      // Puces / fleches design (suivies d'un whitespace obligatoire)
      '[→▸▶▷►●•‣]\\s+' +
    ')?' +
    '\\d{1,4}' +
    '\\.?' + // point final optionnel
    '\\s*$',
  'i',
);
const Y_TOLERANCE_PT = 4;

/** Ops a appliquer sur UNE page du sommaire. Si pages.length > 1, chaque
 *  page reutilise la meme sourcePage tpl comme background (= deco + titre
 *  pour page 1, deco sans titre pour pages suivantes). */
export interface TocPage {
  /** sourcePage du template a reutiliser comme fond. */
  sourcePage: number;
  /** Ops a appliquer (erase + insert) sur cette page. */
  ops: Operation[];
  /** Nombre d'items rendered sur cette page (incl. headers family/subfamily). */
  itemsWritten: number;
  /** True si c'est la 1ere page (= avec titre SOMMAIRE), false sinon. */
  isFirstPage: boolean;
}

export interface TocFromTemplateResult {
  /** Pages du sommaire (peut etre 0, 1 ou plusieurs si overflow). */
  pages: TocPage[];
  /** sourcePage du template (premiere page tpl identifiee). null si non trouve. */
  sourcePage: number | null;
  /** Ops de la 1ere page (compat existant). */
  ops: Operation[];
  /** Nombre total d'entries section ecrites (toutes pages confondues). */
  entriesWritten: number;
  /** Nombre d'entries originales effacees (sur la page tpl). */
  entriesErased: number;
  /** Debug : liste candidates avec leur entries count. */
  debug?: string;
}

interface TocEntryTemplate {
  labelSpan: TextSpan;
  pageSpan: TextSpan;
  /** Spans de leader dots entre label et page number (a effacer aussi). */
  dotsSpans: TextSpan[];
}

export interface NewEntry {
  label: string;
  pageNumber: number;
  /** Famille parente (= libelle famille majoritaire des produits de la section).
   *  Sert au regroupement hierarchique. Vide si aucune famille renseignee. */
  family: string;
  /** Sous-famille parente (= libelle sfamille majoritaire). Niveau intermediaire
   *  entre family et section. Vide si aucune sous-famille renseignee. */
  subFamily: string;
}

/** Item a rendre dans le sommaire :
 *  - 'family'    : header de niveau 1 (sans numero de page, taille XL)
 *  - 'subfamily' : header de niveau 2 (sans numero de page, taille L, indenté)
 *  - 'section'   : entry de niveau 3 (avec numero de page, indenté davantage)
 *  - 'extra'     : entry libre AJOUTEE EN FIN DE SOMMAIRE (style = section
 *                  mais gap supplementaire au-dessus, pas de description).
 *                  Utilise pour "Cahier technique" et autres ajouts post-toc.
 *  Le rendering decide du style selon kind. */
export type ItemKind = 'family' | 'subfamily' | 'section' | 'extra';

export interface RenderedItem {
  kind: ItemKind;
  label: string;
  pageNumber?: number;
}

/** Entree libre ajoutee en fin de sommaire (apres les sections produit) avec
 *  un petit gap visuel. Ne participe pas a la hierarchie family/subfamily. */
export interface TocExtraEntry {
  label: string;
  pageNumber: number;
}

export function buildTocFromTemplate(
  classifications: PageClassification[],
  allocations: PageAllocation[],
  pagePlans: { source_page: number; page_number: number | null }[],
  /** Map sectionLabel → description marketing (1-2 phrases). Si fournie,
   *  la zone description du sommaire est remplie avec ces phrases au lieu
   *  d'etre simplement effacee. */
  descriptions: Record<string, string> = {},
  /** Entries libres a ajouter EN FIN de sommaire (style section + gap top).
   *  Cas d'usage : "Cahier technique" qui n'est pas une vraie section produit
   *  mais doit etre listee dans le sommaire. */
  extraEntries: TocExtraEntry[] = [],
): TocFromTemplateResult {
  // 1. Trouver page TOC TEXTE (pas sommaire visuel a grille d'icones). On
  // privilegie les pages dont les labels sont longs (en moyenne > 8 chars) :
  // une vraie liste texte ("Lavabos bas mitigeurs") vs une grille de modeles
  // ("Onari", "Ylus", "Joker"). Parmi les candidates valides, on prend celle
  // qui a le plus d'entries.
  const MIN_AVG_LABEL_LEN = 8;
  let tocPage: PageClassification | null = null;
  let entries: TocEntryTemplate[] = [];
  let bestScore = 0;
  for (const c of classifications) {
    if (c.kind !== 'toc') continue;
    const refs = (c.extracted.raw_spans ?? []).filter((s) =>
      PAGE_NUM_RE.test(s.text.trim()),
    ).length;
    if (refs < 3) continue;
    const candidateEntries = parseTocEntries(c.extracted);
    if (candidateEntries.length === 0) continue;
    const avgLen = candidateEntries.reduce((s, e) => s + e.labelSpan.text.trim().length, 0)
      / candidateEntries.length;
    if (avgLen < MIN_AVG_LABEL_LEN) continue; // sommaire visuel grille → skip
    // Score : nb entries * avgLen (favorise les sommaires avec labels riches)
    const score = candidateEntries.length * Math.min(avgLen, 25);
    if (score > bestScore) {
      bestScore = score;
      tocPage = c;
      entries = candidateEntries;
    }
  }
  if (!tocPage || entries.length === 0) {
    return { pages: [], sourcePage: null, ops: [], entriesWritten: 0, entriesErased: 0 };
  }

  // 3. Construire les nouvelles entries depuis allocations + pagePlans
  const newEntries = buildNewEntries(allocations, pagePlans);
  if (newEntries.length === 0) {
    return { pages: [], sourcePage: null, ops: [], entriesWritten: 0, entriesErased: 0 };
  }

  // 4. Construction des items a rendre (sections + headers famille/sfamille)
  const items = groupIntoHierarchy(newEntries);
  const isHierarchical = items.some((it) => it.kind === 'family');
  // Ajout des entries libres EN FIN DE LISTE (apres toutes les sections).
  // Le kind 'extra' declenche un gap au-dessus (style section + air visuel).
  for (const extra of extraEntries) {
    if (!extra.label || !Number.isFinite(extra.pageNumber)) continue;
    items.push({
      kind: 'extra',
      label: extra.label,
      pageNumber: extra.pageNumber,
    });
  }

  // ── Spans à effacer (communs à toutes les pages du sommaire) ────────────
  // Ces spans appartiennent à la page tpl en background et doivent être
  // effacés sur CHAQUE page sommaire (puisqu'on duplique la page tpl autant
  // que nécessaire). Le titre "SOMMAIRE" est lui réinséré seulement sur la
  // 1ère page (continuation sans titre sur les suivantes).
  const reusedCount = isHierarchical ? 0 : Math.min(newEntries.length, entries.length);
  const eraseEntriesOps: Operation[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    eraseEntriesOps.push({ op: 'erase_rect', bbox: padBbox(entry.labelSpan.bbox, 2) });
    eraseEntriesOps.push({ op: 'erase_rect', bbox: padBbox(entry.pageSpan.bbox, 2) });
    if (i >= reusedCount) {
      for (const dots of entry.dotsSpans) {
        eraseEntriesOps.push({ op: 'erase_rect', bbox: padBbox(dots.bbox, 2) });
      }
    }
  }

  // Titre tpl à effacer + remplacer par "SOMMAIRE" (sur page 1 seulement).
  const firstEntryY = entries[0].labelSpan.bbox[1];
  const pageWidth = tocPage.extracted.page_size.width;
  const pageHeight = tocPage.extracted.page_size.height;
  const titleAreaSpans = (tocPage.extracted.raw_spans ?? []).filter((s) => {
    if (s.bbox[3] >= firstEntryY - 5) return false;
    const t = s.text.trim();
    if (t.length < 2) return false;
    const w = s.bbox[2] - s.bbox[0];
    const h = s.bbox[3] - s.bbox[1];
    if (h > w * 1.5) return false;
    if (s.bbox[0] > pageWidth * 0.8) return false;
    return true;
  });
  const eraseTitleOps: Operation[] = titleAreaSpans.map((s) => ({
    op: 'erase_rect' as const, bbox: padBbox(s.bbox, 3),
  }));
  const biggestTitle = [...titleAreaSpans].sort((a, b) => b.size - a.size)[0];
  const insertTitleOp: Operation | null = biggestTitle ? {
    op: 'insert_text',
    bbox: biggestTitle.bbox,
    text: 'SOMMAIRE',
    font: biggestTitle.font,
    size: biggestTitle.size,
    color: biggestTitle.color,
  } : null;

  // Effacement spans hors entries (descriptions marketing tpl etc.)
  const titleBottom = titleAreaSpans.length > 0
    ? Math.max(...titleAreaSpans.map((s) => s.bbox[3]))
    : 100;
  const entryBboxes = new Set<string>();
  for (const e of entries) {
    entryBboxes.add(JSON.stringify(e.labelSpan.bbox));
    entryBboxes.add(JSON.stringify(e.pageSpan.bbox));
    for (const d of e.dotsSpans) entryBboxes.add(JSON.stringify(d.bbox));
  }
  const otherSpansToErase = (tocPage.extracted.raw_spans ?? []).filter((s) => {
    if (entryBboxes.has(JSON.stringify(s.bbox))) return false;
    if (s.bbox[1] < titleBottom + 5) return false;
    if (s.bbox[3] > pageHeight - 25) return false;
    const t = s.text.trim();
    if (t.length < 2) return false;
    const w = s.bbox[2] - s.bbox[0];
    const h = s.bbox[3] - s.bbox[1];
    if (h > w * 1.5) return false;
    if (s.bbox[0] > pageWidth * 0.85) return false;
    return true;
  });
  const eraseOtherOps: Operation[] = otherSpansToErase.map((s) => ({
    op: 'erase_rect' as const, bbox: padBbox(s.bbox, 2),
  }));

  // 6. Geometrie de rendu : positions Y recalculees pour supporter les items
  // hierarchiques (header famille + sections). Les styles (font/size/color)
  // sont preserves depuis les entries template.
  const refLabel = entries[0].labelSpan;
  const refPage = entries[0].pageSpan;
  const yFirst = refLabel.bbox[1];
  const lineH = refLabel.bbox[3] - refLabel.bbox[1];

  // yStep base : median des gaps entre entries template (capture le rythme
  // visuel d'origine). Fallback : lineH * 1.4.
  let yStepBase = lineH * 1.4;
  if (entries.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < entries.length; i++) {
      const gap = entries[i].labelSpan.bbox[1] - entries[i - 1].labelSpan.bbox[1];
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      yStepBase = gaps[Math.floor(gaps.length / 2)];
    }
  }

  // Hauteur dispo dans la zone TOC : du 1er Y au dernier Y des entries
  // template + une ligne (= ce que le template utilise visuellement).
  const lastEntryY = entries[entries.length - 1].labelSpan.bbox[1];
  const availableH = lastEntryY - yFirst + lineH;
  const MIN_STEP_RATIO = 1.10;
  const minStep = lineH * MIN_STEP_RATIO;

  // Décision yStep + descriptions. NOUVEAU comportement : si trop d'items
  // pour la zone, on PAGINE au lieu de fallback flat ou de chevaucher.
  // yStep cible : confortable (yStepBase) si possible, sinon minStep.
  const renderItems = items;
  let yStep = yStepBase;

  // Si des descriptions Claude sont fournies, on vise un yStep large
  // (label + 2 lignes desc). Si la zone est saturée, on drop les descriptions
  // (priorité à la lisibilité du sommaire).
  const hasAnyDescription = renderItems.some(
    (it) => it.kind === 'section' && it.label && !!descriptions[it.label]
  );
  const descSizeRef = refLabel.size * 0.5;
  const descLineHRef = descSizeRef * 1.35;
  const DESC_TOP_GAP = 5;
  const DESC_BOTTOM_GAP = 6;
  const minStepWithDesc = lineH + DESC_TOP_GAP + descLineHRef + DESC_BOTTOM_GAP;
  let renderDescriptions = hasAnyDescription;
  if (hasAnyDescription) {
    const DESC_LINES_TARGET = 2;
    const wantedStep = lineH + DESC_TOP_GAP + DESC_LINES_TARGET * descLineHRef + DESC_BOTTOM_GAP;
    yStep = wantedStep;
  }

  // Calcul de la capacité par page = nombre d'items qui tiennent dans la zone
  // TOC à ce yStep. Le -1 vient du fait que la 1ère row a y=yFirst (pas de
  // step) et chaque row supplémentaire ajoute yStep.
  let itemsPerPage = Math.max(1, Math.floor(availableH / yStep) + 1);

  // Si même au minStep on ne peut pas afficher renderItems sur ≤2 pages,
  // on accepte un yStep plus serré (pas en dessous de minStep absolu).
  // Au-delà, on créera autant de pages que nécessaire.
  if (renderItems.length > itemsPerPage * 3) {
    yStep = Math.max(minStep, availableH / Math.max(1, Math.floor(renderItems.length / 3)));
    itemsPerPage = Math.max(1, Math.floor(availableH / yStep) + 1);
  }
  // Si yStep est devenu insuffisant pour les descriptions → drop
  if (renderDescriptions && yStep < minStepWithDesc) {
    renderDescriptions = false;
  }

  // Chunking : split renderItems en pages de taille itemsPerPage.
  // Best-effort : on essaye de ne pas couper une famille en plein milieu —
  // si possible, on commence une nouvelle page sur un header family.
  const chunks: RenderedItem[][] = [];
  {
    let start = 0;
    while (start < renderItems.length) {
      let end = Math.min(start + itemsPerPage, renderItems.length);
      // Si on s'arrête juste après un header famille / subfamily,
      // on rembobine d'1 pour le placer sur la page suivante (sinon header
      // orphelin en bas de page sans sa première section).
      if (end < renderItems.length) {
        const last = renderItems[end - 1];
        if (last.kind === 'family' || last.kind === 'subfamily') {
          end = Math.max(start + 1, end - 1);
        }
      }
      chunks.push(renderItems.slice(start, end));
      start = end;
    }
  }

  // Constantes de style pour les items hierarchiques (3 niveaux).
  // Hiérarchie visuelle forte pour mieux distinguer les niveaux :
  //   - family : +35% taille, MAJUSCULES, sans indent, gros gap au-dessus,
  //              trait fin de séparation en dessous
  //   - subfamily : +15% taille, capitalize, indent +14pt, gap moyen au-dessus
  //   - section : taille standard, indent +26pt, page number à droite
  const FAMILY_SIZE_RATIO = 1.35;
  const SUBFAMILY_SIZE_RATIO = 1.15;
  const SUBFAMILY_INDENT_PT = 14;
  const SECTION_INDENT_PT = 26;
  // Gap supplémentaire AVANT un header (= air respirable, structure visible).
  // Multiplié par yStep pour scaler avec la densité globale.
  const FAMILY_TOP_GAP_RATIO = 0.8;
  const SUBFAMILY_TOP_GAP_RATIO = 0.35;
  // Couleur du trait sous family + couleur grisée pour sfamille (contraste
  // visuel avec sections noires).
  const FAMILY_UNDERLINE_COLOR = '#cccccc';
  const FAMILY_UNDERLINE_HEIGHT = 0.6; // pt
  const SUBFAMILY_COLOR_LIGHTEN = 0.35; // 0=noir, 1=blanc

  const hasSubFamilyHeaders = renderItems.some((it) => it.kind === 'subfamily');
  const sectionIndent = isHierarchical
    ? (hasSubFamilyHeaders ? SECTION_INDENT_PT : 14)
    : 0;
  const subFamIndent = SUBFAMILY_INDENT_PT;

  // ── Boucle externe : 1 itération = 1 page sommaire ───────────────────
  const pages: TocPage[] = [];
  let totalWritten = 0;
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const isFirstPage = chunkIdx === 0;
    // Ops cumulés pour cette page :
    // 1) Erases tpl (entries originales, titre, autres spans)
    // 2) Titre "SOMMAIRE" si 1ère page
    // 3) Items du chunk avec positions Y
    const ops: Operation[] = [
      ...eraseEntriesOps,
      ...eraseTitleOps,
      ...eraseOtherOps,
    ];
    if (isFirstPage && insertTitleOp) {
      ops.push(insertTitleOp);
    }
    let written = 0;
    // yCumulOffset : cumul des gaps supplémentaires ajoutés AVANT les headers
    // (family/subfamily) pour aérer la hiérarchie visuelle. S'accumule à
    // chaque header rencontré dans le chunk.
    let yCumulOffset = 0;
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];

      // Gap supplémentaire AVANT un header (sauf si c'est le 1er item de la
      // page = pas de gap, on commence pile à yFirst).
      // Le kind 'extra' (= "Cahier technique" et autres ajouts post-sections)
      // recoit aussi un gap pour le distinguer visuellement du dernier item
      // section produit.
      if (i > 0) {
        if (item.kind === 'family') {
          yCumulOffset += yStep * FAMILY_TOP_GAP_RATIO;
        } else if (item.kind === 'subfamily') {
          yCumulOffset += yStep * SUBFAMILY_TOP_GAP_RATIO;
        } else if (item.kind === 'extra') {
          yCumulOffset += yStep * SUBFAMILY_TOP_GAP_RATIO;
        }
      }
      const y0 = yFirst + i * yStep + yCumulOffset;
      const y1 = y0 + lineH;

    if (item.kind === 'family') {
      // Niveau 1 : taille +35%, MAJUSCULES, sans indent, sans page number.
      const famSize = refLabel.size * FAMILY_SIZE_RATIO;
      const famY1 = y0 + lineH * (famSize / refLabel.size);
      ops.push({
        op: 'insert_text',
        bbox: [refLabel.bbox[0], y0, refPage.bbox[2], famY1],
        text: item.label.toUpperCase(),
        font: refLabel.font,
        size: famSize,
        color: refLabel.color,
      });
      // Trait fin de séparation sous le header family (couleur claire gris).
      const underlineY = famY1 + 2;
      ops.push({
        op: 'erase_rect',
        bbox: [refLabel.bbox[0], underlineY, refPage.bbox[2], underlineY + FAMILY_UNDERLINE_HEIGHT],
        color: FAMILY_UNDERLINE_COLOR,
      });
      written++;
      continue;
    }

    if (item.kind === 'subfamily') {
      // Niveau 2 : taille +15%, capitalize, indent +14pt, couleur grisée.
      const subSize = refLabel.size * SUBFAMILY_SIZE_RATIO;
      const styled = item.label.charAt(0).toUpperCase() + item.label.slice(1).toLowerCase();
      const subColor = lightenHex(refLabel.color, SUBFAMILY_COLOR_LIGHTEN);
      ops.push({
        op: 'insert_text',
        bbox: [refLabel.bbox[0] + subFamIndent, y0, refPage.bbox[2], y1],
        text: styled,
        font: refLabel.font,
        size: subSize,
        color: subColor,
      });
      written++;
      continue;
    }

    // Niveau 3 (section) : indent max + page number a droite.
    ops.push({
      op: 'insert_text',
      bbox: [refLabel.bbox[0] + sectionIndent, y0, refLabel.bbox[2], y1],
      text: item.label,
      font: refLabel.font,
      size: refLabel.size,
      color: refLabel.color,
    });
    if (item.pageNumber != null) {
      ops.push({
        op: 'insert_text',
        bbox: [refPage.bbox[0], y0, refPage.bbox[2], y1],
        text: `p.${item.pageNumber}`,
        font: refPage.font,
        size: refPage.size,
        color: refPage.color,
      });
    }
    written++;

    // Description Claude sous l'entry section. Hauteur dispo = jusqu'a la
    // prochaine row (header famille ou section). Pour la derniere : extra
    // headroom jusqu'a la fin de la zone TOC.
    if (!renderDescriptions) continue;
    const desc = descriptions[item.label];
    if (!desc) continue;
    const labelBottom = y1;
    const descSize = refLabel.size * 0.5;
    const lineHeight = descSize * 1.35;
    const x0 = refLabel.bbox[0] + sectionIndent + 4;
    const x1 = Math.max(refPage.bbox[0] - 6, x0 + 50);
    const maxWidth = x1 - x0;
    const descColor = lightenHex(refLabel.color, 0.55);
    const isLastInChunk = i === chunk.length - 1;
    const nextRowTop = isLastInChunk
      ? entries[entries.length - 1].labelSpan.bbox[3] + 30
      : yFirst + (i + 1) * yStep;
    const availH = Math.max(0, nextRowTop - labelBottom - 6);
    const maxLines = Math.max(1, Math.floor(availH / lineHeight));
    const all = wrapToLines(desc, maxWidth, descSize);
    const lines = all.slice(0, maxLines);
    if (lines.length > 0 && lines.length < all.length) {
      const cleaned = trimToCompletePhrase(lines[lines.length - 1]);
      // Si le nettoyage vide la ligne (ex : 1 seul mot faible), on garde l'original.
      lines[lines.length - 1] = cleaned || lines[lines.length - 1].trimEnd();
    }
    let cy = labelBottom + 5;
    for (const line of lines) {
      ops.push({
        op: 'insert_text',
        bbox: [x0, cy, x1, cy + descSize + 1],
        text: line,
        font: refLabel.font,
        size: descSize,
        color: descColor,
      });
      cy += lineHeight;
    }
    }  // ← fin de la boucle interne sur le chunk

    pages.push({
      sourcePage: tocPage.pageNumber,
      ops,
      itemsWritten: written,
      isFirstPage,
    });
    totalWritten += written;
  }  // ← fin de la boucle externe sur chunks

  return {
    pages,
    sourcePage: tocPage.pageNumber,
    ops: pages[0]?.ops ?? [],
    entriesWritten: totalWritten,
    entriesErased: entries.length,
  };
}

/** Pour chaque span "p.XX" du template, retrouve le label aligne a gauche
 *  ET les spans de leader dots entre eux (a effacer aussi pour un rendu
 *  propre). */
function parseTocEntries(page: ExtractedPage): TocEntryTemplate[] {
  const spans = page.raw_spans ?? [];
  const pageSpans = spans.filter((s) => PAGE_NUM_RE.test(s.text.trim()));
  const entries: TocEntryTemplate[] = [];
  for (const pageSpan of pageSpans) {
    const yCenter = (pageSpan.bbox[1] + pageSpan.bbox[3]) / 2;
    const sameLineSpans = spans.filter((s) => {
      if (s === pageSpan) return false;
      const sY = (s.bbox[1] + s.bbox[3]) / 2;
      if (Math.abs(sY - yCenter) > Y_TOLERANCE_PT) return false;
      // doit etre a gauche de la page number
      if (s.bbox[0] >= pageSpan.bbox[0]) return false;
      const t = s.text.trim();
      if (t.length < 1) return false;
      return true;
    });
    if (sameLineSpans.length === 0) continue;
    // Separe labels (texte alphabetique) vs dots leader
    const isDotsOnly = (s: TextSpan) => /^[.\s]+$/.test(s.text.trim());
    const labels = sameLineSpans.filter((s) => !isDotsOnly(s) && s.text.trim().length >= 3);
    const dotsSpans = sameLineSpans.filter(isDotsOnly);
    if (labels.length === 0) continue;
    labels.sort((a, b) => a.bbox[0] - b.bbox[0]);
    entries.push({
      labelSpan: labels[0],
      pageSpan,
      dotsSpans,
    });
  }
  entries.sort((a, b) => a.labelSpan.bbox[1] - b.labelSpan.bbox[1]);
  return entries;
}

/** Construit la liste des nouvelles entries : 1 par section avec produits,
 *  triees dans l'ordre d'apparition dans le PDF final. La famille et la
 *  sous-famille sont deduites des produits de l'allocation (majoritaire). */
function buildNewEntries(
  allocations: PageAllocation[],
  pagePlans: { source_page: number; page_number: number | null }[],
): NewEntry[] {
  const sourceToFinal = new Map<number, number>();
  for (const pp of pagePlans) {
    if (pp.page_number != null && !sourceToFinal.has(pp.source_page)) {
      sourceToFinal.set(pp.source_page, pp.page_number);
    }
  }
  const seen = new Set<string>();
  const collected: { label: string; page: number; order: number; family: string; subFamily: string }[] = [];
  for (const alloc of allocations) {
    const label = (alloc.sectionLabel || '').trim();
    if (!label || seen.has(label)) continue;
    const finalPage = sourceToFinal.get(alloc.sourcePage);
    if (finalPage == null) continue;
    seen.add(label);
    // Famille + sous-famille majoritaires des produits de l'allocation
    const famCounts = new Map<string, number>();
    const subFamCounts = new Map<string, number>();
    for (const p of alloc.products) {
      const f = (p.family ?? '').trim();
      if (f) famCounts.set(f, (famCounts.get(f) ?? 0) + 1);
      const sf = (p.subFamily ?? '').trim();
      if (sf) subFamCounts.set(sf, (subFamCounts.get(sf) ?? 0) + 1);
    }
    const family = famCounts.size > 0
      ? [...famCounts.entries()].sort((x, y) => y[1] - x[1])[0][0]
      : '';
    const subFamily = subFamCounts.size > 0
      ? [...subFamCounts.entries()].sort((x, y) => y[1] - x[1])[0][0]
      : '';
    collected.push({ label, page: finalPage, order: finalPage, family, subFamily });
  }
  // Tri : grouper par famille puis sous-famille (ordre = 1ere apparition de
  // chacune), puis par numero de page au sein de chaque groupe. Evite l'effet
  // "alternance" visuel quand les pages sortent dans un ordre non-hierarchique.
  const familyFirstPage = new Map<string, number>();
  const subFamilyFirstPage = new Map<string, number>();
  for (const c of collected) {
    const fk = c.family || '';
    const sfk = `${fk}::${c.subFamily || ''}`;
    if (!familyFirstPage.has(fk)) familyFirstPage.set(fk, c.page);
    if (!subFamilyFirstPage.has(sfk)) subFamilyFirstPage.set(sfk, c.page);
  }
  collected.sort((a, b) => {
    const fa = familyFirstPage.get(a.family || '') ?? Number.MAX_SAFE_INTEGER;
    const fb = familyFirstPage.get(b.family || '') ?? Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    const sfa = subFamilyFirstPage.get(`${a.family || ''}::${a.subFamily || ''}`) ?? Number.MAX_SAFE_INTEGER;
    const sfb = subFamilyFirstPage.get(`${b.family || ''}::${b.subFamily || ''}`) ?? Number.MAX_SAFE_INTEGER;
    if (sfa !== sfb) return sfa - sfb;
    return a.page - b.page;
  });
  return collected.map((c) => ({
    label: c.label, pageNumber: c.page, family: c.family, subFamily: c.subFamily,
  }));
}

/** Regroupe les entries en items hierarchiques. Niveaux supportes :
 *  - 1 niveau  : sections seules (aucune family/sfamille fournie)
 *  - 2 niveaux : famille > sections (sfamille absente)
 *  - 3 niveaux : famille > sfamille > sections (le cas le + riche)
 *
 *  Comportement : on materialise TOUS les niveaux qui ont au moins UNE
 *  valeur fournie (meme s'ils sont mono-valeur). Permet de toujours
 *  exposer la structure du catalogue dans le sommaire, peu importe la
 *  diversite des familles. Preserve l'ordre d'apparition (pas de tri alpha). */
export function groupIntoHierarchy(entries: NewEntry[]): RenderedItem[] {
  const hasAnyFamily = entries.some((e) => !!e.family);
  const hasAnySubFamily = entries.some((e) => !!e.subFamily);

  // Aucun niveau hierarchique fourni → sections seules
  if (!hasAnyFamily && !hasAnySubFamily) {
    return entries.map((e) => ({ kind: 'section', label: e.label, pageNumber: e.pageNumber }));
  }

  const items: RenderedItem[] = [];
  let currentFamily: string | null = null;
  let currentSubFamily: string | null = null;

  for (const e of entries) {
    const fam = e.family || '';
    const subFam = e.subFamily || '';

    // Niveau 1 (family) : emettre header quand on change de famille
    if (hasAnyFamily) {
      if (fam && fam !== currentFamily) {
        items.push({ kind: 'family', label: fam });
        currentFamily = fam;
        currentSubFamily = null; // reset sfamille au changement de famille
      } else if (!fam && currentFamily !== null) {
        items.push({ kind: 'family', label: 'Autres' });
        currentFamily = null;
        currentSubFamily = null;
      }
    }

    // Niveau 2 (subfamily) : emettre header quand on change de sfamille
    if (hasAnySubFamily && subFam && subFam !== currentSubFamily) {
      items.push({ kind: 'subfamily', label: subFam });
      currentSubFamily = subFam;
    }

    // Niveau 3 (section) : toujours emis
    items.push({ kind: 'section', label: e.label, pageNumber: e.pageNumber });
  }
  return items;
}

// padBbox : voir utils/bbox.ts (factorisation audit #12).

/** Eclaircit une couleur hex en la melangeant vers le blanc. amount=0 retourne
 *  la couleur d'origine, amount=1 retourne du blanc. Utilise pour creer une
 *  variante secondaire/grisee d'une couleur primaire de texte. */
function lightenHex(hex: string, amount: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/** Mots de liaison faibles (prépositions/articles/déterminants) : une phrase
 *  tronquée ne doit pas se terminer dessus. Inclut les formes élidées (d', l'…)
 *  gérées via le split sur l'apostrophe. */
const TRUNC_WEAK_WORDS = new Set([
  'a', 'à', 'de', 'du', 'des', 'en', 'et', 'ou', 'le', 'la', 'les', 'un', 'une',
  'au', 'aux', 'par', 'pour', 'sur', 'sous', 'avec', 'dans', 'que', 'qui', 'dont',
  'son', 'sa', 'ses', 'leur', 'leurs', 'ce', 'ces', 'cet', 'cette', 'mon', 'ma',
  'mes', 'notre', 'nos', 'votre', 'vos', 'd', 'l', 'qu', 'n', 's', 'm', 't', 'j', 'c',
]);

/** Nettoie la fin d'une phrase TRONQUÉE pour qu'elle ne se termine pas sur un
 *  fragment suspendu (ponctuation, mot de liaison, élision "d'une"/"l'…"). Retire
 *  itérativement ponctuation + mots faibles finaux, puis pose un point.
 *  Ex : "Une barre de douche en Inox, d'une" → "Une barre de douche en Inox." */
export function trimToCompletePhrase(line: string): string {
  let t = (line ?? '').trimEnd();
  // 1. Parenthèse/guillemet ouvert mais non fermé → on coupe le fragment incomplet
  //    (ex : "…en Inox (dont" → "…en Inox").
  if ((t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length) {
    const idx = t.lastIndexOf('(');
    if (idx >= 0) t = t.slice(0, idx).trimEnd();
  }
  // 2. Drop d'une CLAUSE de mesure incomplète en fin (lead-in coupé avant sa
  //    valeur) : "…, longueurs 60-70 cm, Ø" → "…, longueurs 60-70 cm" ;
  //    "…, longueurs" → on retire la clause. Une clause = segment après la
  //    dernière virgule. On ne droppe QUE si elle n'a pas de chiffre ET est soit
  //    un symbole/lead-in de mesure, soit très courte (≤2 mots significatifs).
  const MEASURE_LEAD = /\b(ø|diam[eè]tre|longueur|largeur|hauteur|profondeur|d[ée]bit|puissance|garantie|capacit)/i;
  for (let guard = 0; guard < 4; guard++) {
    const ci = t.lastIndexOf(',');
    if (ci < 0) break;
    const clause = t.slice(ci + 1).trim().replace(/[.…\s]+$/u, '');
    if (!clause) { t = t.slice(0, ci).trimEnd(); continue; }
    const hasDigit = /\d/.test(clause);
    const isMeasureLead = MEASURE_LEAD.test(clause) && !hasDigit;
    const isShortSymbol = !hasDigit && clause.replace(/[^\p{L}\p{N}]/gu, '').length <= 2;
    if (isMeasureLead || isShortSymbol) {
      t = t.slice(0, ci).trimEnd();
    } else break;
  }
  // 3. Retire en boucle : ponctuation/ouvrants finaux + mots de liaison + élisions.
  const TAIL_PUNCT = /[\s,;:.…–—\-(«»"'’]+$/u;
  let prev = '';
  while (t !== prev && t.length > 0) {
    prev = t;
    t = t.replace(TAIL_PUNCT, '');
    const m = t.match(/(\S+)$/u);
    if (!m) break;
    const token = m[1];
    // Mot nettoyé de sa ponctuation collée (ex : "(dont" → "dont").
    const cleanTok = token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}'’]+$/u, '');
    // Élision : "d'une" → segment après la dernière apostrophe ("une").
    const segs = cleanTok.replace(/[’']/g, "'").toLowerCase().split("'");
    const lastSeg = segs[segs.length - 1];
    const isWeak = cleanTok === '' || TRUNC_WEAK_WORDS.has(lastSeg);
    if (!isWeak) break;
    t = t.slice(0, t.length - token.length).trimEnd();
  }
  t = t.replace(TAIL_PUNCT, '');
  if (t.length > 0 && !/[.!?]$/.test(t)) t += '.';
  return t;
}

/** Wrap simple par mots avec estimation de largeur. Pas precis au pixel mais
 *  evite les debords pour les polices proportionnelles standard. */
function wrapToLines(text: string, maxWidth: number, fontSize: number): string[] {
  // Coef largeur moyenne char Almanach Regular ~0.5 * fontSize (texte courant
  // mixte casse). On marge a 0.55 pour eviter les debords sur lignes denses.
  const avgCharWidth = fontSize * 0.55;
  const charsPerLine = Math.max(20, Math.floor(maxWidth / avgCharWidth));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    // Mot trop long pour une ligne entiere → coupe forcee
    if (w.length > charsPerLine) {
      if (current.length > 0) lines.push(current);
      for (let i = 0; i < w.length; i += charsPerLine) {
        lines.push(w.slice(i, i + charsPerLine));
      }
      current = '';
      continue;
    }
    const candidate = current.length === 0 ? w : current + ' ' + w;
    if (candidate.length <= charsPerLine) {
      current = candidate;
    } else {
      if (current.length > 0) lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
