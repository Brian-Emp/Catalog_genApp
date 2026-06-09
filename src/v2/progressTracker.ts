/**
 * In-memory progress tracker for V2 generation.
 *
 * The pipeline is synchronous (POST /generate only returns at the end), but
 * we publish progress phase by phase here so a client can poll
 * `/api/progress/:jobId` and show a real bar (not fake progress based on
 * timers).
 *
 * Auto cleanup: we remove entries older than 1h to avoid a memory leak
 * if a client polls but the POST failed silently before calling
 * clearProgress.
 */

export interface ProgressState {
  /** Current phase: extract, classify, allocate, normalize, format,
   *  substitute, descriptions, toc, render, audit, finalize, done, error. */
  phase: string;
  /** Percentage 0-100. */
  pct: number;
  /** User-facing FR message. */
  message: string;
  /** Date.now() of the last update. Used by the client to detect a stall
   *  (no update for > 30s = "slowdown" warning). */
  updatedAt: number;
  /** True = pipeline finished (success or error). The client can stop
   *  polling. */
  done: boolean;
  /** Error message if done && error. */
  error?: string;
}

const tracker = new Map<string, ProgressState>();
const CLEANUP_AGE_MS = 60 * 60 * 1000;

export function setProgress(
  jobId: string,
  phase: string,
  pct: number,
  message: string,
): void {
  tracker.set(jobId, {
    phase,
    pct,
    message,
    updatedAt: Date.now(),
    done: false,
  });
}

export function markDone(jobId: string, message = 'Terminé'): void {
  tracker.set(jobId, {
    phase: 'done',
    pct: 100,
    message,
    updatedAt: Date.now(),
    done: true,
  });
}

export function markError(jobId: string, error: string): void {
  tracker.set(jobId, {
    phase: 'error',
    pct: 0,
    message: 'Erreur',
    updatedAt: Date.now(),
    done: true,
    error,
  });
}

export function getProgress(jobId: string): ProgressState | undefined {
  return tracker.get(jobId);
}

export function clearProgress(jobId: string): void {
  tracker.delete(jobId);
}

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tracker.entries()) {
    if (now - v.updatedAt > CLEANUP_AGE_MS) tracker.delete(k);
  }
}, 5 * 60 * 1000);
cleanupInterval.unref();
