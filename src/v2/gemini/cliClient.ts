/**
 * Wrapper around the Gemini CLI (`@google/gemini-cli`) for the V2 pipeline.
 *
 * WHY a CLI in addition to the REST API (client.ts):
 *  - The free-tier API blocks gemini-2.5-pro (limit:0) and imposes tight
 *    rate limits (20 RPM flash).
 *  - The CLI authenticates via OAuth "Login with Google" (Gemini Code Assist),
 *    which leverages the user's Gemini Pro SUBSCRIPTION: Pro access + much
 *    wider quotas, without a paid API key.
 *
 * AUTH: the CLI reads auth via env GOOGLE_GENAI_USE_GCA=true (Google Code
 * Assist = personal OAuth). The token is persisted in ~/.gemini/ after an
 * initial interactive `gemini` run (browser login, just once).
 *
 * MODE: -p/--prompt = headless non-interactive. -o json = structured output.
 * We pass --approval-mode yolo because our prompts request no file action
 * (pure text generation), so there is nothing to approve.
 *
 * Contract: returns a GenerateTextResult identical to client.ts for a
 * drop-in swap in the provider router (providerRouter.ts).
 */

import { runBinary } from '../binaryRunner';
import type { GenerateTextResult } from './client';

export interface GeminiCliOptions {
  prompt: string;
  /** Model. Default gemini-2.5-pro (available via OAuth subscription). */
  model?: string;
  /** Timeout ms. Default 120s (the CLI has a cold start + thinking). */
  timeoutMs?: number;
  /** Binary path/name. Default env GEMINI_BIN or 'gemini'. */
  geminiBin?: string;
  /** Process cwd (isolates the CLI's project context). Default /tmp. */
  workDir?: string;
  /** Caller label for stats. */
  module?: string;
}

export const GEMINI_CLI_MODELS = {
  pro: 'gemini-2.5-pro',
  flash: 'gemini-2.5-flash',
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Detects whether the Gemini CLI is usable: binary present + persisted OAuth
 * auth. Best-effort (just checks for the token's presence).
 */
export async function isGeminiCliAvailable(geminiBin?: string): Promise<boolean> {
  const { promises: fs } = await import('fs');
  const os = await import('os');
  const path = await import('path');
  // GCA OAuth token persisted after interactive login.
  const candidates = [
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    path.join(os.homedir(), '.gemini', 'google_accounts.json'),
  ];
  for (const p of candidates) {
    try {
      const st = await fs.stat(p);
      if (st.size > 0) return true;
    } catch { /* continue */ }
  }
  return false;
}

/**
 * Runs the Gemini CLI on a prompt. Returns a GenerateTextResult.
 *
 * The prompt is passed via argv (-p). spawn handles quoting (array argv), so
 * there is no escaping issue even with JSON inside the prompt.
 */
export async function callGeminiCli(opts: GeminiCliOptions): Promise<GenerateTextResult> {
  const bin = opts.geminiBin ?? process.env.GEMINI_BIN ?? 'gemini';
  const model = opts.model ?? GEMINI_CLI_MODELS.pro;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const { recordCall } = await import('./stats');
  const moduleLabel = opts.module ?? 'cli';

  const raw = await runBinary({
    bin,
    args: ['-o', 'json', '-m', model, '--approval-mode', 'yolo', '-p', opts.prompt],
    env: {
      // Personal OAuth (Gemini Code Assist) = leverages the Pro subscription.
      GOOGLE_GENAI_USE_GCA: 'true',
      // Without this the CLI refuses to run headless outside a "trusted folder"
      // (it waits for an interactive confirmation, impossible in a pipeline).
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    },
    cwd: opts.workDir ?? '/tmp',
    timeoutMs,
  });

  if (raw.timedOut) {
    recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'retry_exhausted', durationMs: raw.durationMs });
    return { ok: false, error: `gemini CLI timeout (${timeoutMs}ms)` };
  }
  if (!raw.stdout || raw.stdout.trim().length === 0) {
    recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'error', durationMs: raw.durationMs });
    const errSnippet = raw.stderr?.slice(0, 300) || `exit ${raw.exitCode ?? '?'}`;
    return { ok: false, error: `gemini CLI sans output : ${errSnippet}` };
  }

  const text = extractCliText(raw.stdout);
  if (text === null) {
    recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'error', durationMs: raw.durationMs });
    return { ok: false, error: `gemini CLI output non parseable : ${raw.stdout.slice(0, 200)}` };
  }

  recordCall({ module: moduleLabel, model: `cli:${model}`, status: 'ok', durationMs: Date.now() - t0 });
  return { ok: true, text };
}

export interface GeminiCliVisionOptions {
  prompt: string;
  /** ABSOLUTE paths of the images (PNG) to analyze. Passed to the CLI via @path. */
  imagePaths: string[];
  /** Default gemini-2.5-pro (deep Vision reasoning, available via subscription). */
  model?: string;
  /** Timeout ms. Default 180s (multi-image Pro Vision = slow). */
  timeoutMs?: number;
  geminiBin?: string;
  workDir?: string;
  module?: string;
}

/**
 * Multi-image Vision analysis via the Gemini CLI (Pro). The images are
 * referenced by @path in the prompt (the CLI reads them from disk).
 * Reuses callGeminiCli: same OAuth auth, same parsing.
 *
 * Use case: cross-page coherence audit (role H) where Pro brings real
 * reasoning vs flash. The free-tier API blocks Pro (limit:0), the CLI
 * unblocks it via the subscription.
 */
export async function callGeminiCliVision(opts: GeminiCliVisionOptions): Promise<GenerateTextResult> {
  if (opts.imagePaths.length === 0) {
    return { ok: false, error: 'callGeminiCliVision : aucune image' };
  }
  const refs = opts.imagePaths.map((p) => `@${p}`).join(' ');
  return callGeminiCli({
    prompt: `${refs}\n\n${opts.prompt}`,
    model: opts.model ?? GEMINI_CLI_MODELS.pro,
    timeoutMs: opts.timeoutMs ?? 180_000,
    geminiBin: opts.geminiBin,
    workDir: opts.workDir,
    module: opts.module ?? 'cliVision',
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts the response text from the CLI stdout. The gemini CLI's -o json
 * format wraps the response; we try several known keys, then fall back to raw
 * text. Returns null if there is truly nothing usable.
 *
 * Exported for unit testing.
 */
export function extractCliText(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // 1. Try structured JSON
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    // Known gemini CLI keys depending on version: response / result / text /
    // content. We take the first non-empty string.
    for (const key of ['response', 'result', 'text', 'content', 'output']) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    // Sometimes nested { stats, response }, or a direct message.
    if (typeof parsed.message === 'string') return parsed.message.trim();
  } catch {
    // not JSON: it's probably raw text (output-format text)
    return trimmed;
  }
  // JSON parsed OK but no known text key → return the raw JSON
  // (the caller will parse it with parseGeminiJson if needed).
  return trimmed;
}
