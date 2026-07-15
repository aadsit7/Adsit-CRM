// ============================================================
// Admin Forecast View
// ============================================================
// Pick an opportunity; Randy scores a visual sales-stage board from the
// opportunity's Opportunity_Descriptions notes (the evidence base) and,
// as weak context, its Drive document list. The board shows which stages
// are complete, which exit criteria are met, and — the whole point — the
// evidence quote behind each checkmark, with a link to the source note.
//
// Purely additive: no changes to admin-opportunities.js / ai.js /
// sheets.js / randy.js. The pipeline (prompt → client → schema) mirrors
// the timeline-PDF flow; the source-note link reuses openOppDetailsModal.
// ============================================================

import { readSheetAsObjects, appendRow, addDemoRow, isConfigured } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, $, uuid } from '../utils/dom.js';
import { formatDate, todayISO, nowISO } from '../utils/date.js';
import { setTopbarTitle } from '../components/sidebar.js';
import { showToast } from '../components/toast.js';
import { filterOpportunities } from '../utils/filters.js';
import { listEntityDocuments } from '../components/documents-panel.js';
import { ensureHtml } from '../components/quill-editor.js';
import { fileApiRequest } from '../utils/file-api.js';
import { createPill, updatePillStage, markPillSuccess, markPillFailure, destroyPill } from '../components/map-pdf-pill.js';
import { requestForecastJson } from '../utils/forecast-client.js';
import { deriveForecastBoard } from '../utils/forecast-stages.js';
import { buildForecastPdf, forecastFilename } from '../utils/forecast-pdf-builder.js';
import { openOppDetailsModal } from './admin-opportunities.js';

// ── Module state (torn down in cleanup) ─────────────────────────────
let allOpps = [];
let selectedOppId = '';
let currentController = null;   // aborts an in-flight forecast request
let currentPill = null;         // the active progress pill

function abortInflight() {
  if (currentController) { try { currentController.abort(); } catch { /* ignore */ } currentController = null; }
  if (currentPill) { try { destroyPill(currentPill); } catch { /* ignore */ } currentPill = null; }
}

export async function render(container) {
  setTopbarTitle('Analyzer');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    const opportunities = await readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES);
    allOpps = filterOpportunities(opportunities)
      .filter(o => o.opportunity_id)
      .sort((a, b) => {
        const ca = String(a.customer_name || '').toLowerCase();
        const cb = String(b.customer_name || '').toLowerCase();
        if (ca !== cb) return ca < cb ? -1 : 1;
        return String(a.deal_name || '').toLowerCase() < String(b.deal_name || '').toLowerCase() ? -1 : 1;
      });
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Could not load opportunities'),
      el('div', { class: 'empty-state__description' }, err.message || 'Try reloading the page.'),
    ));
    return;
  }

  mount(container, buildView());
}

export function cleanup() {
  abortInflight();
  selectedOppId = '';
}

// ── View shell ──────────────────────────────────────────────────────
function buildView() {
  const select = el('select', {
    class: 'form-select forecast__select',
    onChange: (e) => { selectedOppId = e.target.value; analyzeBtn.disabled = !selectedOppId; },
  },
    el('option', { value: '' }, 'Select an opportunity…'),
    ...allOpps.map(o => el('option', { value: o.opportunity_id },
      `${o.customer_name || 'Unknown'} — ${o.deal_name || 'Untitled deal'}`,
    )),
  );
  if (selectedOppId) select.value = selectedOppId;

  const analyzeBtn = el('button', {
    class: 'btn btn--primary forecast__analyze',
    disabled: !selectedOppId,
    onClick: () => runForecast(),
  }, 'Analyze with Randy');

  const resultSlot = el('div', { class: 'forecast__result' }, buildIntroEmptyState());

  const view = el('div', { class: 'forecast' },
    el('div', { class: 'forecast__controls' },
      el('label', { class: 'forecast__control' },
        el('span', { class: 'forecast__control-label' }, 'Opportunity'),
        select,
      ),
      analyzeBtn,
    ),
    resultSlot,
  );

  // Stash references the async flow needs.
  view.__refs = { select, analyzeBtn, resultSlot };
  return view;
}

