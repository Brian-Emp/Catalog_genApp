import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { extractHtml, extractBody, extractStyleBlock } from '../../../src/v2/layout/layoutGen';
import { inlineFileImages } from '../../../src/v2/layout/htmlToPdf';

describe('extractHtml', () => {
  it('isole un document complet', () => {
    const h = '<!DOCTYPE html><html><body>x</body></html>';
    expect(extractHtml(h)).toBe(h);
  });

  it('strip les fences markdown ```html', () => {
    const h = '```html\n<!DOCTYPE html><html><body>x</body></html>\n```';
    expect(extractHtml(h)).toBe('<!DOCTYPE html><html><body>x</body></html>');
  });

  it('isole le html quand du texte parasite entoure', () => {
    const h = 'Voici ta page :\n<!DOCTYPE html><html><body>x</body></html>\nVoila.';
    expect(extractHtml(h)).toBe('<!DOCTYPE html><html><body>x</body></html>');
  });

  it('gere <html> sans doctype', () => {
    const h = '<html><head></head><body>ok</body></html>';
    expect(extractHtml(h)).toBe(h);
  });

  it('retourne null si pas de HTML', () => {
    expect(extractHtml('juste du texte sans balise')).toBeNull();
    expect(extractHtml('')).toBeNull();
  });
});

describe('extractStyleBlock', () => {
  it('extrait le CSS du <style>', () => {
    const h = '<html><head><style>.a{color:red}</style></head><body>x</body></html>';
    expect(extractStyleBlock(h)).toBe('.a{color:red}');
  });
  it('retourne null sans style', () => {
    expect(extractStyleBlock('<html><body>x</body></html>')).toBeNull();
  });
});

describe('extractBody', () => {
  it('extrait le contenu du body', () => {
    expect(extractBody('<body><div>hi</div></body>')).toBe('<div>hi</div>');
  });
  it('strip les fences puis extrait body', () => {
    expect(extractBody('```html\n<body><p>x</p></body>\n```')).toBe('<p>x</p>');
  });
  it('retourne le contenu brut si pas de balise body', () => {
    expect(extractBody('<section>contenu direct</section>')).toBe('<section>contenu direct</section>');
  });
  it('retourne null si vide/texte court', () => {
    expect(extractBody('')).toBeNull();
  });
});

describe('inlineFileImages', () => {
  it('remplace src file:// par data URI base64', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-'));
    const imgPath = path.join(dir, 'pic.png');
    // mini PNG 1x1 (header PNG valide suffit pour le test base64)
    const pngBytes = Buffer.from('89504e470d0a1a0a', 'hex');
    await fs.writeFile(imgPath, pngBytes);
    const html = `<img class="x" src="file://${imgPath}" alt="a">`;
    const out = await inlineFileImages(html);
    expect(out).toContain('data:image/png;base64,');
    expect(out).not.toContain('file://');
    expect(out).toContain('alt="a"');
  });

  it('gere les chemins absolus sans prefixe file://', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-'));
    const imgPath = path.join(dir, 'pic.png');
    await fs.writeFile(imgPath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const html = `<img src="${imgPath}">`;
    const out = await inlineFileImages(html);
    expect(out).toContain('data:image/png;base64,');
  });

  it('laisse le src tel quel si fichier absent', async () => {
    const html = '<img src="file:///nope/missing.png">';
    const out = await inlineFileImages(html);
    expect(out).toBe(html);
  });

  it('ignore les src http (non file)', async () => {
    const html = '<img src="https://x.com/a.png">';
    expect(await inlineFileImages(html)).toBe(html);
  });
});
