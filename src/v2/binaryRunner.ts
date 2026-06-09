/**
 * Generic helper to spawn a binary and capture its output.
 * Used for catgen-pdf (extract / render) and the claude CLI.
 *
 * Captures stdout + stderr (size-limited to avoid saturating RAM if the
 * binary dumps megabytes of logs), handles timeout (SIGKILL if exceeded),
 * returns a structured object rather than throwing exceptions.
 */

import { spawn, type SpawnOptions } from 'child_process';
import { createWriteStream, type WriteStream } from 'fs';

export interface RunBinaryOptions {
  /** Absolute path or name of the binary in the PATH. */
  bin: string;
  /** Arguments. No quoting needed (spawn passes an argv array). */
  args: string[];
  /** Working directory (default: process.cwd()). */
  cwd?: string;
  /** Timeout in ms; beyond it, SIGKILL. Default: 60_000 (60s). */
  timeoutMs?: number;
  /** Additional env variables (merged with process.env). */
  env?: Record<string, string>;
  /** Text to write to the process stdin (optional). */
  stdin?: string;
  /** Storage cap for stdout / stderr in bytes (each). Default 1 MB. */
  maxBufferBytes?: number;
  /** File to mirror stderr (full, uncapped) alongside the in-memory buffer.
   *  Useful for post-mortem debugging when stderrTruncated=true. */
  stderrLogPath?: string;
}

export interface RunBinaryResult {
  ok: boolean;
  exitCode: number | null;
  /** True if the process was killed because the timeout expired. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** True if stdout exceeded maxBuffer (output truncated). */
  stdoutTruncated: boolean;
  /** True if stderr exceeded maxBuffer (errors potentially hidden). */
  stderrTruncated: boolean;
  /** Execution time in ms (measured on the Node side). */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * Launches a binary and waits for it to finish. Does NOT throw an exception
 * on a non-zero exit code or timeout: always returns a RunBinaryResult.
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
        // not fatal: we continue with in-memory capture only
      }
    }

    child.stdout?.on('data', (d) => { stdout = appendCapped(stdout, d.toString('utf8'), false); });
    child.stderr?.on('data', (d) => {
      const s = d.toString('utf8');
      stderr = appendCapped(stderr, s, true);
      if (stderrLog) stderrLog.write(s);
    });

    if (opts.stdin !== undefined && child.stdin) {
      // If the payload exceeds 50KB we log a warning: the OS pipe (~64KB on
      // Linux) can block if the child does not read immediately. write() with
      // a callback handles backpressure on the Node side.
      if (opts.stdin.length > 50_000) {
        process.stderr.write(`[runBinary] stdin payload large (${Math.round(opts.stdin.length / 1024)}KB) — pipe peut bloquer\n`);
      }
      child.stdin.on('error', (err) => {
        // EPIPE possible if the child closes stdin before we finish writing.
        // Not fatal: the child already has what it wanted.
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
      // spawn error (binary not found, etc.)
      stderr = appendCapped(stderr, `\n[spawn error] ${err.message}\n`, true);
      finish(null);
    });
  });
}