function buildIntroEmptyState() {
  return el('div', { class: 'empty-state forecast__intro' },
    el('div', { class: 'empty-state__title' }, 'Build a forecast board'),
    el('div', { class: 'empty-state__description' },
      'Pick an opportunity and Randy will score its sales stages from the deal’s notes — '
      + 'showing which exit criteria are met and the evidence behind each one.'),
  );
}

// Oldest-note-first comparator, shared by the initial evidence sort and the
// re-sort after freshly-analyzed document notes are folded into the list.
function byDescriptionDateAsc(a, b) {
  return new Date(a.description_date || a.created_at) - new Date(b.description_date || b.created_at);
}

// ── The run ─────────────────────────────────────────────────────────
// Pass an explicit opp to score that exact deal (used by the coverage
// banner's re-run so it can't drift to whatever the dropdown now shows);
// with no argument it scores the current dropdown selection.
async function runForecast(explicitOpp = null) {
  const view = $('.forecast');
  if (!view || !view.__refs) return;
  const { resultSlot, analyzeBtn } = view.__refs;

  const opp = explicitOpp || allOpps.find(o => o.opportunity_id === selectedOppId);
  if (!opp) { showToast('Pick an opportunity first', 'error'); return; }

  abortInflight();
  analyzeBtn.disabled = true;
  resultSlot.replaceChildren(el('div', { class: 'forecast__loading' },
    el('div', { class: 'spinner' }),
    el('span', {}, 'Reading the notes…'),
  ));

  const controller = new AbortController();
  currentController = controller;
  const pill = createPill('Reading the notes…', { label: opp.customer_name || opp.deal_name || 'Analyzer' });
  currentPill = pill;

  try {
    // Load evidence base + document list in parallel.
    const [descAll, documents] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_OPP_DESCRIPTIONS),
      listEntityDocuments(opp.opportunity_id).catch(() => []),
    ]);
    const descriptions = descAll
      .filter(d => d.opportunity_id === opp.opportunity_id)
      .sort(byDescriptionDateAsc);

    // Read the attachments BEFORE scoring. A document that hasn't been
    // analyzed is invisible to Randy — only note text is scored — so we
    // extract each un-analyzed document into a note first, then score with
    // the complete evidence base. This enforces the "analyze the documents,
    // then and only then follow the rest of the instructions" contract, so
    // the very first board a rep sees already reflects every attachment.
    //
    // Failures are non-fatal: Randy still scores on whatever succeeded, and
    // the coverage banner is left to name only the documents that genuinely
    // could not be read (a failed doc keeps its .analyzed flag untouched).
    const unread = documents.filter(d => String(d.analyzed || '').toUpperCase() !== 'TRUE');
    for (let i = 0; i < unread.length; i++) {
      if (controller.signal.aborted) return;
      updatePillStage(pill, `Reading document ${i + 1} of ${unread.length}…`);
      try {
        descriptions.push(await analyzeOneDocument(unread[i], opp));
      } catch (docErr) {
        console.warn('[Forecast] document analysis failed', unread[i]?.file_name, docErr);
      }
    }
    if (unread.length) descriptions.sort(byDescriptionDateAsc);

    if (controller.signal.aborted) return;

    updatePillStage(pill, 'Randy is scoring the stages…');

    const forecast = await requestForecastJson(opp, descriptions, documents, controller.signal);

    if (controller.signal.aborted) return;
    markPillSuccess(pill, 'Forecast ready');
    if (currentPill === pill) currentPill = null;
    if (currentController === controller) currentController = null;

    const board = deriveForecastBoard(forecast);
    resultSlot.replaceChildren(renderForecastBoard({ forecast, board, opp, descriptions, documents }));
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('[Forecast] failed', err);
    markPillFailure(pill, 'Forecast failed');
    if (currentPill === pill) currentPill = null;
    if (currentController === controller) currentController = null;
    resultSlot.replaceChildren(el('div', { class: 'empty-state forecast__error' },
      el('div', { class: 'empty-state__title' }, 'Randy could not build the board'),
      el('div', { class: 'empty-state__description' }, err.message || 'Something went wrong. Try again.'),
    ));
  } finally {
    // Only restore the button if this run still owns it. A superseding run
    // (or an explicit abort) takes over the button state, so a late-
    // resolving aborted run must not re-enable it mid-flight.
    if (currentController === controller || currentController === null) {
      analyzeBtn.disabled = !selectedOppId;
    }
  }
}

