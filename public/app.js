const CATEGORIES = ['template', 'data', 'assets'];
const state = { template: [], data: [], assets: [] };

const generateBtn = document.getElementById('generateBtn');
const resetBtn = document.getElementById('resetBtn');
const genStatus = document.getElementById('genStatus');
const genWarnings = document.getElementById('genWarnings');
const genDiagnostic = document.getElementById('genDiagnostic');
const genPreview = document.getElementById('genPreview');
const previewFrame = document.getElementById('previewFrame');
const previewDownload = document.getElementById('previewDownload');
const previewOpen = document.getElementById('previewOpen');
const previewDelete = document.getElementById('previewDelete');
const historyEl = document.getElementById('history');

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(msg, kind) {
  genStatus.textContent = msg || '';
  genStatus.className = 'gen-status' + (kind ? ' ' + kind : '');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Builds a list of diagnostic messages in readable French from
 *  the stats. Level: 'ok' (green), 'info' (blue), 'warn' (orange), 'err' (red).
 *  No back-end message: everything is derived client-side from the JSON payload. */
/** Classifies a warning: true = REAL problem (data loss / broken
 *  render / failure) that should lower the score; false = informational (normal
 *  pipeline flow: quota/cascade, expected template page drop, table of contents,
 *  detected columns…). Conservative: we only penalize what is genuinely
 *  a defect. */
function isRealWarning(w) {
  const s = String(w || '');
  // Infos: normal flow → do NOT lower the score.
  const INFO = /quota|cascade|bascule|\b429\b|\b503\b|relais|^sommaire|intent-driven|cahiers? techniques|inference section|section reaffect|colonnes? cat[ée]gorie|^gemini\s*:|^allocator\s*:|audit gemini skip/i;
  if (INFO.test(s)) return false;
  // Real problems: data loss / failure / broken render.
  const REAL = /ignor[ée]|rejet|sans nom|invalide|non reconnu|illisible|corromp|introuvable|manquant|impossible|[ée]chec|exception|\berreur\b|chevauch|overflow|d[ée]bord|tronqu/i;
  return REAL.test(s);
}

/** Counts the real problems (rejected files + real lines/warnings). */
function countRealIssues(json) {
  const rejected = (json.rejectedFiles || []).length;
  const adapter = (json.adapterWarnings || []).filter(isRealWarning).length;
  const engine = (json.warnings || []).filter(isRealWarning).length;
  return rejected + adapter + engine;
}

/** Detects an expired Claude auth (notes + warnings). */
function claudeAuthExpired(json) {
  const notes = Array.isArray(json.claudeNotes) ? json.claudeNotes : [];
  const warns = Array.isArray(json.warnings) ? json.warnings : [];
  return [...notes, ...warns].some((n) => typeof n === 'string'
    && (/claude[^.]*\b(auth|401|expir)/i.test(n) || /authentication_error/i.test(n)));
}

/** V2 score /100, REAL and precise — sum of 5 weighted, transparent components:
 *  products 30 / images 20 / quality audit 30 / AI enrichment 10 / structure 10.
 *  The critical defects of the Gemini audit (e.g. product under the wrong section
 *  banner) genuinely drop the score. Also returns the breakdown (parts) to
 *  display it: the score is no longer a black box that always equals 100. */
function computeScore(json) {
  const s = json.stats || {};
  const productCount = json.productCount ?? 0;
  const matched = json.matchedImageCount ?? 0;
  const used = s.productsUsed ?? 0;
  const kept = s.pagesKept ?? 0;
  const tocEntries = s.tocEntriesWritten ?? 0;

  // Audit = Gemini (real, page by page) + Claude visual (optional).
  const gIssues = Array.isArray(json.geminiAuditIssues) ? json.geminiAuditIssues : [];
  const critical = gIssues.filter((i) => i.severity === 'critical').length
    + (s.visualAuditCriticalCount ?? 0);
  const minor = gIssues.filter((i) => i.severity && i.severity !== 'critical').length
    + (s.visualAuditMinorCount ?? 0);
  // Did the audit run? Not just "issues found": a CLEAN audit
  // (0 defects) must count as verified, otherwise we penalize a perfect page.
  // Reliable signal = the warning "audit Gemini : N issue(s) … sur M page(s)" emitted
  // by the orchestrator when the audit runs (≠ "skip" / "erreur").
  const warnsArr = Array.isArray(json.warnings) ? json.warnings : [];
  const geminiAuditRan = warnsArr.some((w) => typeof w === 'string'
    && /(audit|coherence) gemini\s*:\s*\d+\s*issue/i.test(w));
  const auditRan = gIssues.length > 0 || (s.visualAuditSampledCount ?? 0) > 0 || geminiAuditRan;
  const authExpired = claudeAuthExpired(json);

  const parts = [];

  // Products placed (30)
  parts.push({
    label: 'Produits placés', max: 30,
    earned: productCount > 0 ? 30 * (used / productCount) : 0,
    note: productCount > 0 ? `${used}/${productCount}` : 'aucun produit',
  });

  // Images matched (20)
  parts.push({
    label: 'Images appariées', max: 20,
    earned: productCount > 0 ? 20 * (matched / productCount) : 0,
    note: productCount > 0 ? `${matched}/${productCount}` : '—',
  });

  // Quality audit (30) — each critical −15, each minor −4. If the audit did
  // NOT run (quota/503), we CANNOT certify the quality → we don't grant
  // full points (12/30, "non vérifié"), which prevents a misleading 100.
  parts.push({
    label: 'Audit qualité', max: 30,
    earned: auditRan ? Math.max(0, 30 - 15 * critical - 4 * minor) : 12,
    note: !auditRan
      ? 'non vérifié (audit non lancé)'
      : ((critical || minor) ? `${critical} critique(s), ${minor} mineur(s)` : 'aucun défaut'),
  });

  // AI enrichment (10) — table of contents rewritten (5) + enrichment available (5).
  let ia = 0;
  if (tocEntries > 0) ia += 5;
  if (!authExpired) ia += 5;
  parts.push({
    label: 'Enrichissement IA', max: 10, earned: ia,
    note: authExpired ? 'auth Claude expirée' : (tocEntries > 0 ? 'sommaire + specs' : 'specs'),
  });

  // Page structure (10).
  parts.push({
    label: 'Structure pages', max: 10,
    earned: kept >= 2 ? 10 : kept * 5,
    note: `${kept} page(s) conservée(s)`,
  });

  // Penalties: engine errors (heavy) + real warnings (data loss,
  // broken render). Capped to stay readable.
  const errors = (json.orchestratorErrors || []).length;
  const realIssues = countRealIssues(json);
  const penaltyPoints = errors * 30 + Math.min(20, realIssues * 5);
  const penaltyReasons = [];
  if (errors > 0) penaltyReasons.push(`${errors} erreur(s) moteur`);
  if (realIssues > 0) penaltyReasons.push(`${realIssues} avertissement(s) réel(s)`);

  let score = parts.reduce((a, p) => a + p.earned, 0) - penaltyPoints;
  score = Math.round(Math.max(0, Math.min(100, score)));

  let label, level;
  if (score >= 85) { label = 'Excellent'; level = 'ok'; }
  else if (score >= 70) { label = 'Bon'; level = 'good'; }
  else if (score >= 50) { label = 'Partiel'; level = 'warn'; }
  else { label = 'Échec'; level = 'err'; }

  return {
    score, label, level,
    parts: parts.map((p) => ({ ...p, earned: Math.round(p.earned) })),
    penalty: { points: penaltyPoints, reasons: penaltyReasons },
  };
}

function buildDiagnostic(json) {
  const s = json.stats || {};
  const productCount = json.productCount ?? 0;
  const matched = json.matchedImageCount ?? 0;
  const items = [];

  // ─── Products placed ──────────────────────────────────────────────────
  const used = s.productsUsed ?? 0;
  const remaining = s.productsRemaining ?? 0;
  if (productCount === 0) {
    items.push({ level: 'err', msg: 'Aucun produit détecté dans la base.',
      detail: 'CSV/XLSX non reconnu, ou colonne nom/désignation absente.' });
  } else if (used === 0) {
    items.push({ level: 'err', msg: `0 / ${productCount} produit placé.`,
      detail: 'Le template ne correspond pas au format fiche produit attendu.' });
  } else if (used < productCount) {
    items.push({ level: 'warn', msg: `${used} / ${productCount} produits placés.`,
      detail: `${remaining} non placés — pas assez de pages substituables pour cette section.` });
  } else {
    items.push({ level: 'ok', msg: `${used} / ${productCount} produits placés.` });
  }

  // ─── Images matched ───────────────────────────────────────────────────
  if (productCount > 0 && matched < productCount) {
    items.push({ level: 'warn', msg: `${matched} / ${productCount} images appariées.`,
      detail: matched === 0
        ? 'Nomme les fichiers avec la référence produit, ou ajoute une colonne « image ».'
        : `${productCount - matched} produit(s) sans image (visuel template conservé).` });
  } else if (productCount > 0) {
    items.push({ level: 'ok', msg: `${matched} / ${productCount} images appariées.` });
  }

  // ─── Structure: pages kept + table of contents (merged) ───────────────
  const kept = s.pagesKept ?? 0;
  const deleted = s.pagesDeleted ?? 0;
  const tocEntries = s.tocEntriesWritten ?? 0;
  if (kept + deleted > 0) {
    const toc = tocEntries > 0 ? ` · sommaire : ${tocEntries} sections réécrites` : '';
    items.push({ level: 'info', msg: `${kept} page(s) conservée(s) sur ${kept + deleted}${toc}.`,
      detail: `${deleted} pages template non substituées supprimées.` });
  }

  // ─── Gemini quality audit: pages to verify (the real signal) ──────────
  const auditIssues = Array.isArray(json.geminiAuditIssues) ? json.geminiAuditIssues : [];
  if (auditIssues.length > 0) {
    const byPage = new Map();
    for (const iss of auditIssues) {
      const key = iss.page || (iss.pages && iss.pages[0]) || 0;
      if (!byPage.has(key)) byPage.set(key, []);
      byPage.get(key).push(iss);
    }
    const pageList = [...byPage.keys()].sort((a, b) => a - b);
    const critCount = auditIssues.filter((i) => i.severity === 'critical').length;
    const lines = pageList.map((pg) => {
      const reasons = byPage.get(pg).map((i) => {
        const sev = i.severity === 'critical' ? '🔴' : '🟡';
        return `${sev} ${i.category} — ${i.description}${i.productName ? ` (${i.productName})` : ''}`;
      });
      return `Page ${pg} :\n  ${reasons.join('\n  ')}`;
    });
    items.push({
      level: critCount > 0 ? 'err' : 'warn',
      msg: `Audit : ${pageList.length} page(s) à vérifier — ${auditIssues.length} défaut(s)`
        + `${critCount > 0 ? `, dont ${critCount} critique(s)` : ''}.`,
      detail: lines.join('\n'),
      tech: {
        cause: 'Audit visuel Gemini, page par page. Un défaut critique = produit affiché sous un '
          + 'bandeau de section qui ne lui correspond pas, chevauchement, ou produit manquant. '
          + 'Ces pages méritent une relecture humaine.',
        issues: auditIssues,
      },
    });
  }

  // ─── Gemini AI: models used (+ fallbacks) ─────────────────────────────
  const usage = json.geminiUsage;
  if (usage && usage.totalCalls > 0) {
    const short = (m) => String(m).replace(/^gemini-/, '').replace(/-preview$/, '');
    const detail = usage.byModelDetail || {};
    // Cascade order (best → fallback) for a meaningful display.
    const CASCADE = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemma-4-31b-it'];
    const rank = (m) => { const i = CASCADE.indexOf(m); return i < 0 ? 99 : i; };
    const models = Object.entries(usage.byModel || {}).sort((a, b) => rank(a[0]) - rank(b[0]));
    // Badge per model: ✓ if it responded, ⚠ if it only consumed quota.
    const badge = (m) => {
      const d = detail[m];
      if (!d) return '';
      if (d.quota > 0 && d.ok === 0) return ' ⚠';
      if (d.ok > 0) return ' ✓';
      return '';
    };
    const modelLabel = models.map(([m, c]) => `${short(m)} ×${c}${badge(m)}`).join(' · ');
    const stat = [`${usage.okCalls}/${usage.totalCalls} OK`];
    if (usage.calls429 > 0) stat.push(`${usage.calls429}× quota`);
    if (usage.fallbacks > 0) stat.push(`${usage.fallbacks} bascule(s)`);
    // Quota state PER model (technical block): which is exhausted vs healthy.
    const perModel = {};
    for (const [m, c] of models) {
      const d = detail[m];
      if (!d) { perModel[short(m)] = `${c} appel(s)`; continue; }
      const bits = [`${d.ok}/${d.calls} OK`];
      if (d.quota > 0) bits.push(`${d.quota}× quota`);
      const state = (d.quota > 0 && d.ok === 0) ? ' → épuisé (RPD)' : (d.ok > 0 ? ' → OK' : '');
      perModel[short(m)] = `${bits.join(' · ')}${state}`;
    }
    items.push({
      level: 'info',
      msg: `IA Gemini : ${modelLabel} (${stat.join(' · ')}).`,
      detail: usage.fallbacks > 0
        ? `${usage.fallbacks} bascule(s) automatique(s) : un pool de quota journalier (RPD) épuisé, relais par la cascade — l'enrichissement a tout de même abouti.`
        : undefined,
      tech: {
        stats: perModel,
        cause: 'Cascade qualité-d\'abord : 3.5-flash → 2.5-flash → 3.1-flash-lite → 2.5-flash-lite → '
          + 'Gemma → Claude. Chaque modèle a son quota journalier (RPD) propre ; sur épuisement (429) '
          + 'ou surcharge (503), bascule automatique au modèle suivant.',
      },
    });
  }

  // ─── Expired Claude auth (reduced enrichment) ─────────────────────────
  if (claudeAuthExpired(json)) {
    items.push({
      level: 'warn',
      msg: 'Auth Claude expirée — enrichissement réduit.',
      detail: 'Relance `claude login` sur le host, puis `docker compose restart`.',
      tech: { cause: 'La CLI Claude du container renvoie 401 (token OAuth périmé). Descriptions et audit Claude désactivés ; le rendu continue.' },
    });
  }

  // ─── Pipeline (duration, collapsible) ─────────────────────────────────
  const totalMs = (s.extractMs ?? 0) + (s.classifyMs ?? 0) + (s.allocateMs ?? 0)
    + (s.substituteMs ?? 0) + (s.renderMs ?? 0)
    + (s.specNormalizerMs ?? 0) + (s.valueFormatterMs ?? 0)
    + (s.visualAuditMs ?? 0) + (s.claudeAuditMs ?? 0);
  if (totalMs > 0) {
    items.push({
      level: 'info',
      msg: `Pipeline ${(totalMs / 1000).toFixed(1)}s.`,
      tech: {
        stats: {
          extractMs: s.extractMs, classifyMs: s.classifyMs, allocateMs: s.allocateMs,
          substituteMs: s.substituteMs, renderMs: s.renderMs,
        },
        cause: 'Durées par phase (ms). Extract = parse PDF ; substitute = génération des ops ; render = rastérisation finale.',
      },
    });
  }

  // ─── Orchestrator errors ──────────────────────────────────────────────
  for (const e of json.orchestratorErrors || []) {
    items.push({ level: 'err', msg: 'Erreur moteur V2', detail: e });
  }

  return items;
}

function renderDiagnosticItem(it) {
  const summary = `
    <span class="diag-dot" aria-hidden="true"></span>
    <span class="diag-msg">${escapeHtml(it.msg)}${it.detail ? `<span class="diag-detail">${escapeHtml(it.detail)}</span>` : ''}</span>
  `;
  if (!it.tech) {
    return `<li class="diag-${it.level}">${summary}</li>`;
  }
  const techHtml = renderDiagnosticTech(it.tech);
  return `
    <li class="diag-${it.level} diag-expandable">
      <details>
        <summary>${summary}<span class="diag-toggle" aria-hidden="true">▾</span></summary>
        <div class="diag-tech">${techHtml}</div>
      </details>
    </li>
  `;
}

function renderDiagnosticTech(tech) {
  const blocks = [];
  if (tech.stats && Object.keys(tech.stats).length) {
    const rows = Object.entries(tech.stats)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
      .join('');
    blocks.push(`<div class="diag-tech-block"><h4>Stats</h4><dl class="diag-stats">${rows}</dl></div>`);
  }
  if (tech.cause) {
    blocks.push(`<div class="diag-tech-block"><h4>Cause probable</h4><p>${escapeHtml(tech.cause)}</p></div>`);
  }
  if (tech.leviers && tech.leviers.length) {
    const items = tech.leviers.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
    blocks.push(`<div class="diag-tech-block"><h4>Leviers</h4><ul>${items}</ul></div>`);
  }
  return blocks.join('');
}

/** Score breakdown: 1 row per component (label · bar · points · note).
 *  Makes the score readable and "precise" — you see where the lost points come from. */
function renderScoreBreakdown(parts, penalty) {
  const rows = parts.map((p) => {
    const pct = p.max > 0 ? Math.round((100 * p.earned) / p.max) : 0;
    const lvl = pct >= 85 ? 'ok' : (pct >= 50 ? 'warn' : 'err');
    return `
      <div class="score-row">
        <span class="score-row-label">${escapeHtml(p.label)}</span>
        <span class="score-bar"><span class="score-bar-fill score-bar-${lvl}" style="width:${pct}%"></span></span>
        <span class="score-row-val">${p.earned}<span class="score-row-max">/${p.max}</span></span>
        <span class="score-row-note">${escapeHtml(p.note || '')}</span>
      </div>`;
  }).join('');
  // Penalty row (red) if real problems / errors have removed points.
  let penaltyRow = '';
  if (penalty && penalty.points > 0) {
    penaltyRow = `
      <div class="score-row score-row-penalty">
        <span class="score-row-label">Pénalités</span>
        <span class="score-bar"></span>
        <span class="score-row-val">−${penalty.points}</span>
        <span class="score-row-note">${escapeHtml(penalty.reasons.join(' · '))}</span>
      </div>`;
  }
  return `<div class="score-breakdown">${rows}${penaltyRow}</div>`;
}

function renderDiagnostic(json) {
  if (!json) {
    genDiagnostic.classList.add('hidden');
    genDiagnostic.innerHTML = '';
    return;
  }
  const items = buildDiagnostic(json);
  if (!items.length) {
    genDiagnostic.classList.add('hidden');
    genDiagnostic.innerHTML = '';
    return;
  }
  const score = computeScore(json);
  genDiagnostic.classList.remove('hidden');
  genDiagnostic.innerHTML = `
    <header class="diag-head">
      <h3>Diagnostic</h3>
      <span class="diag-score diag-score-${score.level}">
        <span class="diag-score-num">${score.score}</span><span class="diag-score-max">/100</span>
        <span class="diag-score-label">${score.label}</span>
      </span>
    </header>
    ${renderScoreBreakdown(score.parts, score.penalty)}
    <ul>${items.map(renderDiagnosticItem).join('')}</ul>
  `;
}

let previewPdfName = null;

function showPreview(url, name) {
  if (!url) {
    genPreview.classList.add('hidden');
    previewFrame.src = 'about:blank';
    previewPdfName = null;
    return;
  }
  previewFrame.src = url;
  previewDownload.href = url;
  previewDownload.setAttribute('download', name || '');
  previewOpen.href = url;
  previewPdfName = name || null;
  genPreview.classList.remove('hidden');
}

previewDelete.addEventListener('click', async () => {
  if (!previewPdfName) {
    showPreview(null);
    return;
  }
  if (!confirm(`Supprimer définitivement ${previewPdfName} ?`)) return;
  try {
    const res = await fetch(`/api/history?pdf=${encodeURIComponent(previewPdfName)}`, { method: 'DELETE' });
    if (!res.ok) {
      alert(`Échec de la suppression (HTTP ${res.status}).`);
      return;
    }
    if (pinnedSet.has(previewPdfName)) {
      pinnedSet.delete(previewPdfName);
      savePinned();
    }
    showPreview(null);
    loadHistory();
  } catch (err) {
    alert(`Échec de la suppression : ${err.message}`);
  }
});

/** Displays the warnings surfaced by the generation: rejected files,
 *  adapter warnings (ignored CSV/XLSX rows), PDF engine warnings. */
function renderWarnings({ rejectedFiles = [], adapterWarnings = [], engineWarnings = [] }) {
  // We split everything into 2 buckets: REAL problems (data loss / broken render,
  // which lowered the score) vs technical INFOS (normal flow). A
  // rejected file is always a real problem.
  const real = [];
  const info = [];
  for (const r of rejectedFiles) real.push(`Fichier rejeté : ${r.name} — ${r.reason}`);
  for (const w of [...adapterWarnings, ...engineWarnings]) {
    (isRealWarning(w) ? real : info).push(w);
  }
  if (!real.length && !info.length) {
    genWarnings.classList.add('hidden');
    genWarnings.innerHTML = '';
    return;
  }
  const li = (it) => `<li>${escapeHtml(it)}</li>`;
  const blocks = [];
  if (real.length) {
    blocks.push(`
      <details class="warn-block warn-real" open>
        <summary>⚠ Problèmes détectés (${real.length}) — impactent le score</summary>
        <ul>${real.map(li).join('')}</ul>
      </details>`);
  }
  if (info.length) {
    blocks.push(`
      <details class="warn-block">
        <summary>Détails techniques (${info.length}) — déroulé normal, sans impact</summary>
        <ul>${info.map(li).join('')}</ul>
      </details>`);
  }
  genWarnings.classList.remove('hidden');
  genWarnings.innerHTML = blocks.join('');
}

function renderZone(cat) {
  const list = document.querySelector(`.zone[data-category="${cat}"] .file-list`);
  list.innerHTML = state[cat]
    .map((f, i) => {
      const name = escapeHtml(f.name);
      return `
      <li>
        <span class="name" title="${name}">${name}</span>
        <span class="meta">${fmtSize(f.size)}</span>
        <button type="button" class="remove" data-cat="${cat}" data-idx="${i}" aria-label="Retirer">×</button>
      </li>`;
    })
    .join('');
}

function renderAll() {
  CATEGORIES.forEach(renderZone);
  // Generate enabled if we have template + data at minimum
  const ready = state.template.length > 0 && state.data.length > 0;
  generateBtn.disabled = !ready;
  updateEstimateDisplay(ready);
}

/** Displays the generation duration estimate (below the button). Honest: indicates
 *  whether the estimate is calibrated on history or bounded by default. */
let lastEstimateFetch = 0;
async function updateEstimateDisplay(ready) {
  const el = document.getElementById('genEstimate');
  if (!el) return;
  if (!ready) {
    el.textContent = '';
    el.classList.add('empty');
    return;
  }
  // Throttle: no more than 1 call every 2s
  const now = Date.now();
  if (now - lastEstimateFetch < 2000) return;
  lastEstimateFetch = now;
  try {
    const res = await fetch('/api/estimate?descriptions=true');
    if (!res.ok) throw new Error('http ' + res.status);
    const json = await res.json();
    const lowerS = Math.round(json.etaLowerMs / 1000);
    const upperS = Math.round(json.etaUpperMs / 1000);
    const suffix = json.source === 'calibrated'
      ? ` (basé sur ${json.sampleSize} générations)`
      : ' (estimation par défaut)';
    el.textContent = `≈ ${lowerS}–${upperS}s${suffix}`;
    el.classList.remove('empty');
  } catch {
    el.textContent = '';
    el.classList.add('empty');
  }
}

function bindZone(cat) {
  const zone = document.querySelector(`.zone[data-category="${cat}"]`);
  const drop = zone.querySelector('.drop');
  const input = drop.querySelector('input[type=file]');
  const browse = drop.querySelector('.browse');

  const ALLOWED_EXT = {
    template: ['.pdf'],
    data: ['.xlsx', '.xls', '.csv'],
    assets: ['.zip'],
  };
  function filterFiles(files) {
    const exts = ALLOWED_EXT[cat] || [];
    const ok = [];
    for (const f of files) {
      const ext = f.name.toLowerCase().slice(f.name.lastIndexOf('.'));
      if (exts.length === 0 || exts.includes(ext)) ok.push(f);
      else setStatus(`Fichier "${f.name}" ignoré (attendu : ${exts.join(', ')})`, 'error');
    }
    return ok;
  }
  browse.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    state[cat].push(...filterFiles(e.target.files));
    renderAll();
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    state[cat].push(...filterFiles(e.dataTransfer.files));
    renderAll();
  });
}

