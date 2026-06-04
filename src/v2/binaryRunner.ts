/**
 * Helper generique pour spawner un binaire et capturer son output.
 * Utilise pour catgen-pdf (extract / render) et claude CLI.
 *
 * Capture stdout + stderr (limites en taille pour eviter de saturer la RAM
 * si le binaire deverse des Mo de logs), gere timeout (SIGKILL si depassement),
 * retourne un objet structure plutot que de jeter des exceptions.
 */

import { spawn, type SpawnOptions } from 'child_process';
import { createWriteStream, type WriteStream } from 'fs';

export interface RunBinaryOptions {
  /** Chemin absolu ou nom du binaire dans le PATH. */
  bin: string;
  /** Arguments. Pas de quoting necessaire (spawn passe en argv array). */
  args: string[];
  /** Working directory (defaut : process.cwd()). */
  cwd?: string;
  /** Timeout en ms ; au-dela, SIGKILL. Defaut : 60_000 (60s). */
  timeoutMs?: number;
  /** Variables d'env additionnelles (mergees avec process.env). */
  env?: Record<string, string>;
  /** Texte a ecrire sur stdin du process (option). */
  stdin?: string;
  /** Plafond de stockage stdout / stderr en octets (chacun). Defaut 1 MB. */
  maxBufferBytes?: number;
  /** Fichier ou mirrorer stderr (complet, non capé) en parallele du buffer
   *  in-memory. Utile pour le debug post-mortem quand stderrTruncated=true. */
  stderrLogPath?: string;
}

export interface RunBinaryResult {
  ok: boolean;
  exitCode: number | null;
  /** True si le process a ete tue parce que le timeout a expire. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** True si stdout a depasse le maxBuffer (output tronque). */
  stdoutTruncated: boolean;
  /** True si stderr a depasse le maxBuffer (errors potentiellement masquees). */
  stderrTruncated: boolean;
  /** Duree d'execution en ms (mesuree cote Node). */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Lance un binaire et attend sa fin. Ne jette PAS d'exception sur exit code
 * non-zero ou timeout : retourne toujours un RunBinaryResult.
 */
export async function runBinary(opts: RunBinaryOptions): Promise<RunBinaryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  const start = Date.now();

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  return new Promise((resolve) => {
    const child = spawn(opts.bin, opts.args, spawnOpts);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    let stdoutTruncated = false;
    let stderrTruncated = false;
    const appendCapped = (current: string, chunk: string, isStderr: boolean): string => {
      if (current.length >= maxBuffer) {
        if (isStderr) stderrTruncated = true;
        else stdoutTruncated = true;
        return current;
      }
      const remaining = maxBuffer - current.length;
      if (chunk.length > remaining) {
        if (isStderr) stderrTruncated = true;
        else stdoutTruncated = true;
        return current + chunk.slice(0, remaining) + `\n[...truncated at ${maxBuffer} bytes]\n`;
      }
      return current + chunk;
    };

    let stderrLog: WriteStream | null = null;
    if (opts.stderrLogPath) {
      try {
        stderrLog = createWriteStream(opts.stderrLogPath, { flags: 'w' });
      } catch {
        // pas fatal : on continue avec capture in-memory seule
      }
    }

    child.stdout?.on('data', (d) => { stdout = appendCapped(stdout, d.toString('utf8'), false); });
    child.stderr?.on('data', (d) => {
      const s = d.toString('utf8');
      stderr = appendCapped(stderr, s, true);
      if (stderrLog) stderrLog.write(s);
    });

    if (opts.stdin !== undefined && child.stdin) {
      // Si le payload depasse 50KB on log un warning : le pipe OS (~64KB sur
      // Linux) peut bloquer si le child ne lit pas immediatement. write() avec
      // callback gere la backpressure cote Node.
      if (opts.stdin.length > 50_000) {
        process.stderr.write(`[runBinary] stdin payload large (${Math.round(opts.stdin.length / 1024)}KB) — pipe peut bloquer\n`);
      }
      child.stdin.on('error', (err) => {
        // EPIPE possible si le child ferme stdin avant qu'on ait fini d'ecrire.
        // Pas fatal : le child a deja ce qu'il voulait.
        stderr = appendCapped(stderr, `\n[stdin error] ${err.message}\n`, true);
      });
      child.stdin.write(opts.stdin, () => child.stdin?.end());
    }

    const finish = (exitCode: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (stderrLog) {
        try { stderrLog.end(); } catch { /* ignore */ }
      }
      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - start,
      });
    };

    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      // erreur de spawn (binaire introuvable etc.)
      stderr = appendCapped(stderr, `\n[spawn error] ${err.message}\n`, true);
      finish(null);
    });
  });
}