// ── Render ──────────────────────────────────────────────────────────
function renderForecastBoard({ forecast, board, opp, descriptions, documents }) {
  const frag = el('div', { class: 'forecast-board' });

  // Toolbar: export the board to a two-page, print-ready PDF.
  frag.appendChild(buildBoardActions({ forecast, board, opp }));

  // Coverage banner (honesty pass): documents Randy could not read.
  const banner = buildCoverageBanner(documents, opp);
  if (banner) frag.appendChild(banner);

  frag.appendChild(buildSummary(forecast, board));

  // The stage grid lives in a horizontal scroller so the chevrons keep
  // their width and the board scrolls on narrow screens.
  frag.appendChild(el('div', { class: 'forecast-board__scroll' },
    buildBoardGrid({ board, opp, descriptions }),
  ));

  // Gaps + open questions sit directly under the stage board (where the
  // buying-process bands used to be), as tickable working checklists.
  frag.appendChild(buildLists(forecast));

  return frag;
}

// ── PDF export toolbar ──────────────────────────────────────────────
// A "Create PDF" button that renders the board to a two-page, Recast-
// branded PDF (js/utils/forecast-pdf-builder.js) and downloads it. The
// board passed here is the exact one the DOM was rendered from, so the
// PDF can't drift from what's on screen.
function buildBoardActions({ forecast, board, opp }) {
  const btn = el('button', {
    class: 'btn btn--secondary btn--sm forecast-board__pdf-btn',
    type: 'button',
  }, el('span', { class: 'forecast-board__pdf-icon', html: pdfIcon() }), 'Create PDF');

  btn.addEventListener('click', () => handleCreatePdf({ forecast, board, opp, btn }));

  return el('div', { class: 'forecast-board__actions' }, btn);
}

