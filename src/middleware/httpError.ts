/**
 * Error-response helpers that avoid leaking internal detail in production.
 *
 * In development (`NODE_ENV !== 'production'`) responses keep the verbose
 * `detail` and any extra debug fields. In production they collapse to a
 * generic, caller-safe message so internal paths / stack traces / orchestrator
 * errors never reach the client.
 */

export function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Build a JSON error body. `userMessage` is always returned. `detail` and
 * `debug` extras are included only outside production.
 */
export function errorBody(
  userMessage: string,
  opts?: { detail?: string; debug?: Record<string, unknown> },
): Record<string, unknown> {
  const body: Record<string, unknown> = { error: userMessage };
  if (!isProd()) {
    if (opts?.detail) body.detail = opts.detail;
    if (opts?.debug) Object.assign(body, opts.debug);
  }
  return body;
}

/**
 * Compose a user-facing message that embeds the raw error only outside prod.
 * e.g. failMessage('Echec extraction', err) →
 *   dev : "Echec extraction : <message>"
 *   prod: "Echec extraction."
 */
export function failMessage(prefix: string, err: unknown): string {
  if (isProd()) return `${prefix}.`;
  const msg = err instanceof Error ? err.message : String(err);
  return `${prefix} : ${msg}`;
}
