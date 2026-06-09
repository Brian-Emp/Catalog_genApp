import { Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { signedUrl } from './downloadToken';
import { requireAuth } from '../middleware/auth';

export const historyRouter: Router = Router();

const GEN_DIR = path.resolve('generated');
const UPLOADS_DIR = path.resolve('uploads');
// Stamp = `<timestamp>_<hex6>` since the P0+P1 security commit (randomBytes,
// anti brute-force). We accept both forms (with/without the hex suffix) to stay
// compatible with PDFs generated before this change.
const STAMP = `(\\d+(?:_[a-f0-9]+)?)`;
const PDF_RE = new RegExp(`^catalog_${STAMP}\\.pdf$`);
const CATALOG_ANY_RE = new RegExp(`^catalog_${STAMP}(?:\\.\\w+|_work|_assets)(?:\\..+)?$`);
const WORK_DIR_RE = new RegExp(`^_${STAMP}_work$`);
// Pattern of files created by our multer in uploads/: timestamped prefix
// + 6 random chars + original name. Used to tell apart the files WE created
// (eligible for GC) from files possibly dropped in by hand by the user
// (to preserve).
const MANAGED_UPLOAD_RE = /^\d+-[a-z0-9]{6}-/;

interface HistoryItem {
  pdfName: string;
  pdfUrl: string;
  metaName: string;
  stamp: string;
  createdAt: string;
  sizeBytes: number;
  meta: Record<string, unknown> | null;
}

async function readMeta(metaPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function listCatalogs(): Promise<HistoryItem[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(GEN_DIR);
  } catch {
    return [];
  }
  const items: HistoryItem[] = [];
  for (const name of entries) {
    const m = PDF_RE.exec(name);
    if (!m) continue;
    const pdfPath = path.join(GEN_DIR, name);
    try {
      const stat = await fs.stat(pdfPath);
      const base = name.replace(/\.pdf$/, '');
      const metaName = `${base}.meta.json`;
      const meta = await readMeta(path.join(GEN_DIR, metaName));
      items.push({
        pdfName: name,
        pdfUrl: signedUrl(name),
        metaName,
        stamp: m[1],
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        meta,
      });
    } catch {
      // skip
    }
  }
  items.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  return items;
}

historyRouter.get('/history', async (_req, res) => {
  const items = await listCatalogs();
  res.json({ items });
});

async function uploadsForStamp(stamp: string): Promise<string[]> {
  const meta = await readMeta(path.join(GEN_DIR, `catalog_${stamp}.meta.json`));
  if (!meta || !Array.isArray(meta.uploadedFiles)) return [];
  return meta.uploadedFiles.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** Lists uploads still referenced by at least one existing meta.json.
 *  Used for orphan GC: any "managed" upload not present in this set is a
 *  candidate for deletion. */
async function listReferencedUploads(): Promise<Set<string>> {
  const referenced = new Set<string>();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(GEN_DIR);
  } catch {
    return referenced;
  }
  for (const name of entries) {
    if (!name.endsWith('.meta.json')) continue;
    const meta = await readMeta(path.join(GEN_DIR, name));
    if (!meta || !Array.isArray(meta.uploadedFiles)) continue;
    for (const u of meta.uploadedFiles) {
      if (typeof u === 'string' && u) referenced.add(u);
    }
  }
  return referenced;
}

/** Removes orphan uploads (managed but no longer referenced by any meta).
 *  Covers cases where the meta was deleted or corrupted, and historical
 *  residue accumulated before cascade deletion was in place. */
async function cleanupOrphanUploads(): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(UPLOADS_DIR);
  } catch {
    return 0;
  }
  const referenced = await listReferencedUploads();
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  let removed = 0;
  for (const name of entries) {
    // Keep non-managed files (dropped in manually by the user).
    if (!MANAGED_UPLOAD_RE.test(name)) continue;
    if (referenced.has(name)) continue;
    // Defense-in-depth against path traversal.
    const target = path.resolve(uploadsRoot, name);
    if (target !== path.join(uploadsRoot, name)) continue;
    if (!target.startsWith(uploadsRoot + path.sep)) continue;
    try {
      await fs.rm(target, { force: true });
      removed++;
    } catch {
      // non-fatal
    }
  }
  return removed;
}

async function deleteOneStamp(stamp: string): Promise<boolean> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(GEN_DIR);
  } catch {
    return false;
  }
  const matching = entries.filter((n) => {
    const m = CATALOG_ANY_RE.exec(n);
    if (m) return m[1] === stamp;
    const w = WORK_DIR_RE.exec(n);
    return w ? w[1] === stamp : false;
  });
  if (!matching.length) return false;
  const uploads = await uploadsForStamp(stamp);
  for (const n of matching) {
    await fs.rm(path.join(GEN_DIR, n), { recursive: true, force: true });
  }
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  for (const up of uploads) {
    // Defense-in-depth: meta.json is supposed to contain only basenames we
    // generated, but in case it was hand-edited we reject any traversal. The
    // path must stay strictly within UPLOADS_DIR.
    const base = path.basename(up);
    if (!base || base.startsWith('.') || base !== up) continue;
    const target = path.resolve(uploadsRoot, base);
    if (target !== path.join(uploadsRoot, base)) continue;
    if (!target.startsWith(uploadsRoot + path.sep)) continue;
    await fs.rm(target, { force: true });
  }
  return true;
}

historyRouter.delete('/history', requireAuth, async (req, res) => {
  const pdf = String(req.query.pdf ?? '').trim();
  if (pdf) {
    const m = PDF_RE.exec(pdf);
    if (!m) {
      res.status(400).json({ error: 'Nom de PDF invalide' });
      return;
    }
    const ok = await deleteOneStamp(m[1]);
    // GC of orphan uploads: reclaims accumulated historical residue
    // (e.g. meta.json already deleted but uploads never cleaned up).
    const orphans = await cleanupOrphanUploads();
    res.json({ deleted: ok ? 1 : 0, orphanUploadsRemoved: orphans });
    return;
  }

  // Full sweep (except an optional keep). If keep is provided but malformed,
  // we REJECT rather than delete everything (otherwise a trivially exploitable hole).
  const keep = String(req.query.keep ?? '').trim();
  let keepStamp: string | null = null;
  if (keep) {
    const m = PDF_RE.exec(keep);
    if (!m) {
      res.status(400).json({ error: 'Parametre keep invalide' });
      return;
    }
    keepStamp = m[1];
  }
  let entries: string[] = [];
  try {
    entries = await fs.readdir(GEN_DIR);
  } catch {
    res.json({ deleted: 0, orphanUploadsRemoved: 0 });
    return;
  }
  const stamps = new Set<string>();
  for (const n of entries) {
    const m = CATALOG_ANY_RE.exec(n) || WORK_DIR_RE.exec(n);
    if (m) stamps.add(m[1]);
  }
  let deleted = 0;
  for (const stamp of stamps) {
    if (keepStamp && stamp === keepStamp) continue;
    if (await deleteOneStamp(stamp)) deleted++;
  }
  const orphans = await cleanupOrphanUploads();
  res.json({ deleted, orphanUploadsRemoved: orphans });
});