CATEGORIES.forEach(bindZone);

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove');
  if (!btn) return;
  const cat = btn.dataset.cat;
  const idx = Number(btn.dataset.idx);
  state[cat].splice(idx, 1);
  renderAll();
});

resetBtn.addEventListener('click', () => {
  CATEGORIES.forEach((c) => { state[c] = []; });
  setStatus('');
  renderWarnings({});
  renderDiagnostic(null);
  showPreview(null);
  renderAll();
  loadHistory();
});

// Progress bar: pct = max(elapsed time / average duration, backend pct).
// The bar advances CONTINUOUSLY (each 100ms tick = +0.55% on average over an
// 18s pipeline) while respecting the backend state: if the server reports
// 70% (toc phase), we jump there (forward jump). We NEVER go backward. It's
// an honest measure: "x% of the average time elapsed, and at least x% of the phases
// validated by the server". Capped at 99% until done=true, which snaps to 100.
const genProgress = document.getElementById('genProgress');
const genProgressFill = genProgress?.querySelector('.gen-progress-fill');
const genProgressPhase = genProgress?.querySelector('.gen-progress-phase');

// Average duration RECALIBRATED after the cascade optimization: ~4-5s with descriptions +
// audit (quota OK), ~0.7s if quota cold (short-circuit), up to ~13s on
// fresh quota (first calls slow). 8s = compromise; the bar never goes backward,
// cap 99%, and `done` snaps to 100 (so a fast gen finishes cleanly, a slow one
// waits at 99%).
const ESTIMATED_TOTAL_MS = 8000;
const POLL_INTERVAL_MS = 400;
const TICK_INTERVAL_MS = 100;
const STALL_THRESHOLD_MS = 25000;
let pollTimer = null;
let tickTimer = null;
let currentJobId = null;
let startedAt = 0;
let lastPhaseChangeAt = 0;
let lastPhase = '';
let backendPct = 0;
let displayedPct = 0;
let currentLabel = 'Initialisation…';

