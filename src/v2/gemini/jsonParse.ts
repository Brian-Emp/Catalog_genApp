/**
 * Tolerant JSON parser for Gemini responses.
 *
 * Gemini often returns:
 *  - ```json {...} ``` (markdown fence)
 *  - prose before + {...} + prose after
 *  - just {...} (ideal case)
 *
 * This parser:
 *  1. Strips the markdown fences
 *  2. Tries a direct JSON.parse
 *  3. On failure: extracts the first balanced {...} and retries
 *  4. Returns null if everything fails
 *
 * Centralized to avoid duplicating 5+ parsers across the modules.
 */

/**
 * Parses a Gemini text response into a JSON object. Returns null if not parseable.
 */
export function parseGeminiJson<T = unknown>(text: string): T | null {
  if (!text || typeof text !== 'string') return null;
  const stripped = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Fallback: extract the first balanced {...} or [...]
    const objMatch = stripped.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]) as T; } catch { /* fall */ }
    }
    const arrMatch = stripped.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]) as T; } catch { /* fall */ }
    }
    return null;
  }
}
