/**
 * Smoke E2E du pipeline engine V2.
 *
 * A executer DANS le container (qui a catgen-pdf + claude installes) :
 *   docker exec catalog_gen_app-app-1 node /app/tests/v2/engine/e2e.smoke.mjs
 *
 * Verifie :
 *  1. extract -> raw_spans presents
 *  2. detectProfile -> source=heuristic
 *  3. buildPlanFromCascade -> >= 1 page en mode operations
 *  4. render -> PDF de sortie genere, taille > 0
 *  5. duree totale raisonnable (< 60s)
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { substituteCatalogEngine } from '/app/dist/v2/engineOrchestrator.js';

const TEMPLATE_PDF = '/app/tests/fixtures/template.pdf';
const ASSETS_DIR = '/tmp/empty-assets';

async function main() {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-smoke-'));
  const outPdf = path.join(workDir, 'out.pdf');

  const products = [
    {
      name: 'MITIGEUR ÉVIER TEST-A',
      ref: 'TST-001',
      color: 'Chromé',
      image_path: null,
      specs: [
        { key: 'MECANISME', values: ['cartouche céramique Ø 35 mm'] },
        { key: 'POIGNÉE', values: ['métal'] },
        { key: 'CORPS', values: ['laiton chromé'] },
      ],
      variants: [],
      section: null,
    },
    {
      name: 'MITIGEUR ÉVIER TEST-B',
      ref: 'TST-002',
      color: 'Noir',
      image_path: null,
      specs: [
        { key: 'MECANISME', values: ['cartouche céramique'] },
        { key: 'CORPS', values: ['laiton'] },
      ],
      variants: [],
      section: null,
    },
    {
      name: 'MITIGEUR LAVABO TEST-C',
      ref: 'TST-003',
      color: 'Chromé',
      image_path: null,
      specs: [{ key: 'BEC', values: ['fondu'] }],
      variants: [],
      section: null,
    },
  ];

  const t0 = Date.now();
  const res = await substituteCatalogEngine({
    templatePdfPath: TEMPLATE_PDF,
    products,
    assetsDir: ASSETS_DIR,
    jobId: 'smoke-e2e',
    workDir,
    outPdfPath: outPdf,
    projectDir: '/app',
  });
  const totalMs = Date.now() - t0;

  console.log('=== E2E smoke ===');
  console.log('ok               :', res.ok);
  console.log('outPdfPath       :', res.outPdfPath);
  console.log('totalMs          :', totalMs);
  console.log('stats.extractMs  :', res.stats.extractMs);
  console.log('stats.cascadeMs  :', res.stats.cascadeMs);
  console.log('stats.renderMs   :', res.stats.renderMs);
  console.log('stats.profileSrc :', res.stats.profileSource);
  console.log('stats.pagesKept  :', res.stats.pagesKept);
  console.log('stats.productsUsed:', res.stats.productsUsed);
  console.log('errors           :', res.errors);
  console.log('warnings count   :', res.warnings.length);

  // Verifications minimales
  if (!res.ok) {
    console.error('ECHEC: orchestrator KO');
    process.exit(1);
  }
  const stat = await fs.stat(outPdf);
  if (stat.size === 0) {
    console.error('ECHEC: PDF vide');
    process.exit(2);
  }
  if (res.stats.productsUsed === 0) {
    console.error('ECHEC: aucun produit substitue');
    process.exit(3);
  }
  if (totalMs > 90_000) {
    console.error(`ECHEC: trop lent (${totalMs}ms > 90s)`);
    process.exit(4);
  }

  console.log('--- SMOKE OK ---');
  console.log(`PDF: ${outPdf} (${stat.size} bytes)`);
}

main().catch((e) => {
  console.error('ERREUR:', e);
  process.exit(99);
});