function genJobId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function renderBar() {
  if (genProgressFill) genProgressFill.style.width = `${displayedPct.toFixed(1)}%`;
  if (genProgressPhase) {
    // As soon as the bar maxes out (99%, we've exceeded the duration estimate), we
    // show "finalisation…" to reassure during the long steps (audit /
    // descriptions on fresh quota) before the snap to 100% of done.
    const tail = displayedPct >= 99 ? ' — finalisation…' : '';
    genProgressPhase.textContent = `${currentLabel}  ${Math.round(displayedPct)}%${tail}`;
  }
}

function tickProgress() {
  if (!startedAt) return;
  const elapsed = Date.now() - startedAt;
  const timePct = Math.min(99, (elapsed / ESTIMATED_TOTAL_MS) * 99);
  const next = Math.max(displayedPct, timePct, backendPct);
  if (next > displayedPct) {
    displayedPct = next;
    renderBar();
  }
}

let consecutive404 = 0;
async function pollProgressOnce() {
  if (!currentJobId) return;
  try {
    const r = await fetch(`/api/progress/${currentJobId}`, { cache: 'no-store' });
    if (!r.ok) {
      consecutive404++;
      // Backend not ready to track yet: if more than 2s (5 polls of 400ms)
      // without a response, we change the label to reassure rather than freeze.
      if (consecutive404 >= 5 && currentLabel === 'Préparation en cours…') {
        currentLabel = 'Envoi des fichiers au serveur…';
        renderBar();
      }
      return;
    }
    consecutive404 = 0;
    const s = await r.json();
    if (!s || typeof s.pct !== 'number') return;
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      lastPhaseChangeAt = Date.now();
    }
    if (s.pct > backendPct) backendPct = s.pct;
    if (s.message) currentLabel = s.message;
    tickProgress();
    if (!s.done && lastPhaseChangeAt && Date.now() - lastPhaseChangeAt > STALL_THRESHOLD_MS) {
      if (genProgressPhase) {
        genProgressPhase.textContent =
          `${currentLabel}  ${Math.round(displayedPct)}%  — étape longue, veuillez patienter…`;
      }
    }
  } catch {
    // Intermittent network: we let it pass, the next tick will retry.
  }
}

