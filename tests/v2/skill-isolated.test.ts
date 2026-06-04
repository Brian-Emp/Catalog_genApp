import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import path from 'path';
import { validatePlan } from '../../src/v2/validation/plan';

// Test isolation du Skill Claude :
//   1. Prepare un mini extracted-page.json + products.json
//   2. Lance `claude --print --allowedTools "Edit,Skill"` avec un prompt
//      qui demande de produire plan.json
//   3. Valide le plan retourne contre le validateur TS
//
// SKIPPED par defaut (necessite la CLI claude + auth + tokens).
// Active : SKIP_CLAUDE_LIVE=0 npm test tests/v2/skill-isolated.test.ts

const SKIP = process.env.SKIP_CLAUDE_LIVE !== '0';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const MINI_EXTRACTED = {
  page_number: 5,
  page_size: { width: 595.28, height: 841.89 },
  slots: [
    {
      type: 'section_banner',
      id: 'banner_0',
      bbox: [240, 0, 565, 35],
      label: {
        text: 'BARRES DE DOUCHES',
        bbox: [260, 8, 540, 28],
        font: 'Almanach-Bold',
        size: 18,
        color: '#ffffff',
      },
    },
    {
      type: 'running_header',
      id: 'name_0',
      bbox: [50, 90, 250, 110],
      label: {
        text: 'ANCIEN NOM',
        bbox: [50, 90, 250, 110],
        font: 'Almanach-Bold',
        size: 14,
        color: '#1a1a1a',
      },
    },
  ],
};

const MINI_PRODUCTS = [
  {
    name: 'BARRE DOUCHE TEST',
    ref: '1234567',
    color: 'Chrome',
    image_path: null,
    specs: [],
    variants: [],
  },
];

describe.skipIf(SKIP)('skill catalog-generator (live Claude CLI)', () => {
  it('produit un plan.json valide', () => {
    if (!existsSync(path.join(homedir(), '.local/bin/claude')) && !canRun(CLAUDE_BIN)) {
      console.warn(`${CLAUDE_BIN} pas trouve, skip`);
      return;
    }
    const tmp = mkdtempSync(path.join(tmpdir(), 'catgen-skill-'));
    try {
      const templatesDir = path.join(tmp, 'templates', 'mini');
      execSync(`mkdir -p ${templatesDir}`);
      writeFileSync(
        path.join(templatesDir, 'page-005.json'),
        JSON.stringify(MINI_EXTRACTED, null, 2),
      );
      writeFileSync(path.join(tmp, 'products.json'), JSON.stringify(MINI_PRODUCTS, null, 2));
      const planPath = path.join(tmp, 'plan.json');
      writeFileSync(planPath, '{}');

      const prompt = `Lis ${templatesDir}/page-005.json et ${tmp}/products.json. Produis un plan.json conforme au Skill catalog-generator a ${planPath}. Use the Edit tool only on plan.json.`;

      execSync(
        `${CLAUDE_BIN} --print --output-format text --model sonnet --allowedTools "Edit,Skill" --add-dir ${tmp} "${prompt}"`,
        { stdio: 'inherit', timeout: 90_000 },
      );

      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      const r = validatePlan(plan);
      if (!r.ok) console.error('Plan invalide:', r.errors);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

function canRun(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
