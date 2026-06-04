/**
 * Génère les fixtures Catalogue C pour smoke E2E :
 *   - tests/fixtures/catalogC_data.xlsx (3 produits page 13 Catalogue C)
 *   - tests/fixtures/catalogC_assets.zip (3 PNG placeholder)
 *
 * Schema XLSX identique à data.xlsx Catalogue A : 1 ligne = 1 produit, headers avec
 * préfixe numérique pour les specs.
 */
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '../tests/fixtures');

async function main() {
  // ─── XLSX ────────────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Feuil1');
  ws.columns = [
    { header: 'Code Produit', key: 'sku', width: 12 },
    { header: 'Gencod', key: 'gencod', width: 15 },
    { header: 'Désignation Produit', key: 'name', width: 30 },
    { header: 'Libellé Famille', key: 'famille', width: 20 },
    { header: 'Libellé SFamille', key: 'sfamille', width: 30 },
    { header: 'Libellé SSFamille', key: 'section', width: 30 },
    { header: '100 Puissance', key: 'puissance', width: 12 },
    { header: '101 Marche / Arrêt', key: 'marche', width: 25 },
    { header: '102 Débit maximum', key: 'debit', width: 12 },
    { header: '103 Hauteur de refoulement maxi.', key: 'hrefoul', width: 12 },
    { header: '104 Hauteur d eau résiduelle', key: 'hres', width: 12 },
    { header: '105 Hauteur d eau de démarrage', key: 'hdemar', width: 15 },
    { header: '106 Diamètre maximum des particules', key: 'partic', width: 12 },
    { header: '107 Tension', key: 'tension', width: 12 },
    { header: '108 Câble électrique', key: 'cable', width: 10 },
    { header: '109 Corps de la pompe', key: 'corps', width: 15 },
    { header: '110 Diamètre de refoulement', key: 'drefoul', width: 12 },
    { header: '111 Turbine', key: 'turbine', width: 12 },
    { header: '112 Garantie', key: 'garantie', width: 15 },
  ];
  const rows = [
    {
      sku: '002236', gencod: '3325310022366', name: 'ECOP 100',
      famille: 'ÉVACUATION', sfamille: 'Pompes d évacuation eaux claires', section: 'Eaux claires',
      puissance: '250 W', marche: 'Flotteur externe',
      debit: '7 m³/h', hrefoul: '6 m', hres: '20 mm', hdemar: '34 à 54 cm',
      partic: 'Ø 5 mm', tension: '220-240 V', cable: '10 m',
      corps: 'Composite', drefoul: 'F 33/42', turbine: 'Composite', garantie: '2 ans',
    },
    {
      sku: '002281', gencod: '3325310022816', name: 'ECL 250',
      famille: 'ÉVACUATION', sfamille: 'Pompes d évacuation eaux claires', section: 'Eaux claires',
      puissance: '250 W', marche: 'Capteur Aqua Sensor',
      debit: '8 m³/h', hrefoul: '6 m', hres: '3 mm', hdemar: '25 mm',
      partic: 'Ø 5 mm', tension: '220-240 V', cable: '10 m',
      corps: 'Composite', drefoul: 'F 33/42', turbine: 'Composite', garantie: '3 ans + 2 ans',
    },
    {
      sku: '002282', gencod: '3325310022823', name: 'ECL 400',
      famille: 'ÉVACUATION', sfamille: 'Pompes d évacuation eaux claires', section: 'Eaux claires',
      puissance: '400 W', marche: 'Capteur Aqua Sensor',
      debit: '12 m³/h', hrefoul: '8 m', hres: '3 mm', hdemar: '25 mm',
      partic: 'Ø 5 mm', tension: '220-240 V', cable: '10 m',
      corps: 'Inox / composite', drefoul: 'F 33/42', turbine: 'Composite', garantie: '3 ans + 2 ans',
    },
  ];
  rows.forEach((r) => ws.addRow(r));
  const xlsxPath = path.join(FIXTURES, 'catalogC_data.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  console.log('XLSX écrit :', xlsxPath, fs.statSync(xlsxPath).size, 'bytes');

  // ─── Assets ZIP ─────────────────────────────────────────────────────────
  // 3 PNG placeholder 200x300 nommés par SKU, générés via Python PIL.
  // Gris uni avec SKU centré pour identifier visuellement le placeholder
  // (vs PNG 1x1 qui rendait "carré noir compact").
  const { execSync } = require('child_process');
  const tmpDir = require('os').tmpdir();
  const zip = new AdmZip();
  for (const sku of ['002236', '002281', '002282']) {
    const outPath = path.join(tmpDir, `catalogC_${sku}.png`);
    execSync(`python3 -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (200, 300), color=(220, 220, 220))
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 24)
except Exception:
    font = ImageFont.load_default()
d.text((50, 130), '${sku}', fill=(80, 80, 80), font=font)
img.save('${outPath}')
"`);
    zip.addLocalFile(outPath, '', `${sku}.png`);
    fs.unlinkSync(outPath);
  }
  const zipPath = path.join(FIXTURES, 'catalogC_assets.zip');
  zip.writeZip(zipPath);
  console.log('ZIP écrit :', zipPath, fs.statSync(zipPath).size, 'bytes');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