function startGenProgress(jobId) {
  if (!genProgress) return;
  currentJobId = jobId;
  startedAt = Date.now();
  lastPhase = '';
  lastPhaseChangeAt = Date.now();
  backendPct = 0;
  displayedPct = 0;
  consecutive404 = 0;
  currentLabel = 'Préparation en cours…';
  genProgress.classList.remove('hidden');
  genProgress.classList.remove('is-done');
  renderBar();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollProgressOnce, POLL_INTERVAL_MS);
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tickProgress, TICK_INTERVAL_MS);
  pollProgressOnce();
}

function stopGenProgress(success) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  currentJobId = null;
  if (!genProgress) return;
  if (success) {
    displayedPct = 100;
    backendPct = 100;
    currentLabel = 'Terminé';
    renderBar();
    // Freeze the shimmer + pulse animation to signal the end (cf. style.css).
    genProgress.classList.add('is-done');
  }
  setTimeout(() => {
    genProgress.classList.add('hidden');
    genProgress.classList.remove('is-done');
  }, success ? 600 : 0);
}

/** Attempts to extract a readable message from a backend error.
 *  The server typically returns {error: "Echec moteur de substitution: ..."}
 *  or a Python crash with a stack trace. We strip the paths and lines to
 *  keep just the type + error message. */
