/**
 * Constantes partagees pour l'op `insert_text`. Le render C++
 * (applyOpInsertTextInsert) ajoute un offset a la baseline calculee
 * depuis bbox[3] (y_bottom top-left). Cote TS, le caller doit compenser
 * cet offset s'il veut une baseline EXACTE (cas renum page_number :
 * on veut le nouveau glyphe a la meme y_pdfium que l'ancien span).
 *
 * Si tu modifies cette valeur, change AUSSI `kBaselineOffsetPt` dans
 * `pdf-engine/src/render.cpp` (applyOpInsertTextInsert). Les deux DOIVENT
 * etre identiques.
 */
export const INSERT_TEXT_BASELINE_OFFSET_PT = 2;
