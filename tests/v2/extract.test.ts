import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { validateExtractedPage } from '../../src/v2/validation/extractedPage';

// Smoke test pour le binaire catgen-pdf : on l'execute sur la fixture
// template.pdf et on valide TOUS les JSONs produits avec validateExtractedPage.
//
// Pre-requis : `docker compose up -d` doit tourner. Le test execute la
// commande dans le container.

const FIXTURE_PDF = path.resolve(__dirname, '../fixtures/template.pdf');

function dockerExec(cmd: string): string {
  return execSync(`docker compose exec -T app sh -c "${cmd}"`, {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
}

function dockerCpFromContainer(srcInContainer: string, destOnHost: string): void {
  execSync(`docker compose cp app:${srcInContainer} ${destOnHost}`, {
    cwd: path.resolve(__dirname, '../..'),
  });
}

function dockerCpToContainer(srcOnHost: string, destInContainer: string): void {
  execSync(`docker compose cp ${srcOnHost} app:${destInContainer}`, {
    cwd: path.resolve(__dirname, '../..'),
  });
}

describe('catgen-pdf extract (round-trip vs validateExtractedPage)', () => {
  it('produit des JSONs valides pour toutes les pages du fixture', () => {
    // Skip si pas de Docker ou pas de fixture
    try {
      execSync('docker compose ps app', { cwd: path.resolve(__dirname, '../..') });
    } catch {
      console.warn('docker compose pas dispo, skip test E2E');
      return;
    }
    try {
      readFileSync(FIXTURE_PDF);
    } catch {
      console.warn('fixture template.pdf manquante, skip test E2E');
      return;
    }

    // 1. Copy fixture into container
    dockerCpToContainer(FIXTURE_PDF, '/tmp/test-template.pdf');

    // 2. Run extract
    dockerExec('rm -rf /tmp/test-extracted && catgen-pdf extract /tmp/test-template.pdf /tmp/test-extracted');

    // 3. Copy results back
    const tmp = mkdtempSync(path.join(tmpdir(), 'catgen-extract-'));
    try {
      dockerCpFromContainer('/tmp/test-extracted', tmp);
      const dir = path.join(tmp, 'test-extracted');
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);

      // 4. Validate each one
      const failures: { file: string; errors: string[] }[] = [];
      for (const f of files) {
        const raw = readFileSync(path.join(dir, f), 'utf8');
        const json = JSON.parse(raw);
        const r = validateExtractedPage(json);
        if (!r.ok) {
          failures.push({
            file: f,
            errors: r.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`),
          });
        }
      }

      if (failures.length > 0) {
        console.error('JSONs invalides:', JSON.stringify(failures.slice(0, 5), null, 2));
      }
      expect(failures).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);  // timeout 60s pour gros template
});