function humanizeError(raw) {
  if (!raw) return 'Erreur inconnue';
  let msg = String(raw);
  // Strip Python paths (/app/python/substitute.py:1234)
  msg = msg.replace(/\/[^\s]+\.py:\d+/g, '');
  // Strip "Traceback (most recent call last):" + lines
  msg = msg.replace(/Traceback[\s\S]*?(?=\w+Error:|\w+Exception:|$)/g, '');
  // Limit length
  if (msg.length > 300) msg = msg.slice(0, 300) + '…';
  return msg.trim();
}

generateBtn.addEventListener('click', async () => {
  const clientJobId = genJobId();
  const fd = new FormData();
  state.template.forEach((f) => fd.append('template', f));
  state.data.forEach((f) => fd.append('data', f));
  state.assets.forEach((f) => fd.append('assets', f));

  generateBtn.disabled = true;
  resetBtn.disabled = true;
  setStatus('Génération en cours…');
  renderWarnings({});
  renderDiagnostic(null);
  showPreview(null);
  startGenProgress(clientJobId);

  try {
    const abortCtrl = new AbortController();
    const fetchTimeout = setTimeout(() => abortCtrl.abort(), 10 * 60 * 1000); // 10 min max
    const res = await fetch(`/api/generate?jobId=${encodeURIComponent(clientJobId)}`, { method: 'POST', body: fd, signal: abortCtrl.signal });
    clearTimeout(fetchTimeout);
    // We always parse the JSON (success AND failure): on error the backend
    // may return partial warnings / diagnostic that are useful to display.
    let json = {};
    try { json = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok) {
      stopGenProgress(false);
      setStatus(`Échec de la génération : ${humanizeError(json.error) || `HTTP ${res.status}`}`, 'error');
      // Display what we have anyway: rejected files, adapter warnings
      // (xlsx reading), orchestrator warnings/errors. The user understands
      // WHERE it got stuck instead of just seeing a red message.
      renderWarnings({
        rejectedFiles: json.rejectedFiles || [],
        adapterWarnings: json.adapterWarnings || [],
        engineWarnings: [
          ...(json.orchestratorWarnings || []),
          ...(json.orchestratorErrors || []),
        ],
      });
      // Partial diagnostic: if we have at least productCount/matchedImageCount,
      // we can display the score and items even without a PDF.
      if (json.stats || json.productCount !== undefined) {
        renderDiagnostic({
          stats: json.stats || {},
          productCount: json.productCount ?? 0,
          matchedImageCount: json.matchedImageCount ?? 0,
          orchestratorErrors: json.orchestratorErrors || [],
        });
      }
      return;
    }
    const s = json.stats || {};
    // REAL duration measured client-side (from the POST until the response). More
    // reliable than the sum of the backend Ms which doesn't include all the
    // phases (e.g. Claude descriptions, upload, parse).
    const elapsedMs = startedAt ? Date.now() - startedAt : 0;
    const durationSec = (elapsedMs / 1000).toFixed(1);
    stopGenProgress(true);
    setStatus(`Génération terminée en ${durationSec}s.`, 'success');
    renderDiagnostic(json);
    renderWarnings({
      rejectedFiles: json.rejectedFiles || [],
      adapterWarnings: json.adapterWarnings || [],
      engineWarnings: json.warnings || [],
    });
    showPreview(json.catalogUrl, json.pdfName);
    loadHistory();
  } catch (err) {
    stopGenProgress(false);
    const msg = err.name === 'AbortError'
      ? 'Délai dépassé (10 min). Le serveur ne répond plus.'
      : humanizeError(err.message);
    setStatus(`Échec de la génération : ${msg}`, 'error');
  } finally {
    renderAll();
    resetBtn.disabled = false;
  }
});

