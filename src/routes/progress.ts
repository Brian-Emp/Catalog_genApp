import { Router } from 'express';
import { getProgress } from '../v2/progressTracker';

export const progressRouter: Router = Router();

progressRouter.get('/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId || !/^[a-zA-Z0-9_-]{1,64}$/.test(jobId)) {
    res.status(400).json({ error: 'jobId invalide' });
    return;
  }
  const state = getProgress(jobId);
  if (!state) {
    res.status(404).json({ error: 'jobId inconnu', phase: 'unknown', pct: 0, message: '', done: false });
    return;
  }
  res.json(state);
});
