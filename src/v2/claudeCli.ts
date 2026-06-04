/**
 * Wrapper du CLI Claude pour le pipeline V2.
 *
 * On invoque `claude --print --output-format json --model sonnet --allowedTools "Edit,Skill"`
 * via spawn. Le CLI lit le prompt sur stdin (plus simple que de passer en argv,
 * pas de probleme de quoting/escaping/longueur).
 *
 * --output-format json : la CLI repond un objet JSON structure :
 *   { result, session_id, total_cost_usd, duration_ms, ... }
 * On parse pour avoir des stats utilisables.
 */

import { runBinary, type RunBinaryResult } from './binaryRunner';
import { CLAUDE_CLI_TIMEOUT_MS } from './timeouts';

export interface ClaudeCliOptions {
  prompt: string;
  /** Repertoire de travail Claude. Le CLI charge .claude/skills/ depuis cwd
   *  ET depuis les --add-dir. workDir doit contenir les inputs (templates,
   *  products.json) que le Skill va lire/editer. */
  workDir: string;
  /** Repertoire racine du projet (pour exposer .claude/skills/ a la CLI). */
  projectDir: string;
  /** Liste de dossiers supplementaires a exposer (--add-dir). */
  additionalDirs?: string[];
  /** Modele : alias ('sonnet','haiku','opus') OU version pinee
   *  (ex 'claude-sonnet-4-5-20250929'). Les alias suivent la derniere
   *  version stable et peuvent changer sans preavis ; piner garantit la
   *  reproductibilite (utile pour les tests de regression). */
  model?: string;
  /** Outils autorises. Par defaut : Edit + Skill (Lot 5). */
  allowedTools?: string;
  /** Timeout en ms. Defaut : 180_000 (3 min). */
  timeoutMs?: number;
  /** Path vers le binaire claude (defaut : 'claude' dans PATH). */
  claudeBin?: string;
}

export interface ClaudeCliResult {
  ok: boolean;
  /** Texte / JSON de la reponse Claude (champ "result" du output JSON CLI). */
  result: string;
  /** Cout en USD si fourni par la CLI. */
  costUsd?: number;
  /** Duree mesuree par la CLI Claude (peut differer de durationMs binaire). */
  cliDurationMs?: number;
  /** Resultat brut du runBinary (pour debug). */
  raw: RunBinaryResult;
}

/**
 * Lance la CLI Claude sur un prompt donne.
 */
export async function callClaudeCli(opts: ClaudeCliOptions): Promise<ClaudeCliResult> {
  const claudeBin = opts.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude';
  // Sonnet : haiku ne respecte pas le format JSON strict de plan.json (validation
  // echoue trop souvent). Sonnet est plus lent par appel mais grace au parallel
  // section (CONCURRENCY=3 dans sectionPlanner) le total reste raisonnable.
  const model = opts.model ?? 'sonnet';
  // "Skill" n'est pas un nom de tool standard Claude Code (les tools valides sont
  // Read, Write, Edit, Bash, Glob, Grep, LS, Task, mcp__*...). Il est ignore
  // silencieusement. On n'expose que Edit : Claude lit les pages via le prompt
  // et ecrit plan.json via Edit. Le skill catalog-generator est auto-decouvert
  // depuis .claude/skills/ via CLAUDE.md discovery (cwd = projectDir, non-bare).
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

  // raw.ok=false ne signifie pas que stdout est vide : la CLI Claude exit
  // avec code 1 sur 401 / auth fail tout en emettant un JSON valide avec
  // is_error:true. On parse stdout dans tous les cas pour extraire le
  // message d'erreur reel. Si parse echoue → fallback raw stdout/stderr.
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

// ─── Parse output (extrait pour testabilite + lisibilite) ────────────────────

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

  // La CLI Claude peut sortir avec exit 0 mais signaler un echec interne via
  // is_error:true (ex : context window depasse, outil echoue, auth expirée).
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