// ─── Pinning (localStorage) ──────────────────────────────────
// Pinned catalogs are always at the top of the history and exempt
// from the collapse. Client-side persistence only (no backend).
const PINNED_KEY = 'pinnedCatalogs';
const pinnedSet = new Set((() => {
  try { return JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'); }
  catch { return []; }
})());

function savePinned() {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...pinnedSet]));
}

function togglePinned(pdf) {
  if (pinnedSet.has(pdf)) pinnedSet.delete(pdf);
  else pinnedSet.add(pdf);
  savePinned();
}

function historyItemHtml(it) {
  const name = escapeHtml(it.pdfName);
  const url = escapeHtml(it.pdfUrl);
  const isPinned = pinnedSet.has(it.pdfName);
  const pinTitle = isPinned ? 'Désépingler' : 'Épingler';
  return `
    <li class="${isPinned ? 'is-pinned' : ''}">
      <button type="button" class="history-pin ${isPinned ? 'pinned' : ''}" data-pin="${name}" title="${pinTitle}" aria-label="${pinTitle}">
        <svg viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 17v5"/>
          <path d="M5 17h14l-1.5-6a3 3 0 0 1 1-3l1-1a2 2 0 0 0 .4-2.3L19 3H5L3.1 4.7A2 2 0 0 0 3.5 7l1 1a3 3 0 0 1 1 3z"/>
        </svg>
      </button>
      <span class="history-name" title="${name}">${name}</span>
      <span class="history-meta">${fmtSize(it.sizeBytes)} · ${new Date(it.createdAt).toLocaleString('fr-FR')}</span>
      <a class="history-open" href="${url}" target="_blank" rel="noopener">Ouvrir</a>
      <button type="button" class="history-del" data-pdf="${name}">Supprimer</button>
    </li>`;
}