async function handleCreatePdf({ forecast, board, opp, btn }) {
  if (btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Building PDF…';

  try {
    const blob = await buildForecastPdf({ forecast, board, opp });
    const filename = forecastFilename(
      forecast.customer_name || opp?.customer_name || opp?.deal_name || 'Opportunity',
    );
    downloadBlob(blob, filename);
    showToast('Analysis PDF downloaded', 'success');
  } catch (err) {
    console.error('[Forecast] PDF export failed', err);
    showToast(err.message || 'Could not create the PDF', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// Trigger a browser download for a Blob without leaking the object URL.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — Safari needs the URL to survive the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pdfIcon() {
  return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">'
    + '<path d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14V1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
    + '<path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
    + '<path d="M6.2 11.5V8.5h1.1a.9.9 0 1 1 0 1.8H6.2" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
}

function buildSummary(forecast, board) {
  const { stages, currentIndex, workingIndex } = board;
  let headline;
  let bucketProb;
  let stateClass = 'forecast-summary--none';

  if (currentIndex >= 0) {
    const s = stages[currentIndex];
    headline = s.def.name;
    bucketProb = `${s.def.bucket} · ${s.def.probability}%`;
    stateClass = 'forecast-summary--complete';
  } else if (workingIndex >= 0) {
    const s = stages[workingIndex];
    headline = `${s.def.name} (in progress)`;
    bucketProb = `${s.def.bucket} · —`;
    stateClass = 'forecast-summary--working';
  } else {
    headline = 'No stages cleared yet';
    bucketProb = '0%';
  }

  const confidence = String(forecast.current_stage_confidence || 'low');

  const chips = el('div', { class: 'forecast-summary__chips' },
    el('span', { class: 'forecast-summary__stage-chip' }, headline),
    el('span', { class: 'forecast-summary__bucket-chip' }, bucketProb),
    el('span', { class: `forecast-summary__confidence forecast-summary__confidence--${confidence}` },
      `Confidence: ${confidence}`),
  );

  const children = [
    el('div', { class: 'forecast-summary__eyebrow' }, 'Current position'),
    chips,
  ];
  if (forecast.summary) {
    children.push(el('p', { class: 'forecast-summary__text' }, forecast.summary));
  }

  return el('div', { class: `forecast-summary ${stateClass}` }, ...children);
}

function buildBoardGrid({ board, opp, descriptions }) {
  const grid = el('div', { class: 'forecast-grid' });
  board.stages.forEach((stage) => {
    grid.appendChild(buildStageColumn({ stage, opp, descriptions }));
  });
  return grid;
}

function buildStageColumn({ stage, opp, descriptions }) {
  const chevron = el('div', { class: `forecast-chevron forecast-chevron--${stage.status}` },
    el('span', { class: 'forecast-chevron__num' }, String(stage.index + 1)),
    el('span', { class: 'forecast-chevron__name' }, stage.def.name),
    el('span', { class: 'forecast-chevron__meta' }, `${stage.def.bucket} · ${stage.def.probability}%`),
  );

  const criteriaList = el('ul', { class: 'forecast-criteria' },
    ...stage.criteria.map(c => buildCriterionItem({ criterion: c, opp, descriptions })),
  );

  const notes = stage.notes
    ? el('p', { class: 'forecast-stage__notes' }, stage.notes)
    : null;

  return el('div', { class: `forecast-stage forecast-stage--${stage.status}` },
    chevron,
    criteriaList,
    notes,
  );
}

function buildCriterionItem({ criterion, opp, descriptions }) {
  const hasDetail = !!criterion.evidence || criterion.status === 'not_met';

  const head = el('button', {
    type: 'button',
    class: `forecast-criterion__head ${hasDetail ? '' : 'forecast-criterion__head--flat'}`,
    'aria-expanded': 'false',
    disabled: !hasDetail,
  },
    el('span', { class: `forecast-criterion__icon forecast-criterion__icon--${criterion.status}`, html: statusIcon(criterion.status) }),
    el('span', { class: 'forecast-criterion__label' }, criterion.label),
  );

  const item = el('li', { class: `forecast-criterion forecast-criterion--${criterion.status}` }, head);

  if (hasDetail) {
    const detail = buildCriterionDetail({ criterion, opp, descriptions });
    detail.hidden = true;
    head.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      item.classList.toggle('forecast-criterion--open', open);
    });
    item.appendChild(detail);
  }

  return item;
}

function buildCriterionDetail({ criterion, opp, descriptions }) {
  const rows = [];

  if (criterion.evidence) {
    rows.push(el('blockquote', { class: 'forecast-evidence__quote' }, criterion.evidence));
  } else {
    rows.push(el('p', { class: 'forecast-evidence__none' }, 'No supporting note was cited.'));
  }

  const metaChildren = [];
  if (criterion.source_date) {
    metaChildren.push(el('span', { class: 'forecast-evidence__date' }, formatDate(criterion.source_date)));
  }

  // The evidence link — the element that makes this board trustworthy.
  // Only offered when we can resolve a real source note.
  const sourceNote = resolveSourceNote(criterion, descriptions);
  if (sourceNote) {
    metaChildren.push(el('a', {
      href: '#',
      class: 'forecast-evidence__link',
      onClick: (e) => {
        e.preventDefault();
        openOppDetailsModal(opp, {
          focusDescription: {
            id: sourceNote.description_id || criterion.source_id || '',
            date: sourceNote.description_date || criterion.source_date || '',
          },
        });
      },
    }, 'Open source note →'));
  }

  if (metaChildren.length) {
    rows.push(el('div', { class: 'forecast-evidence__meta' }, ...metaChildren));
  }

  return el('div', { class: 'forecast-evidence' }, ...rows);
}

// Resolve the note a criterion's evidence came from: by id first, then by
// date. Returns null if we can't tie it to a real note (so we don't offer
// a link that opens nothing).
function resolveSourceNote(criterion, descriptions) {
  const list = descriptions || [];
  if (criterion.source_id) {
    const byId = list.find(d => String(d.description_id || '') === String(criterion.source_id));
    if (byId) return byId;
  }
  if (criterion.source_date) {
    // Only follow a date to a note when it resolves unambiguously — if
    // several notes share the date we can't know which the quote came
    // from, and linking to the wrong one would break the evidence trail.
    const byDate = list.filter(d => String(d.description_date || '') === String(criterion.source_date));
    if (byDate.length === 1) return byDate[0];
  }
  return null;
}

function buildLists(forecast) {
  const cols = [];
  cols.push(buildListCard('Gaps', 'What’s missing to advance', forecast.gaps));
  cols.push(buildListCard('Open questions', 'What the notes leave unanswered', forecast.open_questions));
  return el('div', { class: 'forecast-lists' }, ...cols);
}

function buildListCard(title, subtitle, items) {
  const body = (items && items.length)
    ? el('ul', { class: 'forecast-checklist' }, ...items.map(t => buildCheckItem(t)))
    : el('p', { class: 'forecast-list__empty' }, 'Nothing flagged from the notes.');
  return el('div', { class: 'forecast-list-card' },
    el('div', { class: 'forecast-list-card__title' }, title),
    el('div', { class: 'forecast-list-card__subtitle' }, subtitle),
    body,
  );
}

// One tickable checklist row. The checked state is a view-only working aid
// (recomputed on each analysis run) — checking a gap or question strikes it
// through so the rep can track what they've handled.
function buildCheckItem(text) {
  const checkbox = el('input', { type: 'checkbox', class: 'forecast-checklist__box' });
  const label = el('label', { class: 'forecast-checklist__item' },
    checkbox,
    el('span', { class: 'forecast-checklist__text' }, text),
  );
  checkbox.addEventListener('change', () => {
    label.classList.toggle('forecast-checklist__item--done', checkbox.checked);
  });
  return el('li', { class: 'forecast-checklist__row' }, label);
}

// ── Coverage banner (honest-failure surface) ────────────────────────
// runForecast() now reads every un-analyzed attachment BEFORE scoring, so
// this banner appears only for documents that genuinely could not be read
// (extraction error). It names them and offers a one-click retry, which
// re-runs the whole flow — re-attempting the unread documents first.
function buildCoverageBanner(documents, opp) {
  const unread = (documents || []).filter(d => String(d.analyzed || '').toUpperCase() !== 'TRUE');
  if (unread.length === 0) return null;

  const n = unread.length;
  const btn = el('button', { class: 'btn btn--secondary btn--sm forecast-coverage__btn' }, 'Retry & re-run');

  const banner = el('div', { class: 'forecast-coverage' },
    el('span', { class: 'forecast-coverage__icon', html: warnIcon() }),
    el('span', { class: 'forecast-coverage__text' },
      `${n} ${n === 1 ? 'document' : 'documents'} could not be read, so ${n === 1 ? 'it was' : 'they were'} left out of this analysis. The board reflects the deal’s notes and every document Randy could read.`),
    btn,
  );

  // A plain re-run re-attempts the unread documents first (runForecast reads
  // each un-analyzed attachment before scoring), then rebuilds the board.
  // Passing the captured opp keeps the re-run pinned to THIS deal even if the
  // dropdown selection has since changed.
  btn.addEventListener('click', () => runForecast(opp));
  return banner;
}

// Replicates the existing analyzeDocument write from admin-opportunities.js
// (which is an inline closure we can't import): call the Apps Script, then
// append the returned content to Opportunity_Descriptions as a new note.
// This is purely additive — no edit to admin-opportunities.js.
async function analyzeOneDocument(file, opp) {
  const data = await fileApiRequest({
    action: 'analyzeDocument',
    docId: file.doc_id,
    driveUrl: file.drive_url,
  });
  const fileName = data.fileName || file.file_name || 'Document';
  const dateISO = todayISO();
  const dateLabel = formatDate(dateISO);
  const descriptionHtml =
    `<h4>📄 ${escapeHtml(fileName)} — Analyzed ${escapeHtml(dateLabel)}</h4>` + ensureHtml(data.html || '');
  const descriptionId = uuid('dsc');
  const createdAt = nowISO();
  const values = [descriptionId, opp.opportunity_id, opp.deal_name || '', dateISO, descriptionHtml, createdAt];
  if (isConfigured()) {
    await appendRow(CONFIG.SHEET_OPP_DESCRIPTIONS, values);
  } else {
    addDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, values);
  }
  file.analyzed = 'TRUE';

  // Return the new note in the same shape readSheetAsObjects yields, so the
  // caller can fold it straight into the evidence base without re-reading
  // the whole sheet (avoids an extra round-trip and any read-after-write lag).
  return {
    description_id: descriptionId,
    opportunity_id: opp.opportunity_id,
    deal_name: opp.deal_name || '',
    description_date: dateISO,
    description_text: descriptionHtml,
    created_at: createdAt,
  };
}

// ── Small SVG / helpers ─────────────────────────────────────────────
function statusIcon(status) {
  switch (status) {
    case 'met':
      return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'partial':
      return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>';
    case 'not_met':
      return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    default: // no_evidence
      return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }
}

function warnIcon() {
  return '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2l9 16H1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="15" r="1" fill="currentColor"/></svg>';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
