/**
 * Types TypeScript V2 — miroirs des schemas JSON dans src/v2/schemas/.
 *
 * Convention : chaque interface ici doit etre alignee avec le schema JSON
 * correspondant. Si tu modifies l'un, modifie l'autre.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sous-types reutilises
// ─────────────────────────────────────────────────────────────────────────────

/** Rectangle [x0, y0, x1, y1] en points PDF, origine top-left. */
export type Bbox = [number, number, number, number];

/** Couleur RGB hexa "#rrggbb". TS ne sait pas valider la regex au type level,
 *  donc on alias juste sur string ; la validation runtime se fait au parsing. */
export type ColorHex = string;

/** Fragment de texte avec position et style. */
export interface TextSpan {
  text: string;
  bbox: Bbox;
  font: string;
  size: number;
  color: ColorHex;
}

// ─────────────────────────────────────────────────────────────────────────────
// ExtractedPage — output de l'extracteur C++ (cf extracted-page.schema.json)
// ─────────────────────────────────────────────────────────────────────────────

/** Liste exhaustive des types de slot. `as const` = TS garde les litteraux. */
export const SLOT_TYPES = [
  'section_banner',
  'section_ribbon',
  'product_slot',
  'toc_entry',
  'toc_title',
  'page_number',
  'running_header',
  'decoration',
  'keep_page_raw',
] as const;

export type SlotType = typeof SLOT_TYPES[number];

interface SlotBase {
  type: SlotType;
  id: string;
  bbox: Bbox;
}

export interface SlotSectionBanner extends SlotBase {
  type: 'section_banner';
  label: TextSpan;
  background?: ColorHex;
}

export interface SlotSectionRibbon extends SlotBase {
  type: 'section_ribbon';
  label: TextSpan;
  rotation?: 0 | 90 | 180 | 270;
  background?: ColorHex;
}

export interface ProductSpec {
  key: TextSpan;
  values: TextSpan[];
}

export interface ProductVariant {
  bbox: Bbox;
  color: ColorHex;
  label: TextSpan | null;
}

export interface SlotProduct extends SlotBase {
  type: 'product_slot';
  name: TextSpan;
  ref: TextSpan | null;
  color: TextSpan | null;
  image: { bbox: Bbox };
  specs: ProductSpec[];
  variants: ProductVariant[];
}

export interface SlotTocEntry extends SlotBase {
  type: 'toc_entry';
  label: TextSpan;
  page_number_text: TextSpan;
}

export interface SlotTocTitle extends SlotBase {
  type: 'toc_title';
  label: TextSpan;
}

export interface SlotPageNumber extends SlotBase {
  type: 'page_number';
  label: TextSpan;
  current_number?: number;
}

export interface SlotRunningHeader extends SlotBase {
  type: 'running_header';
  label: TextSpan;
}

export interface SlotDecoration extends SlotBase {
  type: 'decoration';
  kind: 'image' | 'vector';
}

export interface SlotKeepPageRaw extends SlotBase {
  type: 'keep_page_raw';
  reason?: string;
}

/** Discriminated union sur `type`. TS narrow automatiquement selon la valeur. */
export type Slot =
  | SlotSectionBanner
  | SlotSectionRibbon
  | SlotProduct
  | SlotTocEntry
  | SlotTocTitle
  | SlotPageNumber
  | SlotRunningHeader
  | SlotDecoration
  | SlotKeepPageRaw;

