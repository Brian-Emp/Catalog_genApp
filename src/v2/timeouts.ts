/**
 * Shared timeout constants for the external binaries launched by the
 * pipeline. Centralizes the values to avoid duplication and to make
 * tuning easier (e.g. local slowdown on large PDFs).
 */

/** PDFium extractor: opens + parses + writes 1 JSON per page. On Catalogue A 188p
 *  ~700ms. 120s = x150 margin for large catalogs / slow disks. */
export const EXTRACT_TIMEOUT_MS = 120_000;

/** PDFium rendering: applies the plan + saves. On Catalogue A ~250ms. 180s
 *  margin for plans with many ops (massive substitutions). */
export const RENDER_TIMEOUT_MS = 180_000;

/** Claude CLI (audit + plan generation): ~30-90s typical. 180s = reasonable
 *  limit before kill; beyond that it's a hang. */
export const CLAUDE_CLI_TIMEOUT_MS = 180_000;
