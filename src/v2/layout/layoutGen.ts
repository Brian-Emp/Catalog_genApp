/**
 * Catalog page layout generation VIA Gemini Pro (POC).
 *
 * Paradigm: instead of SUBSTITUTING into a fixed PDF template, we ask
 * gemini-2.5-pro (CLI, subscription) to COMPOSE a product page from scratch
 * in HTML/CSS. The HTML is then rendered to PDF via headless Chromium
 * (cf htmlToPdf.ts).
 *
 * Why Pro: page layout is a reasoning task (visual hierarchy, balance,
 * legibility) where Pro excels vs flash. It's also THE justification for the
 * Gemini CLI (Pro unlocked by the subscription).
 *
 * Why HTML/CSS: Pro's native format (generates clean HTML effortlessly),
 * faithfully rendered by Chromium, rich ecosystem. Cf POC decision.
 */

import { callGeminiCli, GEMINI_CLI_MODELS } from '../gemini/cliClient';

export interface LayoutProductSpec {
  key: string;
  value: string;
}

export interface LayoutProduct {
  name: string;
  ref: string | null;
  /** Absolute path of the product image (asset). Injected as <img> by Pro. */
  imagePath?: string | null;
  specs: LayoutProductSpec[];
}

export interface LayoutPageInput {
  /** Section title shown at the top (e.g. "EAUX CLAIRES"). */
  sectionTitle: string;
  products: LayoutProduct[];
  /** Optional dominant color scheme (hex) for catalog cohesion. */
  accentColor?: string;
}

export interface LayoutGenResult {
  ok: boolean;
  html?: string;
  error?: string;
  durationMs: number;
}

export interface LayoutGenOptions {
  model?: string;
  timeoutMs?: number;
  workDir?: string;
  /**
   * Shared CSS (extracted from a 1st reference page). If provided, Pro
   * generates ONLY the <body> conforming to this CSS, and we assemble the
   * document with this <style> verbatim → visual consistency across all pages.
   */
  sharedCss?: string;
  /** Current page number (global numbering). */
  pageNumber?: number;
  /** Total number of pages (for "page X / Y"). */
  totalPages?: number;
}

/**
 * Generates the complete HTML/CSS of an A4 product page via Pro.
 */