export interface ExtractedPage {
  page_number: number;
  page_size: { width: number; height: number };
  slots: Slot[];
  /** Tous les spans texte de la page, sans inference de type. Source de
   *  verite pour le pipeline V2 qui porte la logique V1 (auto_detect_template,
   *  find_product_blocks). Optionnel pour retro-compat avec extracts 0.1.x. */
  raw_spans?: TextSpan[];
  /** Bbox de toutes les images bitmap (variantes couleur + image principale). */
  raw_images?: Bbox[];
  /** Paths colores (non blanc/transparent) avec leur fillColor. Permet
   *  de retrouver la teinte d'un cartouche section_banner pour substituer
   *  le texte en preservant le fond template. */
  raw_paths?: { bbox: Bbox; fill_color: ColorHex }[];
  extractor_version?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan — output de Claude (cf plan.schema.json)
// ─────────────────────────────────────────────────────────────────────────────

export const OPERATION_TYPES = [
  'set_text',
  'insert_text',
  'fill_product_slot',
  'erase_rect',
  'remove_paths_in_bbox',
  'remove_text_in_bbox',
  'draw_circle',
  'draw_image',
] as const;

export type OperationType = typeof OPERATION_TYPES[number];

export interface OpSetText {
  op: 'set_text';
  slot_id: string;
  text: string;
}

/**
 * Insertion de texte autonome (sans dependance a un slot pre-extrait).
 * Utilise par le pipeline V2 engine (substitutor) qui detecte ses propres
 * blocs en TS depuis raw_spans. Le caller fournit bbox + style complet.
 *
 * Note : la bbox sert a positionner l'origine du texte. L'effacement de la
 * zone doit etre fait via un erase_rect separe avant l'insert (PASS 1 / 2).
 */
export interface OpInsertText {
  op: 'insert_text';
  bbox: Bbox;
  text: string;
  font: string;
  size: number;
  color: ColorHex;
  /** Skip l'auto-erase blanc PASS 1. Utile quand le caller veut juste
   *  reecrire un glyphe au-dessus de l'ancien (renum pages sur fond
   *  photo) sans laisser de tache blanche. */
  no_erase?: boolean;
  /** Rotation en degres (90 = vertical bottom-to-top, 270 = top-to-bottom).
   *  Defaut 0 = horizontal. Utilise pour les rubans verticaux. */
  rotation?: number;
}

export interface PlanProductSpec {
  key: string;
  values: string[];
}

export interface PlanProductVariant {
  color: ColorHex;
  label: string | null;
}

export interface PlanProduct {
  name: string;
  ref: string | null;
  color: string | null;
  image_path: string | null;
  specs: PlanProductSpec[];
  variants: PlanProductVariant[];
  /** Section/sous-sous-famille = niveau le + profond (Libellé SSFamille du
   *  XLSX, ex "BARRES DE DOUCHES"). Sert au banner section + tri allocator. */
  section?: string | null;
  /** Grande famille (Libellé Famille du XLSX, ex "SANITAIRE"). Sert a substituer
   *  le ruban vertical du template (ex "salle de bains" → "SANITAIRE"). Si
   *  absente, le ruban n'est pas substitue. */
  family?: string | null;
  /** Sous-famille = niveau intermédiaire entre family et section (Libellé
   *  SFamille du XLSX, ex "Robinetterie"). Sert au sommaire 3 niveaux : si
   *  fournie, la hierarchie devient family > subFamily > section. */
  subFamily?: string | null;
  /** Chemin absolu vers le PDF schéma technique du produit (asset *_SC.pdf
   *  matché par productsAdapter). Si présent, le pipeline ajoute le schéma
   *  dans la grille "cahier technique" en fin de PDF. */
  schema_path?: string | null;
}

export interface OpFillProductSlot {
  op: 'fill_product_slot';
  slot_id: string;
  product: PlanProduct;
}

export interface OpEraseRect {
  op: 'erase_rect';
  bbox: Bbox;
  /** Couleur de remplissage. Default = blanc "#ffffff". Sert a peindre la
   *  zone d'un cartouche section_banner avec la teinte template originale
   *  (orange / vert / etc.) au lieu de l'effacer en blanc. */
  color?: ColorHex;
  /** Si true, le moteur echantillonne la couleur du fond local (bande juste
   *  au-dessus du rect) et efface avec cette teinte au lieu du blanc. Pour les
   *  numeros de page sur fond photo CLAIR : evite un bloc blanc visible. */
  sample_bg?: boolean;
}

/** Supprime physiquement les paths vectoriels du template dont la bbox
 *  est entierement contenue dans cette zone, ET d'aire < max_area. Utile
 *  quand un erase_rect blanc ne suffit pas car PDFium dessine certains
 *  paths par-dessus. */
export interface OpRemovePathsInBbox {
  op: 'remove_paths_in_bbox';
  bbox: Bbox;
  /** Surface max (pt²) en deca de laquelle un path est candidat a la
   *  suppression. Defaut cote render.cpp : 1500. Empeche de supprimer
   *  les cartouches/rubans structurels (typiquement > 1500 pt²). */
  max_area?: number;
}

/** Supprime physiquement les TEXT objects du template dont la bbox est
 *  entierement dans cette zone. Utile pour effacer un numero de page sur
 *  fond photo sans laisser de tache (un erase_rect blanc serait visible). */
export interface OpRemoveTextInBbox {
  op: 'remove_text_in_bbox';
  bbox: Bbox;
}

export interface OpDrawCircle {
  op: 'draw_circle';
  center: [number, number];
  radius: number;
  color: ColorHex;
}

export interface OpDrawImage {
  op: 'draw_image';
  bbox: Bbox;
  image_path: string;
  fit?: 'contain' | 'cover' | 'stretch';
}

export type Operation =
  | OpSetText
  | OpInsertText
  | OpFillProductSlot
  | OpEraseRect
  | OpRemovePathsInBbox
  | OpRemoveTextInBbox
  | OpDrawCircle
  | OpDrawImage;

export type PageRender =
  | { mode: 'keep_raw' }
  | { mode: 'operations'; operations: Operation[] };

export interface PagePlan {
  source_page: number;
  page_number: number | null;
  render: PageRender;
}

export interface PlanStats {
  products_used?: number;
  products_remaining?: number;
  pages_kept?: number;
  pages_deleted?: number;
}

export interface Plan {
  version: '1';
  template_pdf_hash?: string;
  pages: PagePlan[];
  warnings?: string[];
  stats?: PlanStats;
}
