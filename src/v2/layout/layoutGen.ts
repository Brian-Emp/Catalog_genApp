/**
 * Génération de layout de page catalogue VIA Gemini Pro (POC).
 *
 * Paradigme : au lieu de SUBSTITUER dans un template PDF figé, on demande a
 * gemini-2.5-pro (CLI, abonnement) de COMPOSER une page produit from scratch
 * en HTML/CSS. Le HTML est ensuite rendu en PDF via Chromium headless
 * (cf htmlToPdf.ts).
 *
 * Pourquoi Pro : la mise en page est une tache de raisonnement (hierarchie
 * visuelle, equilibre, lisibilite) ou` Pro excelle vs flash. C'est aussi LA
 * justification du CLI Gemini (Pro debloque par l'abonnement).
 *
 * Pourquoi HTML/CSS : format natif de Pro (genere du HTML propre sans effort),
 * rendu fidele par Chromium, ecosysteme riche. Cf decision POC.
 */

import { callGeminiCli, GEMINI_CLI_MODELS } from '../gemini/cliClient';

export interface LayoutProductSpec {
  key: string;
  value: string;
}

export interface LayoutProduct {
  name: string;
  ref: string | null;
  /** Chemin absolu de l'image produit (asset). Injectee en <img> par Pro. */
  imagePath?: string | null;
  specs: LayoutProductSpec[];
}

export interface LayoutPageInput {
  /** Titre de section affiche en tete (ex "EAUX CLAIRES"). */
  sectionTitle: string;
  products: LayoutProduct[];
  /** Charte couleur dominante (hex) optionnelle pour cohesion catalogue. */
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
   * CSS partage (extrait d'une 1ere page de reference). Si fourni, Pro genere
   * UNIQUEMENT le <body> conforme a ce CSS, et on assemble le document avec ce
   * <style> verbatim → coherence visuelle garantie entre toutes les pages.
   */
  sharedCss?: string;
  /** Numero de page courant (numerotation globale). */
  pageNumber?: number;
  /** Nombre total de pages (pour "page X / Y"). */
  totalPages?: number;
}

/**
 * Genere le HTML/CSS complet d'une page produit A4 via Pro.
 */
export async function generateLayoutHtml(
  input: LayoutPageInput,
  opts: LayoutGenOptions = {},
): Promise<LayoutGenResult> {
  const t0 = Date.now();
  if (input.products.length === 0) {
    return { ok: false, error: 'aucun produit', durationMs: 0 };
  }

  // Mode coherent : CSS partage fourni → Pro genere le <body> seul, on assemble.
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
 * Prompt mode COHERENT : le CSS est deja fixe (partage entre pages). Pro ne
 * genere que le contenu <body>, en reutilisant les classes deja definies dans
 * le CSS fourni. Garantit un style identique sur toutes les pages.
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

/** Extrait le contenu d'un <body>...</body>, ou le HTML brut si pas de body.
 *  Exporte pour test. */
export function extractBody(text: string): string | null {
  let t = text.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = t.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1].trim();
  // Pro a peut-etre renvoye directement le contenu interne (sans <body>).
  if (/<\w+[\s>]/.test(t) && t.length > 20) return t;
  return null;
}

/** Extrait le bloc <style>...</style> (contenu CSS) d'un HTML. Exporte pour test. */
export function extractStyleBlock(html: string): string | null {
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return m ? m[1].trim() : null;
}

/**
 * Extrait le HTML d'une reponse CLI : strip fences markdown eventuels, isole
 * du <!DOCTYPE/<html> jusqu'a </html>. Exporte pour test.
 */
export function extractHtml(text: string): string | null {
  let t = text.trim();
  // Strip fences ```html ... ```
  t = t.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Isoler le doctype/html si du texte parasite entoure
  const lower = t.toLowerCase();
  const startDoctype = lower.indexOf('<!doctype');
  const startHtml = lower.indexOf('<html');
  const start = startDoctype >= 0 ? startDoctype : startHtml;
  const endIdx = lower.lastIndexOf('</html>');
  if (start >= 0 && endIdx > start) {
    return t.slice(start, endIdx + '</html>'.length);
  }
  // Fallback : si ca ressemble a du HTML (contient des balises), retourner tel quel
  if (/<\w+[\s>]/.test(t) && t.length > 50) return t;
  return null;
}
