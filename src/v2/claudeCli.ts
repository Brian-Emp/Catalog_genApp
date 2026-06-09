/**
 * Wrapper around the Claude CLI for the V2 pipeline.
 *
 * We invoke `claude --print --output-format json --model sonnet --allowedTools "Edit,Skill"`
 * via spawn. The CLI reads the prompt from stdin (simpler than passing it on
 * argv, no quoting/escaping/length issue).
 *
 * --output-format json: the CLI returns a structured JSON object:
 *   { result, session_id, total_cost_usd, duration_ms, ... }
 * We parse it to get usable stats.
 */

import { runBinary, type RunBinaryResult } from './binaryRunner';
import { CLAUDE_CLI_TIMEOUT_MS } from './timeouts';

export interface ClaudeCliOptions {
  prompt: string;
  /** Claude working directory. The CLI loads .claude/skills/ from cwd
   *  AND from the --add-dir entries. workDir must contain the inputs
   *  (templates, products.json) that the Skill will read/edit. */
  workDir: string;
  /** Project root directory (to expose .claude/skills/ to the CLI). */
  projectDir: string;
  /** List of additional folders to expose (--add-dir). */
  additionalDirs?: string[];
  /** Model: alias ('sonnet','haiku','opus') OR a pinned version
   *  (e.g. 'claude-sonnet-4-5-20250929'). Aliases track the latest stable
   *  version and can change without notice; pinning guarantees
   *  reproducibility (useful for regression tests). */
  model?: string;
  /** Allowed tools. By default: Edit + Skill (Lot 5). */
  allowedTools?: string;
  /** Timeout in ms. Default: 180_000 (3 min). */
  timeoutMs?: number;
  /** Path to the claude binary (default: 'claude' in PATH). */
  claudeBin?: string;
}

export interface ClaudeCliResult {
  ok: boolean;
  /** Text / JSON of the Claude response (the "result" field of the CLI JSON output). */
  result: string;
  /** Cost in USD if provided by the CLI. */
  costUsd?: number;
  /** Duration measured by the Claude CLI (may differ from the binary durationMs). */
  cliDurationMs?: number;
  /** Raw runBinary result (for debugging). */
  raw: RunBinaryResult;
}

/**
 * Runs the Claude CLI on a given prompt.
 */
export async function callClaudeCli(opts: ClaudeCliOptions): Promise<ClaudeCliResult> {
  const claudeBin = opts.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude';
  // Sonnet: haiku does not respect the strict JSON format of plan.json
  // (validation fails too often). Sonnet is slower per call but thanks to the
  // parallel section (CONCURRENCY=3 in sectionPlanner) the total stays reasonable.
  const model = opts.model ?? 'sonnet';
  // "Skill" is not a standard Claude Code tool name (the valid tools are
  // Read, Write, Edit, Bash, Glob, Grep, LS, Task, mcp__*...). It is ignored
  // silently. We only expose Edit: Claude reads the pages via the prompt
  // and writes plan.json via Edit. The catalog-generator skill is auto-discovered
  // from .claude/skills/ via CLAUDE.md discovery (cwd = projectDir, non-bare).
  const allowedTools = opts.allowedTools ?? 'Edit';
  const timeoutMs = opts.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;

  const args: string[] = [
    '--print',
    '--output-format', 'json',
    '--model', model,
    '--allowedTools', allowedTools,
    '--add-dir', opts.workDir,
  ];
  for (const dir of opts.additionalDirs ?? []) {
    args.push('--add-dir', dir);
  }

  const raw = await runBinary({
    bin: claudeBin,
    args,
    cwd: opts.projectDir,
    timeoutMs,
    stdin: opts.prompt,
  });

  // raw.ok=false does not mean stdout is empty: the Claude CLI exits
  // with code 1 on 401 / auth fail while still emitting valid JSON with
  // is_error:true. We parse stdout in all cases to extract the real
  // error message. If parsing fails → fall back to raw stdout/stderr.
  if (raw.stdout && raw.stdout.trim().length > 0) {
    return parseClaudeCliOutput(raw);
  }
  if (!raw.ok) {
    return {
      ok: false,
      result: raw.stderr?.slice(0, 500) || `claude exit ${raw.exitCode ?? '?'} (no output)`,
      raw,
    };
  }
  return parseClaudeCliOutput(raw);
}

// ─── Parse output (extracted for testability + readability) ──────────────────

interface ClaudeCliJsonOutput {
  is_error?: boolean;
  result?: unknown;
  subtype?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function parseClaudeCliOutput(raw: RunBinaryResult): ClaudeCliResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.stdout);
  } catch {
    return { ok: false, result: raw.stdout, raw };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, result: raw.stdout, raw };
  }
  const obj = parsed as ClaudeCliJsonOutput;

  // The Claude CLI may exit with code 0 but signal an internal failure via
  // is_error:true (e.g. context window exceeded, tool failed, auth expired).
  if (obj.is_error === true) {
    const errMsg = typeof obj.result === 'string'
      ? obj.result
      : `claude is_error=true (subtype: ${String(obj.subtype ?? 'unknown')})`;
    return { ok: false, result: errMsg, raw };
  }

  return {
    ok: true,
    result: typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result ?? ''),
    costUsd: asNumber(obj.total_cost_usd),
    cliDurationMs: asNumber(obj.duration_ms),
    raw,
  };
}