const HISTORY_VISIBLE_REST = 3;

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const json = await res.json();
    const items = (json.items || []).slice(0, 30);
    if (!items.length) {
      historyEl.classList.add('hidden');
      historyEl.innerHTML = '';
      return;
    }
    historyEl.classList.remove('hidden');

    // Pinned ones always at the top and always visible; the collapse only applies
    // to the rest (beyond HISTORY_VISIBLE_REST).
    const pinned = items.filter((it) => pinnedSet.has(it.pdfName));
    const rest = items.filter((it) => !pinnedSet.has(it.pdfName));
    const restVisible = rest.slice(0, HISTORY_VISIBLE_REST);
    const restHidden = rest.slice(HISTORY_VISIBLE_REST);
    const hasHidden = restHidden.length > 0;

    historyEl.innerHTML = `
      <div class="history-header">
        <h2>Catalogues générés</h2>
        <button type="button" class="history-clear" id="histClear">Vider l'historique</button>
      </div>
      <ul class="history-list">
        ${[...pinned, ...restVisible].map(historyItemHtml).join('')}
      </ul>
      ${hasHidden ? `
        <div class="history-collapse collapsed" id="historyCollapse">
          <ul class="history-list history-list-hidden">
            ${restHidden.map(historyItemHtml).join('')}
          </ul>
        </div>
        <button type="button" class="history-toggle" id="historyToggleBtn" aria-expanded="false">
          <span class="history-toggle-label">Afficher les ${restHidden.length} autres</span>
          <span class="history-toggle-icon" aria-hidden="true">▾</span>
        </button>
      ` : ''}
    `;
  } catch (err) {
    historyEl.classList.remove('hidden');
    historyEl.innerHTML = `<p style="color:var(--danger);font-size:.82rem">Impossible de charger l'historique : ${escapeHtml(err.message)}</p>`;
  }
}

