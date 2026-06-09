/**
 * Shared constants for the `insert_text` op. The C++ render
 * (applyOpInsertTextInsert) adds an offset to the baseline computed
 * from bbox[3] (y_bottom top-left). On the TS side, the caller must
 * compensate for this offset if it wants an EXACT baseline (page_number
 * renum case: we want the new glyph at the same y_pdfium as the old span).
 *
 * If you change this value, ALSO change `kBaselineOffsetPt` in
 * `pdf-engine/src/render.cpp` (applyOpInsertTextInsert). The two MUST
 * be identical.
 */
export const INSERT_TEXT_BASELINE_OFFSET_PT = 2;
