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
import { FORECAST_STAGES, BUYING_PROCESS_BANDS } from '../utils/forecast-stages.js';
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
      .sort((a, b) => new Date(a.description_date || a.created_at) - new Date(b.description_date || b.created_at));

    updatePillStage(pill, 'Randy is scoring the stages…');

    const forecast = await requestForecastJson(opp, descriptions, documents, controller.signal);

    if (controller.signal.aborted) return;
    markPillSuccess(pill, 'Forecast ready');
    if (currentPill === pill) currentPill = null;
    if (currentController === controller) currentController = null;

    const board = deriveBoard(forecast);
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

// ── Derive the board from the validated criteria ────────────────────
// The chevron colours and the current-stage header are computed from the
// PARSER-VALIDATED criteria, not from the model's self-reported stage
// status — so nothing on the board can be more advanced than the evidence
// that survived parsing. A stage is "complete" only if every one of its
// criteria is "met".
function deriveBoard(forecast) {
  const stageResults = new Map((forecast.stages || []).map(s => [s.stage_id, s]));

  const stages = FORECAST_STAGES.map((stageDef, i) => {
    const res = stageResults.get(stageDef.id);
    const critResults = new Map(((res && res.criteria) || []).map(c => [c.criterion_id, c]));

    const criteria = stageDef.criteria.map(def => {
      const cr = critResults.get(def.id);
      return {
        id: def.id,
        label: def.label,
        status: cr ? cr.status : 'no_evidence',
        evidence: cr ? cr.evidence : '',
        source_date: cr ? cr.source_date : '',
        source_id: cr ? cr.source_id : '',
      };
    });

    const metCount = criteria.filter(c => c.status === 'met').length;
    const claimedCount = criteria.filter(c => c.status === 'met' || c.status === 'partial').length;
    let status = 'not_started';
    if (criteria.length > 0 && metCount === criteria.length) status = 'complete';
    else if (claimedCount > 0) status = 'in_progress';

    return { def: stageDef, index: i, status, criteria, notes: (res && res.notes) || '', metCount };
  });

  let currentIndex = -1;
  let workingIndex = -1;
  stages.forEach((s, i) => {
    if (s.status === 'complete') currentIndex = i;
    if (s.status !== 'not_started') workingIndex = i;
  });

  return { stages, currentIndex, workingIndex };
}

// ── Render ──────────────────────────────────────────────────────────
function renderForecastBoard({ forecast, board, opp, descriptions, documents }) {
  const frag = el('div', { class: 'forecast-board' });

  // Coverage banner (honesty pass): documents Randy could not read.
  const banner = buildCoverageBanner(documents, opp);
  if (banner) frag.appendChild(banner);

  frag.appendChild(buildSummary(forecast, board));

  // The stage grid and the buying-process bands live in ONE horizontal
  // scroller so the bands stay column-aligned with the stages when the
  // board scrolls on narrow screens.
  frag.appendChild(el('div', { class: 'forecast-board__scroll' },
    buildBoardGrid({ board, opp, descriptions }),
    buildBands(),
  ));

  frag.appendChild(buildLists(forecast));

  return frag;
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

function buildBands() {
  const grid = el('div', { class: 'forecast-bands' });
  BUYING_PROCESS_BANDS.forEach(band => {
    grid.appendChild(el('div', {
      class: `forecast-band forecast-band--${band.id}`,
      style: { gridColumn: `${band.startStage} / ${band.endStage + 1}` },
    },
      el('span', { class: 'forecast-band__label' }, band.label),
      el('span', { class: 'forecast-band__points' }, band.points.join(' · ')),
    ));
  });
  return el('div', { class: 'forecast-bands__wrap' },
    el('div', { class: 'forecast-bands__eyebrow' }, 'Customer buying process'),
    grid,
  );
}

function buildLists(forecast) {
  const cols = [];
  cols.push(buildListCard('Gaps', 'What’s missing to advance', forecast.gaps));
  cols.push(buildListCard('Open questions', 'What the notes leave unanswered', forecast.open_questions));
  return el('div', { class: 'forecast-lists' }, ...cols);
}

function buildListCard(title, subtitle, items) {
  const list = (items && items.length)
    ? el('ul', { class: 'forecast-list' }, ...items.map(t => el('li', {}, t)))
    : el('p', { class: 'forecast-list__empty' }, 'Nothing flagged from the notes.');
  return el('div', { class: 'forecast-list-card' },
    el('div', { class: 'forecast-list-card__title' }, title),
    el('div', { class: 'forecast-list-card__subtitle' }, subtitle),
    list,
  );
}

// ── Coverage banner + one-click analyze ─────────────────────────────
function buildCoverageBanner(documents, opp) {
  const unanalyzed = (documents || []).filter(d => String(d.analyzed || '').toUpperCase() !== 'TRUE');
  if (unanalyzed.length === 0) return null;

  const n = unanalyzed.length;
  const btn = el('button', { class: 'btn btn--secondary btn--sm forecast-coverage__btn' }, 'Analyze them & re-run');

  const banner = el('div', { class: 'forecast-coverage' },
    el('span', { class: 'forecast-coverage__icon', html: warnIcon() }),
    el('span', { class: 'forecast-coverage__text' },
      `${n} ${n === 1 ? 'document is' : 'documents are'} attached to this deal but ${n === 1 ? 'hasn’t' : 'haven’t'} been analyzed yet — Randy can’t read ${n === 1 ? 'it' : 'them'}.`),
    btn,
  );

  btn.addEventListener('click', () => analyzeDocsThenRerun(unanalyzed, opp, btn));
  return banner;
}

async function analyzeDocsThenRerun(unanalyzed, opp, btn) {
  btn.disabled = true;
  const pill = createPill(`Analyzing 0/${unanalyzed.length}…`, { label: opp.customer_name || 'Documents' });
  let done = 0;
  let failed = 0;

  for (const file of unanalyzed) {
    updatePillStage(pill, `Analyzing ${done + 1}/${unanalyzed.length}…`);
    try {
      await analyzeOneDocument(file, opp);
    } catch (err) {
      failed += 1;
      console.warn('[Forecast] analyzeDocument failed', file?.file_name, err);
    }
    done += 1;
  }

  if (failed === unanalyzed.length) {
    markPillFailure(pill, 'Could not analyze documents');
    showToast('Document analysis failed — Randy will run without them.', 'error');
  } else {
    markPillSuccess(pill, failed ? `Analyzed ${done - failed}/${unanalyzed.length}` : 'Documents analyzed');
  }

  // Re-run the forecast for THIS deal now that the analyzed content is in
  // the notes — pass the captured opp so the re-run can't drift to a
  // different dropdown selection.
  runForecast(opp);
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
