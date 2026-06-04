/**
 * Test de determinisme bit-exact du renderer C++ + normalize TS.
 *
 * Strategie :
 *   1. Lance `catgen-pdf render` 2 fois avec EXACTEMENT le meme input
 *      (meme plan.json, meme template.pdf) sur le binaire dans le container Docker
 *   2. Recupere les 2 PDFs sur le host, applique normalizePdfMeta sur chacun
 *   3. Compare les sha256 → doivent etre identiques
 *
 * Si Docker n'est pas dispo, le test est skipped.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { normalizePdfMeta } from '../../src/v2/normalizePdf';

function dockerOk(): boolean {
  try {
    execSync('docker compose ps app', {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

const FIXTURE_PDF = path.resolve(__dirname, '../fixtures/template.pdf');

describe('renderer determinisme (catgen-pdf render + normalizePdf)', () => {
  it('2 runs successifs produisent un PDF byte-identique', async () => {
    if (!dockerOk()) {
      console.warn('docker compose pas dispo, skip determinisme');
      return;
    }

    const tmp = mkdtempSync(path.join(tmpdir(), 'catgen-det-'));
    try {
      // Plan ultra simple : 1 page keep_raw
      const plan = {
        version: '1',
        pages: [{ source_page: 0, page_number: 1, render: { mode: 'keep_raw' } }],
      };
      const planPath = path.join(tmp, 'plan.json');
      writeFileSync(planPath, JSON.stringify(plan, null, 2));

      const root = path.resolve(__dirname, '../..');

      // Setup dans le container : copy fixture + plan
      execSync(`docker compose cp ${FIXTURE_PDF} app:/tmp/det-template.pdf`, { cwd: root, stdio: 'ignore' });
      execSync(`docker compose cp ${planPath} app:/tmp/det-plan.json`, { cwd: root, stdio: 'ignore' });
      execSync(
        `docker compose exec -T app sh -c "rm -rf /tmp/det-templates && mkdir -p /tmp/det-templates /tmp/det-assets && catgen-pdf extract /tmp/det-template.pdf /tmp/det-templates >/dev/null"`,
        { cwd: root },
      );

      // Run 1
      execSync(
        `docker compose exec -T app catgen-pdf render /tmp/det-plan.json /tmp/det-template.pdf /tmp/det-templates /tmp/det-assets /tmp/det-out1.pdf >/dev/null`,
        { cwd: root },
      );
      execSync(`docker compose cp app:/tmp/det-out1.pdf ${tmp}/out1.pdf`, { cwd: root, stdio: 'ignore' });

      // Run 2
      execSync(
        `docker compose exec -T app catgen-pdf render /tmp/det-plan.json /tmp/det-template.pdf /tmp/det-templates /tmp/det-assets /tmp/det-out2.pdf >/dev/null`,
        { cwd: root },
      );
      execSync(`docker compose cp app:/tmp/det-out2.pdf ${tmp}/out2.pdf`, { cwd: root, stdio: 'ignore' });

      // Sha avant normalize
      const h1Before = sha256(path.join(tmp, 'out1.pdf'));
      const h2Before = sha256(path.join(tmp, 'out2.pdf'));
      // (Les sha avant normalize peuvent differer a cause de CreationDate/ID.)

      await normalizePdfMeta(path.join(tmp, 'out1.pdf'));
      await normalizePdfMeta(path.join(tmp, 'out2.pdf'));
      const h1After = sha256(path.join(tmp, 'out1.pdf'));
      const h2After = sha256(path.join(tmp, 'out2.pdf'));

      console.log(`avant normalize: ${h1Before.slice(0, 12)} vs ${h2Before.slice(0, 12)}`);
      console.log(`apres normalize: ${h1After.slice(0, 12)} vs ${h2After.slice(0, 12)}`);

      expect(h1After).toBe(h2After);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