export async function generateLayoutHtml(
  input: LayoutPageInput,
  opts: LayoutGenOptions = {},
): Promise<LayoutGenResult> {
  const t0 = Date.now();
  if (input.products.length === 0) {
    return { ok: false, error: 'aucun produit', durationMs: 0 };
  }

  // Consistent mode: shared CSS provided → Pro generates only the <body>, we assemble.
  const sharedMode = Boolean(opts.sharedCss);
  const prompt = sharedMode
    ? buildBodyPrompt(input, opts.sharedCss!, opts.pageNumber, opts.totalPages)
    : buildLayoutPrompt(input, opts.pageNumber, opts.totalPages);
  const res = await callGeminiCli({
    prompt,
    model: opts.model ?? GEMINI_CLI_MODELS.pro,
    timeoutMs: opts.timeoutMs ?? 120_000,
    workDir: opts.workDir,
    module: 'layoutGen',
  });
  if (!res.ok || !res.text) {
    return { ok: false, error: res.error ?? 'reponse vide', durationMs: Date.now() - t0 };
  }

  if (sharedMode) {
    const body = extractBody(res.text);
    if (!body) {
      return { ok: false, error: 'aucun body extrait', durationMs: Date.now() - t0 };
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${opts.sharedCss}</style></head><body>${body}</body></html>`;
    return { ok: true, html, durationMs: Date.now() - t0 };
  }

  const html = extractHtml(res.text);
  if (!html) {
    return { ok: false, error: 'aucun HTML extrait de la reponse', durationMs: Date.now() - t0 };
  }
  return { ok: true, html, durationMs: Date.now() - t0 };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function footerText(pageNumber?: number, totalPages?: number): string {
  if (pageNumber && totalPages) return `${pageNumber} / ${totalPages}`;
  if (pageNumber) return `${pageNumber}`;
  return '';
}

function buildLayoutPrompt(input: LayoutPageInput, pageNumber?: number, totalPages?: number): string {
  const accent = input.accentColor ?? '#0095c8';
  const foot = footerText(pageNumber, totalPages);
  const productsBlock = input.products
    .map((p, i) => {
      const specs = p.specs.map((s) => `      - ${s.key} : ${s.value}`).join('\n');
      const img = p.imagePath ? `\n    image (chemin absolu, a mettre dans <img src="file://${p.imagePath}">) : ${p.imagePath}` : '\n    image : aucune';
      return `  PRODUIT ${i + 1} :
    nom : ${p.name}
    reference : ${p.ref ?? '(aucune)'}${img}
    specifications :
${specs}`;
    })
    .join('\n\n');

  return `Tu es un designer de catalogue produit BtoB. Genere le HTML/CSS COMPLET d'UNE page A4 (210x297mm) presentant les produits ci-dessous.

SECTION : ${input.sectionTitle}
COULEUR D'ACCENT : ${accent}

${productsBlock}

CONTRAINTES DE MISE EN PAGE :
- IMPERATIF ABSOLU : TOUT le contenu doit tenir sur UNE SEULE page A4. JAMAIS de debordement sur une 2e page. Si beaucoup de specs, reduis les tailles de police / interlignes / hauteur d'image pour que ca rentre. Hauteur utile max ~273mm.
- Le body doit avoir height: 273mm; overflow: hidden; pour garantir l'absence de 2e page. Repartis le contenu verticalement (pas de grand vide : si peu de contenu, aere ; si beaucoup, compacte).
- Page A4 portrait, marges ~12mm. Utilise @page { size: A4; margin: 12mm; } et un body en mm/px coherent.
- En-tete : titre de section "${input.sectionTitle}" aligne, dans la couleur d'accent, avec un filet horizontal.
- Produits disposes en colonnes (1 colonne par produit, cote a cote si 2-3 produits ; sinon grille).
- Pour CHAQUE produit : UN SEUL bloc vertical COMPACT et CONTIGU contenant, dans cet ordre serre (sans espace vide entre eux) : image (si fournie, via <img src="file://...">, object-fit: contain, hauteur ~160px), nom en gras, reference en plus petit/gris, PUIS IMMEDIATEMENT son TABLEAU de specifications (cle a gauche en gris, valeur a droite en noir). Le tableau de specs doit etre COLLE sous le produit, JAMAIS relegue en bas de page. Les colonnes produit sont alignees en haut (align-items: flex-start).
- Typographie pro et sobre : sans-serif (Arial/Helvetica), tailles hierarchisees, interlignage aere.
- Pied de page discret avec le numero de page${foot ? ` "${foot}"` : ''}.
- AUCUN texte marketing invente : utilise UNIQUEMENT les donnees fournies.
- Le rendu doit etre PRET A IMPRIMER : couleurs douces, contraste suffisant, pas de debordement.

SORTIE : reponds UNIQUEMENT le code HTML complet (<!DOCTYPE html> ... </html>) avec le CSS dans une balise <style>. AUCUN texte avant/apres, AUCUN bloc markdown.`;
}

/**
 * CONSISTENT-mode prompt: the CSS is already fixed (shared across pages). Pro
 * only generates the <body> content, reusing the classes already defined in
 * the provided CSS. Guarantees an identical style on all pages.
 */
function buildBodyPrompt(
  input: LayoutPageInput,
  sharedCss: string,
  pageNumber?: number,
  totalPages?: number,
): string {
  const foot = footerText(pageNumber, totalPages);
  const productsBlock = input.products
    .map((p, i) => {
      const specs = p.specs.map((s) => `      - ${s.key} : ${s.value}`).join('\n');
      const img = p.imagePath ? `\n    image : <img src="file://${p.imagePath}">` : '\n    image : aucune';
      return `  PRODUIT ${i + 1} :
    nom : ${p.name}
    reference : ${p.ref ?? '(aucune)'}${img}
    specifications :
${specs}`;
    })
    .join('\n\n');

  return `Tu composes le CONTENU d'une page de catalogue. Le CSS (design system) est DEJA defini ci-dessous et FIXE — tu ne le modifies pas, tu REUTILISES ses classes.

CSS EXISTANT (ne pas reproduire, juste utiliser ses classes) :
${sharedCss}

SECTION : ${input.sectionTitle}
${foot ? `NUMERO DE PAGE : ${foot}` : ''}

${productsBlock}

CONSIGNE : genere UNIQUEMENT le contenu HTML du <body> (sans <html>, sans <head>, sans <style>, sans <body>), en utilisant EXACTEMENT les memes classes/structure que celles attendues par le CSS ci-dessus (en-tete de section, colonnes produit, image, nom, reference, tableau de specs, pied de page). Reutilise la meme structure que les autres pages pour une coherence parfaite.

IMPERATIF : le contenu doit tenir sur UNE SEULE page A4 (pas de debordement sur une 2e page).

Images : <img src="file://CHEMIN"> avec le chemin exact fourni.
Donnees : UNIQUEMENT celles fournies, aucun texte invente.

SORTIE : UNIQUEMENT le HTML interne du body. AUCun <style>, AUCun markdown, AUCun texte avant/apres.`;
}

/** Extracts the content of a <body>...</body>, or the raw HTML if there is no
 *  body. Exported for testing. */
export function extractBody(text: string): string | null {
  let t = text.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = t.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1].trim();
  // Pro may have returned the inner content directly (without <body>).
  if (/<\w+[\s>]/.test(t) && t.length > 20) return t;
  return null;
}

/** Extracts the <style>...</style> block (CSS content) from an HTML. Exported for testing. */
export function extractStyleBlock(html: string): string | null {
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return m ? m[1].trim() : null;
}

/**
 * Extracts the HTML from a CLI response: strips any markdown fences, isolates
 * from <!DOCTYPE/<html> to </html>. Exported for testing.
 */
export function extractHtml(text: string): string | null {
  let t = text.trim();
  // Strip fences ```html ... ```
  t = t.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Isolate the doctype/html if stray text surrounds it
  const lower = t.toLowerCase();
  const startDoctype = lower.indexOf('<!doctype');
  const startHtml = lower.indexOf('<html');
  const start = startDoctype >= 0 ? startDoctype : startHtml;
  const endIdx = lower.lastIndexOf('</html>');
  if (start >= 0 && endIdx > start) {
    return t.slice(start, endIdx + '</html>'.length);
  }
  // Fallback: if it looks like HTML (contains tags), return it as-is
  if (/<\w+[\s>]/.test(t) && t.length > 50) return t;
  return null;
}
