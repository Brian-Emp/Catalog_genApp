/**
 * Tracker de progression in-memory pour la generation V2.
 *
 * Le pipeline est synchrone (POST /generate ne rend qu'a la fin), mais on
 * publie l'avancee phase par phase ici pour qu'un client puisse poll
 * `/api/progress/:jobId` et afficher une vraie barre (pas du faux progress
 * base sur des timers).
 *
 * Cleanup auto : on supprime les entries > 1h pour eviter une fuite memoire
 * si un client poll mais que le POST a echoue silencieusement avant
 * d'appeler clearProgress.
 */

export interface ProgressState {
  /** Phase courante : extract, classify, allocate, normalize, format,
   *  substitute, descriptions, toc, render, audit, finalize, done, error. */
  phase: string;
  /** Pourcentage 0-100. */
  pct: number;
  /** Message FR visible utilisateur. */
  message: string;
  /** Date.now() du dernier update. Sert au client pour detecter un blocage
   *  (pas d'update depuis > 30s = warning "ralentissement"). */
  updatedAt: number;
  /** True = pipeline termine (succes ou erreur). Le client peut arreter
   *  le polling. */
  done: boolean;
  /** Message d'erreur si done && erreur. */
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