// Delegation: a single listener for pin / del / clear / toggle.
historyEl.addEventListener('click', async (e) => {
  const pinBtn = e.target.closest('.history-pin');
  if (pinBtn) {
    const pdf = pinBtn.dataset.pin;
    if (pdf) {
      togglePinned(pdf);
      loadHistory();
    }
    return;
  }
  const delBtn = e.target.closest('.history-del');
  if (delBtn) {
    const pdf = delBtn.dataset.pdf;
    if (!pdf) return;
    if (!confirm(`Supprimer définitivement ${pdf} ?`)) return;
    const res = await fetch(`/api/history?pdf=${encodeURIComponent(pdf)}`, { method: 'DELETE' });
    if (res.ok) {
      if (pinnedSet.has(pdf)) {
        pinnedSet.delete(pdf);
        savePinned();
      }
      loadHistory();
    }
    return;
  }
  if (e.target.closest('#histClear')) {
    // Retrieves the real list to compute the exact counts (the pinnedSet
    // may contain stale entries pointing to already-deleted catalogs — we
    // take the opportunity to clean up).
    const list = await fetch('/api/history').then((r) => r.json()).catch(() => ({ items: [] }));
    const items = list.items || [];
    const existing = new Set(items.map((it) => it.pdfName));
    let stale = false;
    for (const p of [...pinnedSet]) {
      if (!existing.has(p)) { pinnedSet.delete(p); stale = true; }
    }
    if (stale) savePinned();

    const keep = items.filter((it) => pinnedSet.has(it.pdfName));
    const toDelete = items.filter((it) => !pinnedSet.has(it.pdfName));
    if (!toDelete.length) {
      alert('Tous les catalogues sont épinglés. Désépingle-en avant de vider.');
      return;
    }
    const msg = keep.length > 0
      ? `Supprimer ${toDelete.length} catalogue${toDelete.length > 1 ? 's' : ''} ? (${keep.length} épinglé${keep.length > 1 ? 's' : ''} préservé${keep.length > 1 ? 's' : ''})`
      : `Supprimer définitivement les ${toDelete.length} catalogues générés ?`;
    if (!confirm(msg)) return;

    if (keep.length > 0) {
      await Promise.all(toDelete.map((it) =>
        fetch(`/api/history?pdf=${encodeURIComponent(it.pdfName)}`, { method: 'DELETE' }),
      ));
    } else {
      const res = await fetch('/api/history', { method: 'DELETE' });
      if (!res.ok) return;
    }
    loadHistory();
    return;
  }
  const toggleBtn = e.target.closest('#historyToggleBtn');
  if (toggleBtn) {
    const collapse = document.getElementById('historyCollapse');
    if (!collapse) return;
    const isCollapsed = collapse.classList.toggle('collapsed');
    const label = toggleBtn.querySelector('.history-toggle-label');
    const hiddenCount = collapse.querySelectorAll('li').length;
    if (label) label.textContent = isCollapsed ? `Afficher les ${hiddenCount} autres` : 'Masquer';
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
  }
});

renderAll();
loadHistory();
