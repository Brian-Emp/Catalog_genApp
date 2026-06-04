import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { detectMagicKind, kindMatchesExt } from '../src/services/extractors/magicBytes';

let tmpDir: string;

async function writeBytes(name: string, bytes: number[] | Buffer): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return p;
}

async function writeText(name: string, text: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, text, 'utf8');
  return p;
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magicbytes-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('detectMagicKind', () => {
  it('détecte un PNG', async () => {
    const p = await writeBytes('img.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(await detectMagicKind(p)).toBe('png');
  });

  it('détecte un JPEG', async () => {
    const p = await writeBytes('img.jpg', [0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(await detectMagicKind(p)).toBe('jpeg');
  });

  it('détecte un PDF', async () => {
    const p = await writeBytes('doc.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    expect(await detectMagicKind(p)).toBe('pdf');
  });

  it('détecte un ZIP', async () => {
    const p = await writeBytes('archive.zip', [0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(await detectMagicKind(p)).toBe('zip');
  });

  it('détecte un WebP (offset 8)', async () => {
    const buf = Buffer.alloc(32);
    Buffer.from('RIFF').copy(buf, 0);
    Buffer.from('WEBP').copy(buf, 8);
    const p = await writeBytes('img.webp', buf);
    expect(await detectMagicKind(p)).toBe('webp');
  });

  it('détecte un TIFF little-endian', async () => {
    const p = await writeBytes('img.tif', [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]);
    expect(await detectMagicKind(p)).toBe('tiff');
  });
  it('détecte un TIFF big-endian', async () => {
    const p = await writeBytes('img.tif', [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08]);
    expect(await detectMagicKind(p)).toBe('tiff');
  });

  it('détecte un HEIC (brand mif1)', async () => {
    const buf = Buffer.alloc(32);
    // 4 octets size header (ignore par detection) puis ftyp + brand
    buf.writeUInt32BE(32, 0);
    Buffer.from('ftyp').copy(buf, 4);
    Buffer.from('mif1').copy(buf, 8);
    const p = await writeBytes('img.heic', buf);
    expect(await detectMagicKind(p)).toBe('heic');
  });
  it('détecte un HEIC (brand heic)', async () => {
    const buf = Buffer.alloc(32);
    Buffer.from('ftyp').copy(buf, 4);
    Buffer.from('heic').copy(buf, 8);
    const p = await writeBytes('img.heic', buf);
    expect(await detectMagicKind(p)).toBe('heic');
  });
  it('détecte un AVIF', async () => {
    const buf = Buffer.alloc(32);
    Buffer.from('ftyp').copy(buf, 4);
    Buffer.from('avif').copy(buf, 8);
    const p = await writeBytes('img.avif', buf);
    expect(await detectMagicKind(p)).toBe('avif');
  });

  it('détecte un SVG via heuristique XML', async () => {
    const p = await writeText('img.svg', '<?xml version="1.0"?><svg><circle/></svg>');
    expect(await detectMagicKind(p)).toBe('svg');
  });

  it('détecte un SVG sans déclaration XML', async () => {
    const p = await writeText('img.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await detectMagicKind(p)).toBe('svg');
  });

  it('classe un CSV en text', async () => {
    const p = await writeText('data.csv', 'name,price\nfoo,10\nbar,20\n');
    expect(await detectMagicKind(p)).toBe('text');
  });

  it("rejette un binaire .exe (MZ) en 'unknown'", async () => {
    const p = await writeBytes('fake.csv', [0x4d, 0x5a, 0x90, 0, 0x03]);
    expect(await detectMagicKind(p)).toBe('unknown');
  });

  it("traite un fichier vide en 'text' (longueur 0 = pas de byte hostile)", async () => {
    const p = await writeBytes('empty.csv', []);
    expect(await detectMagicKind(p)).toBe('text');
  });
});

describe('kindMatchesExt', () => {
  it('csv accepte uniquement text (pas svg, ni binaire)', () => {
    expect(kindMatchesExt('text', '.csv')).toBe(true);
    expect(kindMatchesExt('svg', '.csv')).toBe(false);
    expect(kindMatchesExt('unknown', '.csv')).toBe(false);
    expect(kindMatchesExt('jpeg', '.csv')).toBe(false);
  });

  it('xlsx/pptx/docx acceptent uniquement zip (OOXML)', () => {
    expect(kindMatchesExt('zip', '.xlsx')).toBe(true);
    expect(kindMatchesExt('zip', '.xlsm')).toBe(true);
    expect(kindMatchesExt('zip', '.pptx')).toBe(true);
    expect(kindMatchesExt('zip', '.docx')).toBe(true);
    expect(kindMatchesExt('text', '.xlsx')).toBe(false);
  });

  it('pdf accepte uniquement pdf', () => {
    expect(kindMatchesExt('pdf', '.pdf')).toBe(true);
    expect(kindMatchesExt('zip', '.pdf')).toBe(false);
    expect(kindMatchesExt('text', '.pdf')).toBe(false);
  });

  it('jpg et jpeg sont équivalents', () => {
    expect(kindMatchesExt('jpeg', '.jpg')).toBe(true);
    expect(kindMatchesExt('jpeg', '.jpeg')).toBe(true);
    expect(kindMatchesExt('jpeg', 'jpg')).toBe(true);
  });

  it('tif / tiff sont équivalents', () => {
    expect(kindMatchesExt('tiff', '.tif')).toBe(true);
    expect(kindMatchesExt('tiff', '.tiff')).toBe(true);
    expect(kindMatchesExt('tiff', 'tif')).toBe(true);
  });
  it('heic / heif acceptes', () => {
    expect(kindMatchesExt('heic', '.heic')).toBe(true);
    expect(kindMatchesExt('heic', '.heif')).toBe(true);
  });
  it('avif accepte', () => {
    expect(kindMatchesExt('avif', '.avif')).toBe(true);
  });
  it('jfif accepte (sous-format JPEG)', () => {
    expect(kindMatchesExt('jpeg', '.jfif')).toBe(true);
  });

  it("renvoie false pour une extension inconnue", () => {
    expect(kindMatchesExt('text', '.foo')).toBe(false);
    expect(kindMatchesExt('pdf', '')).toBe(false);
  });
});
