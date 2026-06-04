/**
 * Constantes de timeout partagees pour les binaires externes lances par
 * le pipeline. Centralise les valeurs pour eviter la duplication et
 * faciliter le tuning (ex: ralentissement local sur gros PDFs).
 */

/** Extracteur PDFium : ouvre + parse + ecrit 1 JSON par page. Sur Catalogue A 188p
 *  ~700ms. 120s = marge x150 pour les gros catalogues / disques lents. */
export const EXTRACT_TIMEOUT_MS = 120_000;

/** Rendering PDFium : applique le plan + sauvegarde. Sur Catalogue A ~250ms. 180s
 *  marge pour les plans avec beaucoup d'ops (substitutions massives). */
export const RENDER_TIMEOUT_MS = 180_000;

/** Claude CLI (audit + plan generation) : ~30-90s typique. 180s = limite
 *  raisonnable avant kill ; au-dela c'est un hang. */
export const CLAUDE_CLI_TIMEOUT_MS = 180_000;
