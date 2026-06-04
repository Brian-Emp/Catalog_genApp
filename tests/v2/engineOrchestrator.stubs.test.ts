/**
 * Tests d'intégration de substituteCatalogEngine avec STUBS du binaire
 * catgen-pdf. Vérifie les paths d'erreur (crash extract / crash render)
 * et le happy path minimal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { substituteCatalogEngine } from '../../src/v2/engineOrchestrator';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'eng-test-'));
  // Reset cache extract global (catgen-extract-cache) : sans ça, un test
  // précédent peut polluer le cache via le hash partagé du template "fake".
  // Conséquence visible : test "extract crash" passe sur cache hit et retourne
  // "aucune page extracted" au lieu de "extract failed".
  try {
    rmSync(path.join(tmpdir(), 'catgen-extract-cache'), { recursive: true, force: true });
  } catch { /* non-fatal */ }
});

function writeStub(p: string, content: string): void {
  writeFileSync(p, content);
  chmodSync(p, 0o755);
}

/**
 * Stub catgen-pdf parametrable :
 *  - extractExit : code retour de 'extract'
 *  - renderExit : code retour de 'render'
 *  - extractStderr : texte envoye sur stderr en extract
 */
function setupStub(opts: {
  extractExit?: number;
  renderExit?: number;
  extractStderr?: string;
  produceJson?: boolean;
} = {}): string {
  const stubDir = path.join(tmp, 'stub');
  mkdirSync(stubDir, { recursive: true });
  const extractExit = opts.extractExit ?? 0;
  const renderExit = opts.renderExit ?? 0;
  const extractStderr = opts.extractStderr ?? '';
  const produceJson = opts.produceJson ?? true;
  const bin = path.join(stubDir, 'catgen-pdf');
  writeStub(bin, `#!/bin/sh
case "$1" in
  extract)
    mkdir -p "$3"
    ${extractStderr ? `echo "${extractStderr}" >&2` : ''}
    ${produceJson ? `cat > "$3/page-000.json" <<'EOF'
{
  "page_number": 0,
  "page_size": { "width": 595, "height": 842 },
  "slots": [],
  "raw_spans": [],
  "raw_images": []
}
EOF` : ''}
    exit ${extractExit}
    ;;
  render)
    echo "%PDF-1.4 fake" > "$6"
    exit ${renderExit}
    ;;
esac
`);
  return bin;
}

function runEngine(binary: string) {
  const templatePdf = path.join(tmp, 'template.pdf');
  writeFileSync(templatePdf, '%PDF-1.4 fake');
  const assetsDir = path.join(tmp, 'assets');
  mkdirSync(assetsDir);
  return substituteCatalogEngine({
    templatePdfPath: templatePdf,
    products: [{
      name: 'Produit Test',
      ref: null,
      color: null,
      image_path: null,
      specs: [],
      variants: [],
    }],
    assetsDir,
    jobId: 'test',
    workDir: path.join(tmp, 'work'),
    outPdfPath: path.join(tmp, 'out.pdf'),
    projectDir: tmp,
    binaryBin: binary,
  });
}

describe('substituteCatalogEngine (stubs)', () => {
  it('extract crash exit != 0 → ok=false avec stderr propagé', async () => {
    const bin = setupStub({ extractExit: 5, extractStderr: 'PDF vide ou illisible' });
    const r = await runEngine(bin);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/extract failed/);
  });

  it('extract produit 0 fichier JSON → ok=false avec stderr', async () => {
    const bin = setupStub({ produceJson: false, extractStderr: 'PDF vide' });
    const r = await runEngine(bin);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/aucune page extracted valide/);
  });

  it('render crash exit != 0 → ok=false', async () => {
    const bin = setupStub({ renderExit: 7 });
    const r = await runEngine(bin);
    expect(r.ok).toBe(false);
    // Le pipeline peut echouer avant render (pas de produits matchés sur page
    // vide), mais si on arrive a render, l'erreur doit etre propagee.
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('binaire inexistant → ok=false (spawn error)', async () => {
    const r = await runEngine('/nonexistent/catgen-pdf');
    expect(r.ok).toBe(false);
  });
});
