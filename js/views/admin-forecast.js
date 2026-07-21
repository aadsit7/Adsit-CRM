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
import { stripHtml } from '../utils/forecast-prompts.js';
import {
  deriveForecastBoard,
  resolveForecastPosition,
  compareToCrmStage,
  FORECAST_STAGES,
  getStageById,
} from '../utils/forecast-stages.js';
import { buildForecastPdf, forecastFilename } from '../utils/forecast-pdf-builder.js';
import { openOppDetailsModal } from './admin-opportunities.js';
// ── Event Analyzer (parallel pipeline: prompt → client → schema) ──────
import { requestEventAnalysisJson } from '../utils/event-analyzer-client.js';
import {
  deriveEventBoard,
  resolveEventPosition,
  ownerLabel,
  EVENT_STAGES,
} from '../utils/event-analyzer-stages.js';
import { computeEventTiming } from '../utils/event-analyzer-prompts.js';
import { selectEventDescriptions, selectEventContacts } from '../utils/event-analyzer-evidence.js';
import { buildEventAnalysisPdf, eventAnalysisFilename } from '../utils/event-analyzer-pdf-builder.js';
// openEventModal is imported lazily inside the click handler (see openEventSource)
// to avoid a static import cycle with admin-events.js.
// ── Partner Analyzer (third entity mode: prompt → client → schema) ────
import { navigate } from '../router.js';
import { makeJobKey, sameJobKey } from '../utils/analyzer-job-key.js';
import { requestPartnerAnalysisJson } from '../utils/partner-analyzer-client.js';
import {
  derivePartnerBoard,
  resolvePartnerPosition,
  resolveFurthestDemonstrated,
  PARTNER_STAGES,
} from '../utils/partner-analyzer-stages.js';
import { buildPartnerSelectorOptions } from '../utils/partner-analyzer-evidence.js';
import { buildPartnerAnalysisPdf, partnerAnalysisFilename } from '../utils/partner-analyzer-pdf-builder.js';

// ── Module state ─────────────────────────────────────────────────────
// This state deliberately OUTLIVES the view. The analysis runs as a
// background job (`activeJob`) so the user can switch tabs while Randy works;
// when they return, render() repaints whatever the job is doing — live
// progress, the finished board, or an error. Only an explicit new run
// supersedes a job.
let allOpps = [];
let selectedOppId = '';
let activeJob = null;
// activeJob shape:
//   { oppId, label,
//     status: 'running' | 'done' | 'error',
//     controller: AbortController, pill,
//     result: { forecast, board, opp, descriptions, documents } | null,
//     error: string | null }

// ── Analyzer mode ────────────────────────────────────────────────────
// The Analyzer supports three independent boards — Opportunity (unchanged),
// Event, and Partner. `mode` persists across navigation so returning to the
// tab restores the last-used board. Each mode owns its OWN selection and
// background job; nothing about one flow can touch another's state, so one
// mode's result can never land on another's board.
let mode = 'opportunity'; // 'opportunity' | 'event' | 'partner'
const MODES = ['opportunity', 'event', 'partner'];
let modeSlotEl = null;    // the container the active mode panel renders into

// ── Event Analyzer state (parallel to the opportunity state above) ────
let allEvents = [];
let selectedEventId = '';
let eventJob = null;
// eventJob shape:
//   { eventId, label,
//     status: 'running' | 'done' | 'error',
//     controller: AbortController, pill,
//     result: { analysis, board, event, descriptions, timing, coverageWarnings } | null,
//     error: string | null }

// ── Partner Analyzer state (parallel to the two above) ───────────────
// A typed job key { entityType, entityId, runId } lets a late response prove
// it still belongs to the partner the user is looking at — so a stale result
// for Partner A can never render under Partner B.
let allPartners = [];       // [{ id, label, partner }] from buildPartnerSelectorOptions
let selectedPartnerId = '';
let partnerJob = null;
// partnerJob shape:
//   { key: { entityType:'partner', entityId, runId }, label,
//     status: 'running' | 'done' | 'error',
//     controller: AbortController, pill,
//     result: { analysis, board, kpis, health, partner, coverage } | null,
//     error: string | null }

// Partner-mode twin of abortInflight / abortEventInflight.
function abortPartnerInflight() {
  if (partnerJob && partnerJob.status === 'running') {
    if (partnerJob.controller) { try { partnerJob.controller.abort(); } catch { /* ignore */ } }
    if (partnerJob.pill) { try { destroyPill(partnerJob.pill); } catch { /* ignore */ } }
    partnerJob = null;
  }
}

// Abort and discard the run currently in flight (used when a new run
// supersedes it). A job that has already FINISHED keeps its cached result so
// returning to the tab still shows the board — it's replaced, not aborted,
// when the next run starts.
function abortInflight() {
  if (activeJob && activeJob.status === 'running') {
    if (activeJob.controller) { try { activeJob.controller.abort(); } catch { /* ignore */ } }
    if (activeJob.pill) { try { destroyPill(activeJob.pill); } catch { /* ignore */ } }
    activeJob = null;
  }
}

// Event-mode twin of abortInflight — supersedes only the event run.
function abortEventInflight() {
  if (eventJob && eventJob.status === 'running') {
    if (eventJob.controller) { try { eventJob.controller.abort(); } catch { /* ignore */ } }
    if (eventJob.pill) { try { destroyPill(eventJob.pill); } catch { /* ignore */ } }
    eventJob = null;
  }
}

// ── Live DOM handles ─────────────────────────────────────────────────
// The view is rebuilt on every visit, so a run started on one visit can't
// hold references to elements from a torn-down visit. We look these up fresh
// each time; a lookup returns null when the Analyzer isn't on screen, which
// is exactly the "user switched tabs" signal the paint helpers key off.
function liveResultSlot() { return $('.forecast .forecast__result'); }
function liveAnalyzeBtn()  { return $('.forecast .forecast__analyze'); }
function setAnalyzeDisabled(disabled) {
  const btn = liveAnalyzeBtn();
  if (btn) btn.disabled = disabled;
}

function paintRunning() {
  const slot = liveResultSlot();
  if (!slot) return;
  slot.replaceChildren(el('div', { class: 'forecast__loading' },
    el('div', { class: 'spinner' }),
    el('span', {}, 'Randy is analyzing… you can switch tabs — this keeps running.'),
  ));
}
function paintResult(job) {
  const slot = liveResultSlot();
  if (!slot || !job.result) return;
  slot.replaceChildren(renderForecastBoard(job.result));
}
function paintError(job) {
  const slot = liveResultSlot();
  if (!slot) return;
  slot.replaceChildren(el('div', { class: 'empty-state forecast__error' },
    el('div', { class: 'empty-state__title' }, 'Randy could not build the board'),
    el('div', { class: 'empty-state__description' }, job.error || 'Something went wrong. Try again.'),
  ));
}
// When a run settles while the user is on another tab there is no slot to
// paint into, so a toast tells them it's ready (or failed) — the board itself
// is cached and shows the moment they open the Analyzer.
function notifyIfAway(job) {
  if (liveResultSlot()) return;
  if (job.status === 'error') {
    showToast(`Analysis failed for ${job.label}. Open the Analyzer to retry.`, 'error');
  } else {
    showToast(`Analysis ready for ${job.label}. Open the Analyzer to view it.`, 'success');
  }
}
// On (re)mount, show whatever the background job is currently doing and pin
// the dropdown to its deal.
function restoreActiveJob() {
  if (!activeJob) return;
  if (activeJob.oppId) {
    selectedOppId = activeJob.oppId;
    const select = $('.forecast .forecast__select');
    if (select) select.value = activeJob.oppId;
  }
  // Disabled while a run is still in flight (a click would supersede it),
  // enabled once it has settled so the user can re-run.
  setAnalyzeDisabled(activeJob.status === 'running');
  if (activeJob.status === 'running') paintRunning();
  else if (activeJob.status === 'done') paintResult(activeJob);
  else if (activeJob.status === 'error') paintError(activeJob);
}

export async function render(container) {
  setTopbarTitle('Analyzer');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    // Load each board's selector source in parallel. Opportunities are
    // required (a failure is fatal, as before); events and partners are
    // optional — a read failure just leaves that picker empty.
    const [opportunities, events, partners] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
      readSheetAsObjects(CONFIG.SHEET_EVENTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_PARTNERS).catch(() => []),
    ]);
    // The partner selector excludes admin rows / rows without a valid id,
    // sorts by display_name, and disambiguates duplicate names (pure helper).
    allPartners = buildPartnerSelectorOptions(partners);
    allOpps = filterOpportunities(opportunities)
      .filter(o => o.opportunity_id)
      .sort((a, b) => {
        const ca = String(a.customer_name || '').toLowerCase();
        const cb = String(b.customer_name || '').toLowerCase();
        if (ca !== cb) return ca < cb ? -1 : 1;
        return String(a.deal_name || '').toLowerCase() < String(b.deal_name || '').toLowerCase() ? -1 : 1;
      });
    allEvents = (events || [])
      .filter(e => e && e.event_id && String(e.title || '').trim())
      .sort((a, b) => (Date.parse(b.event_date) || 0) - (Date.parse(a.event_date) || 0)); // newest first
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Could not load opportunities'),
      el('div', { class: 'empty-state__description' }, err.message || 'Try reloading the page.'),
    ));
    return;
  }

  mount(container, buildView());
  // Repaint whatever the active mode's background job is doing (live
  // progress, finished board, or error) for a user returning to the tab
  // mid-run or after it completed while they were away.
  restoreForMode();
}

export function cleanup() {
  // Intentionally does NOT abort either analysis. Each run is a background
  // job that survives navigation — its progress stays visible in the global
  // pill, so the user can switch tabs and come back to the finished board.
  // All three jobs (activeJob / eventJob / partnerJob) live in module state and
  // are repainted by render(); only an explicit new run supersedes the matching
  // one. The active `mode`, `selectedOppId`, `selectedEventId` and
  // `selectedPartnerId` are preserved too, so returning to the Analyzer restores
  // the last board, selection and result.
}

// ── View shell ──────────────────────────────────────────────────────
// The shell is a segmented Opportunity/Event control above a single mode
// slot. Only the active mode's panel is ever in the DOM, so the two boards
// physically cannot render at the same time — switching modes can never
// show the other entity's analysis.
function buildView() {
  modeSlotEl = el('div', { class: 'analyzer-mode-slot' });
  fillModeSlot();
  return el('div', { class: 'forecast' },
    buildModeBar(),
    modeSlotEl,
  );
}

function buildModeBar() {
  const labels = { opportunity: 'Opportunity', event: 'Event', partner: 'Partner' };
  const mk = (key) => el('button', {
    type: 'button',
    class: `analyzer-modebar__tab ${mode === key ? 'analyzer-modebar__tab--active' : ''}`,
    role: 'tab',
    'aria-selected': mode === key ? 'true' : 'false',
    dataset: { mode: key },
    onClick: () => switchMode(key),
  }, labels[key]);
  return el('div', { class: 'analyzer-modebar', role: 'tablist', 'aria-label': 'Analyzer mode' },
    ...MODES.map(mk),
  );
}

// Repaint the mode slot with the active mode's panel. Does NOT restore the
// job (the panel must be in the DOM first) — callers restore afterwards.
function fillModeSlot() {
  if (!modeSlotEl) return;
  const panel = mode === 'partner' ? buildPartnerPanel()
    : mode === 'event' ? buildEventPanel()
    : buildOppPanel();
  modeSlotEl.replaceChildren(panel);
}

// Restore the active mode's background job into its (now-mounted) panel.
function restoreForMode() {
  if (mode === 'partner') restorePartnerJob();
  else if (mode === 'event') restoreEventJob();
  else restoreActiveJob();
}

function switchMode(next) {
  if (next === mode || !MODES.includes(next)) return;
  mode = next;
  // Repaint the segmented control's active state (keyed on data-mode, so it
  // is safe for any number of tabs).
  document.querySelectorAll('.forecast .analyzer-modebar__tab').forEach((t) => {
    const isActive = t.dataset.mode === mode;
    t.classList.toggle('analyzer-modebar__tab--active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  fillModeSlot();
  restoreForMode();
}

// ── Opportunity panel (unchanged behavior) ──────────────────────────
function buildOppPanel() {
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

  return el('div', { class: 'forecast__panel' },
    el('div', { class: 'forecast__controls' },
      el('label', { class: 'forecast__control' },
        el('span', { class: 'forecast__control-label' }, 'Opportunity'),
        select,
      ),
      analyzeBtn,
    ),
    resultSlot,
  );
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

// How many attachments to read at once. Small on purpose: each read runs a
// server-side extraction, so this trades wall-clock for backend load.
const DOC_READ_CONCURRENCY = 3;

// Run an async worker over items with bounded concurrency. Execution order is
// not guaranteed; the worker owns its error handling (a throwing worker
// rejects the whole pool), so a caller that must finish the batch regardless
// catches inside the worker.
async function runPool(items, limit, worker) {
  let idx = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

// The stable header every analyze-document note carries, e.g.
// "📄 SOW draft.pdf — Analyzed Jul 15, 2026". Lets us recognize which
// documents already have a note without a doc_id ↔ note link in the sheet.
const ANALYZED_DOC_HEADER = /📄\s*(.+?)\s+—\s+Analyzed\b/g;

// File names (lower-cased) that already have an analysis note in the notes.
function collectAnalyzedDocNames(descriptions) {
  const names = new Set();
  (descriptions || []).forEach(d => {
    const plain = stripHtml(d?.description_text || d?.text || '');
    ANALYZED_DOC_HEADER.lastIndex = 0;
    let m;
    while ((m = ANALYZED_DOC_HEADER.exec(plain))) {
      const name = m[1].trim().toLowerCase();
      if (name) names.add(name);
    }
  });
  return names;
}

// Documents that still need reading: not flagged analyzed AND without an
// existing analysis note. The second test is a defensive idempotency guard —
// if the backend ever fails to persist a document's analyzed flag, we still
// won't re-extract it into a duplicate note on the next run. A document we
// recognize as already-noted has its flag corrected in place so the coverage
// banner stays honest.
function collectUnreadDocuments(documents, descriptions) {
  const analyzedNames = collectAnalyzedDocNames(descriptions);
  return (documents || []).filter(d => {
    if (String(d.analyzed || '').toUpperCase() === 'TRUE') return false;
    const name = String(d.file_name || d.name || '').trim().toLowerCase();
    if (name && analyzedNames.has(name)) {
      d.analyzed = 'TRUE';
      return false;
    }
    return true;
  });
}

// ── The run ─────────────────────────────────────────────────────────
// Pass an explicit opp to score that exact deal (used by the coverage
// banner's re-run so it can't drift to whatever the dropdown now shows);
// with no argument it scores the current dropdown selection.
async function runForecast(explicitOpp = null) {
  const opp = explicitOpp || allOpps.find(o => o.opportunity_id === selectedOppId);
  if (!opp) { showToast('Pick an opportunity first', 'error'); return; }

  // Supersede any run still in flight, then start a fresh background job. The
  // job — not the view — owns the run, so navigating away won't cancel it.
  abortInflight();
  const controller = new AbortController();
  const label = opp.customer_name || opp.deal_name || 'Analyzer';
  const pill = createPill('Reading the notes…', { label });
  const job = { oppId: opp.opportunity_id, label, status: 'running', controller, pill, result: null, error: null };
  activeJob = job;

  setAnalyzeDisabled(true);
  paintRunning();

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
    const unread = collectUnreadDocuments(documents, descriptions);
    if (unread.length) {
      let completed = 0;
      const freshNotes = [];
      updatePillStage(pill, `Reading documents… 0 of ${unread.length}`);
      // Bounded concurrency: analyze up to a few documents at once so a
      // document-heavy deal doesn't wait on a serial chain, without flooding
      // the Apps Script endpoint (each read runs an extraction server-side).
      await runPool(unread, DOC_READ_CONCURRENCY, async (file) => {
        if (controller.signal.aborted) return;
        try {
          freshNotes.push(await analyzeOneDocument(file, opp));
        } catch (docErr) {
          console.warn('[Forecast] document analysis failed', file?.file_name, docErr);
        } finally {
          completed += 1;
          updatePillStage(pill, `Reading documents… ${completed} of ${unread.length}`);
        }
      });
      if (controller.signal.aborted) return;
      descriptions.push(...freshNotes);
      descriptions.sort(byDescriptionDateAsc);
    }

    if (controller.signal.aborted) return;

    updatePillStage(pill, 'Randy is scoring the stages…');

    const forecast = await requestForecastJson(opp, descriptions, documents, controller.signal);

    // A superseding run (or an abort) has taken over — a late-resolving stale
    // run must not overwrite the newer job's result or paint over its board.
    if (job !== activeJob || controller.signal.aborted) return;

    const board = deriveForecastBoard(forecast);
    job.status = 'done';
    job.result = { forecast, board, opp, descriptions, documents };
    markPillSuccess(pill, 'Analysis ready');
    paintResult(job);   // renders into the live slot if the Analyzer is open
    notifyIfAway(job);  // otherwise toasts that it's ready
  } catch (err) {
    if (job !== activeJob || controller.signal.aborted) return;
    console.error('[Forecast] failed', err);
    job.status = 'error';
    job.error = err.message || 'Something went wrong. Try again.';
    markPillFailure(pill, 'Analysis failed');
    paintError(job);
    notifyIfAway(job);
  } finally {
    // Only the still-current job touches the button; a superseded run leaves
    // the live button to whatever the current job/selection dictates.
    if (job === activeJob) setAnalyzeDisabled(!selectedOppId);
  }
}

// ── Render ──────────────────────────────────────────────────────────
function renderForecastBoard({ forecast, board, opp, descriptions, documents }) {
  const frag = el('div', { class: 'forecast-board' });

  // Shared, mutable forecast-position state: the manual stage override the
  // user can set from the summary's "Adjust" control. It is view-only (it
  // never re-runs the analysis or writes to the CRM) but the PDF export reads
  // it too, so an exported board matches whatever the summary currently shows.
  const positionState = { overrideStageId: '' };

  // Toolbar: export the board to a two-page, print-ready PDF.
  frag.appendChild(buildBoardActions({ forecast, board, opp, positionState }));

  // Coverage banner (honesty pass): documents Randy could not read.
  const banner = buildCoverageBanner(documents, opp);
  if (banner) frag.appendChild(banner);

  frag.appendChild(buildSummary({ forecast, board, opp, positionState }));

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
function buildBoardActions({ forecast, board, opp, positionState }) {
  const btn = el('button', {
    class: 'btn btn--secondary btn--sm forecast-board__pdf-btn',
    type: 'button',
  }, el('span', { class: 'forecast-board__pdf-icon', html: pdfIcon() }), 'Create PDF');

  btn.addEventListener('click', () => handleCreatePdf({ forecast, board, opp, positionState, btn }));

  return el('div', { class: 'forecast-board__actions' }, btn);
}

async function handleCreatePdf({ forecast, board, opp, positionState, btn }) {
  if (btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Building PDF…';

  try {
    // Reflect the on-screen state: if the user has manually adjusted the
    // stage, the PDF's "current position" follows the override.
    const overrideStageId = positionState ? positionState.overrideStageId : '';
    const blob = await buildForecastPdf({ forecast, board, opp, overrideStageId });
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

// The summary's "Current position" now reads from resolveForecastPosition —
// the furthest stage the deal has SUBSTANTIALLY reached — so its probability
// tracks real progress instead of pinning to the last fully-complete stage.
// It also (a) flags when the analyzed stage differs from where the deal is
// filed in the CRM, and (b) offers an inline "Adjust" picker to override the
// stage (view-only). The chips + notes are repainted in place on override; the
// eyebrow, picker, and summary paragraph are stable across repaints.
function buildSummary({ forecast, board, opp, positionState }) {
  const confidence = String(forecast.current_stage_confidence || 'low');
  // The analysis's own read — computed once, so the "differs from CRM" note
  // always compares the CRM stage against the ANALYSIS, not a later override.
  const analyzed = resolveForecastPosition(board);

  const container = el('div', { class: 'forecast-summary' });

  const head = el('div', { class: 'forecast-summary__head' });
  const notes = el('div', { class: 'forecast-summary__notes' });

  // ── Inline "Adjust stage" picker (stable across repaints) ──────────
  const stageSelect = el('select', { class: 'form-select forecast-summary__stage-select' },
    el('option', { value: '' }, 'Use analysis'),
    ...FORECAST_STAGES.map(s =>
      el('option', { value: s.id }, `${s.name} — ${s.bucket} · ${s.probability}%`)),
  );
  stageSelect.value = positionState.overrideStageId || '';
  stageSelect.addEventListener('change', () => {
    positionState.overrideStageId = stageSelect.value;
    paint();
  });

  const picker = el('div', { class: 'forecast-summary__picker', hidden: true },
    el('label', { class: 'forecast-summary__picker-label' },
      el('span', {}, 'Set forecast stage'),
      stageSelect,
    ),
  );

  const adjustBtn = el('button', {
    type: 'button',
    class: 'forecast-summary__adjust',
    'aria-expanded': 'false',
  }, 'Adjust');
  adjustBtn.addEventListener('click', () => {
    const open = picker.hidden;
    picker.hidden = !open;
    adjustBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    adjustBtn.classList.toggle('forecast-summary__adjust--open', open);
  });

  // ── Repaint: chips + notes reflect the current (possibly overridden) pos ─
  function paint() {
    const pos = resolveForecastPosition(board, positionState.overrideStageId);

    container.className = `forecast-summary ${summaryStateClass(pos)}`;
    head.replaceChildren(buildSummaryChips(pos, confidence), adjustBtn);
    notes.replaceChildren(...buildSummaryNotes({ analyzed, pos, opp }));
  }

  paint();

  const children = [
    el('div', { class: 'forecast-summary__eyebrow' }, 'Current position'),
    head,
    picker,
    notes,
  ];
  if (forecast.summary) {
    children.push(el('p', { class: 'forecast-summary__text' }, forecast.summary));
  }

  container.replaceChildren(...children);
  return container;
}

function summaryStateClass(pos) {
  if (!pos.def) return 'forecast-summary--none';
  if (pos.source === 'override') return 'forecast-summary--override';
  return pos.complete ? 'forecast-summary--complete' : 'forecast-summary--working';
}

function buildSummaryChips(pos, confidence) {
  const headline = pos.def
    ? (pos.complete ? pos.def.name : `${pos.def.name} (in progress)`)
    : 'No stages cleared yet';
  const bucketProb = pos.def ? `${pos.bucket} · ${pos.probability}%` : '0%';

  return el('div', { class: 'forecast-summary__chips' },
    el('span', { class: 'forecast-summary__stage-chip' }, headline),
    el('span', { class: 'forecast-summary__bucket-chip' }, bucketProb),
    el('span', { class: `forecast-summary__confidence forecast-summary__confidence--${confidence}` },
      `Confidence: ${confidence}`),
    pos.source === 'override'
      ? el('span', { class: 'forecast-summary__badge' }, 'Manually set')
      : null,
  );
}

// The two notes that make the forecast honest:
//   1. "differs from CRM" — the analyzed stage vs. where the deal is filed.
//   2. "manually set"     — shown only when the user has overridden the stage.
function buildSummaryNotes({ analyzed, pos, opp }) {
  const out = [];
  const crmStage = String(opp?.stage || '').trim();
  const cmp = compareToCrmStage(analyzed.index, crmStage);

  if (cmp.differs && analyzed.def) {
    const crmDef = getStageById(cmp.crmStageId);
    const crmLabel = crmDef ? `${crmStage} · ${crmDef.bucket}` : crmStage;
    const dir = cmp.direction === 'ahead' ? 'further along than' : 'earlier than';
    out.push(el('div', { class: 'forecast-summary__note forecast-summary__note--diff' },
      el('span', { class: 'forecast-summary__note-icon', html: infoIcon() }),
      el('span', { class: 'forecast-summary__note-text' },
        'Analysis places this deal at ',
        el('strong', {}, `${analyzed.def.name} (${analyzed.bucket} · ${analyzed.probability}%)`),
        ` — ${dir} where it’s filed in the CRM (`,
        el('strong', {}, crmLabel),
        '). Use “Adjust” to override, or update the CRM stage.',
      ),
    ));
  }

  if (pos.source === 'override' && pos.def && analyzed.def && pos.index !== analyzed.index) {
    out.push(el('div', { class: 'forecast-summary__note forecast-summary__note--override' },
      el('span', { class: 'forecast-summary__note-icon', html: infoIcon() }),
      el('span', { class: 'forecast-summary__note-text' },
        'Manually set to ', el('strong', {}, `${pos.def.name} (${pos.bucket} · ${pos.probability}%)`),
        '. Analysis suggested ', el('strong', {}, analyzed.def.name), '.',
      ),
    ));
  }

  return out;
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

function infoIcon() {
  return '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6" r="1" fill="currentColor"/></svg>';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ============================================================
// EVENT ANALYZER
// ============================================================
// The event twin of the opportunity flow above. It reuses the same
// background-job pattern (a run survives navigation; a new run supersedes
// the stale one; a late stale response never overwrites a newer result)
// but keeps its OWN state (eventJob / selectedEventId) and its OWN DOM
// handles (.event-analyzer__*), so nothing here can touch the opportunity
// board and vice-versa.
// ============================================================

// ── Event panel + empty state ───────────────────────────────────────
function buildEventPanel() {
  const select = el('select', {
    class: 'form-select event-analyzer__select',
    onChange: (e) => { selectedEventId = e.target.value; analyzeBtn.disabled = !selectedEventId; },
  },
    el('option', { value: '' }, 'Select an event…'),
    ...allEvents.map(ev => el('option', { value: ev.event_id }, eventOptionLabel(ev))),
  );
  if (selectedEventId) select.value = selectedEventId;

  const analyzeBtn = el('button', {
    class: 'btn btn--primary event-analyzer__analyze',
    disabled: !selectedEventId,
    onClick: () => runEventAnalysis(),
  }, 'Analyze with Randy');

  const resultSlot = el('div', { class: 'event-analyzer__result' }, buildEventIntroEmptyState());

  return el('div', { class: 'event-analyzer__panel' },
    el('div', { class: 'forecast__controls' },
      el('label', { class: 'forecast__control' },
        el('span', { class: 'forecast__control-label' }, 'Event'),
        select,
      ),
      analyzeBtn,
    ),
    resultSlot,
  );
}

// A human-readable option: "Title — Date · Type".
function eventOptionLabel(ev) {
  const bits = [String(ev.title || 'Untitled event').trim()];
  const date = ev.event_date ? (formatDate(ev.event_date) || ev.event_date) : '';
  const tail = [date, String(ev.event_type || '').trim()].filter(Boolean).join(' · ');
  return tail ? `${bits[0]} — ${tail}` : bits[0];
}

function buildEventIntroEmptyState() {
  return el('div', { class: 'empty-state event-analyzer__intro' },
    el('div', { class: 'empty-state__title' }, 'Analyze an event lifecycle'),
    el('div', { class: 'empty-state__description' },
      'Pick an event and Randy will score its event lifecycle from saved notes and CRM evidence—'
      + 'showing completed activities, gaps, and the evidence behind each result.'),
  );
}

// ── Event live DOM handles + paint helpers ──────────────────────────
function liveEventResultSlot() { return $('.forecast .event-analyzer__result'); }
function liveEventAnalyzeBtn() { return $('.forecast .event-analyzer__analyze'); }
function setEventAnalyzeDisabled(disabled) {
  const btn = liveEventAnalyzeBtn();
  if (btn) btn.disabled = disabled;
}

function paintEventRunning() {
  const slot = liveEventResultSlot();
  if (!slot) return;
  slot.replaceChildren(el('div', { class: 'forecast__loading' },
    el('div', { class: 'spinner' }),
    el('span', {}, 'Randy is analyzing the event lifecycle… you can switch tabs — this keeps running.'),
  ));
}
function paintEventResult(job) {
  const slot = liveEventResultSlot();
  if (!slot || !job.result) return;
  slot.replaceChildren(renderEventBoard(job.result));
}
function paintEventError(job) {
  const slot = liveEventResultSlot();
  if (!slot) return;
  slot.replaceChildren(el('div', { class: 'empty-state forecast__error' },
    el('div', { class: 'empty-state__title' }, 'Randy could not build the lifecycle'),
    el('div', { class: 'empty-state__description' }, job.error || 'Something went wrong. Try again.'),
  ));
}
function notifyEventIfAway(job) {
  if (liveEventResultSlot()) return;
  if (job.status === 'error') {
    showToast(`Event analysis failed for ${job.label}. Open the Analyzer to retry.`, 'error');
  } else {
    showToast(`Event analysis ready for ${job.label}. Open the Analyzer to view it.`, 'success');
  }
}
function restoreEventJob() {
  if (!eventJob) return;
  if (eventJob.eventId) {
    selectedEventId = eventJob.eventId;
    const select = $('.forecast .event-analyzer__select');
    if (select) select.value = eventJob.eventId;
  }
  setEventAnalyzeDisabled(eventJob.status === 'running');
  if (eventJob.status === 'running') paintEventRunning();
  else if (eventJob.status === 'done') paintEventResult(eventJob);
  else if (eventJob.status === 'error') paintEventError(eventJob);
}

// Load one event's saved playbook state (optional evidence source). A read
// failure — most commonly a not-yet-created Event_Playbook tab — is NON-FATAL:
// we return a coverage warning and let the analysis proceed on the rest of
// the evidence. A successful read that simply has no row for this event is
// not a warning (there just isn't any saved state yet).
async function loadSavedPlaybookRaw(eventId) {
  try {
    const rows = await readSheetAsObjects(CONFIG.SHEET_EVENT_PLAYBOOK);
    const row = (rows || []).find(r => String(r.event_id || '').trim() === eventId);
    return { raw: row ? (row.stages_json || '') : null, warning: null };
  } catch {
    return {
      raw: null,
      warning: 'Saved playbook state couldn’t be loaded, so any manually-checked activities aren’t reflected. '
        + 'The board still reflects this event’s notes and CRM facts.',
    };
  }
}

// ── The event run ───────────────────────────────────────────────────
// Pass an explicit event to score that exact event (used by a re-run so it
// can't drift to whatever the dropdown now shows); with no argument it
// scores the current dropdown selection.
async function runEventAnalysis(explicitEvent = null) {
  const event = explicitEvent || allEvents.find(e => e.event_id === selectedEventId);
  if (!event) { showToast('Pick an event first', 'error'); return; }

  abortEventInflight();
  const controller = new AbortController();
  const label = event.title || 'Event';
  const pill = createPill('Reading the event notes…', { label });
  const job = { eventId: event.event_id, label, status: 'running', controller, pill, result: null, error: null };
  eventJob = job;

  setEventAnalyzeDisabled(true);
  paintEventRunning();

  try {
    // Load every evidence source in parallel. Contacts/opps/playbook are all
    // tolerated on failure — the analysis still runs on whatever succeeded.
    const [descAll, contactsAll, opportunities, savedResult] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_EVENT_DESCRIPTIONS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_EVENT_CONTACTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES).catch(() => []),
      loadSavedPlaybookRaw(event.event_id),
    ]);

    if (controller.signal.aborted || job !== eventJob) return;

    // Strict event_id filtering (shared, tested helpers) — one event's
    // analysis can never pull in another event's notes or contacts.
    const descriptions = selectEventDescriptions(descAll, event.event_id);
    const contacts = selectEventContacts(contactsAll, event.event_id);

    const coverageWarnings = [];
    if (savedResult.warning) coverageWarnings.push(savedResult.warning);

    updatePillStage(pill, 'Randy is scoring the lifecycle…');

    const analysis = await requestEventAnalysisJson(
      event, descriptions, contacts, opportunities, savedResult.raw, controller.signal,
    );

    // A superseding run (or abort) took over — a late stale response must
    // never overwrite the newer job's result or paint over its board.
    if (job !== eventJob || controller.signal.aborted) return;

    const board = deriveEventBoard(analysis);
    const timing = computeEventTiming(event);
    job.status = 'done';
    job.result = { analysis, board, event, descriptions, timing, coverageWarnings };
    markPillSuccess(pill, 'Analysis ready');
    paintEventResult(job);
    notifyEventIfAway(job);
  } catch (err) {
    if (job !== eventJob || controller.signal.aborted) return;
    console.error('[Event Analyzer] failed', err);
    job.status = 'error';
    job.error = err.message || 'Something went wrong. Try again.';
    markPillFailure(pill, 'Analysis failed');
    paintEventError(job);
    notifyEventIfAway(job);
  } finally {
    if (job === eventJob) setEventAnalyzeDisabled(!selectedEventId);
  }
}

// ── Event board render ──────────────────────────────────────────────
function renderEventBoard({ analysis, board, event, descriptions, timing, coverageWarnings }) {
  const frag = el('div', { class: 'event-board' });

  frag.appendChild(buildEventBoardActions({ analysis, board, event, timing, coverageWarnings }));

  const banner = buildEventCoverage(coverageWarnings);
  if (banner) frag.appendChild(banner);

  frag.appendChild(buildEventSummary({ analysis, board, event, timing }));
  frag.appendChild(buildEventLegend());

  frag.appendChild(el('div', { class: 'event-board__scroll' },
    buildEventGrid({ board, event, descriptions }),
  ));

  frag.appendChild(buildEventLists(analysis));

  return frag;
}

// ── PDF export toolbar ──────────────────────────────────────────────
function buildEventBoardActions({ analysis, board, event, timing, coverageWarnings }) {
  const btn = el('button', {
    class: 'btn btn--secondary btn--sm event-board__pdf-btn',
    type: 'button',
  }, el('span', { class: 'forecast-board__pdf-icon', html: pdfIcon() }), 'Create PDF');

  btn.addEventListener('click', () => handleCreateEventPdf({ analysis, board, event, timing, coverageWarnings, btn }));
  return el('div', { class: 'forecast-board__actions' }, btn);
}

async function handleCreateEventPdf({ analysis, board, event, timing, coverageWarnings, btn }) {
  if (btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    const blob = await buildEventAnalysisPdf({
      analysis, board, event,
      timingLine: timing ? timing.daysLabel : '',
      coverageWarnings,
    });
    const filename = eventAnalysisFilename(analysis.event_title || event?.title || 'Event');
    downloadBlob(blob, filename);
    showToast('Event analysis PDF downloaded', 'success');
  } catch (err) {
    console.error('[Event Analyzer] PDF export failed', err);
    showToast(err.message || 'Could not create the PDF', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ── Coverage banner (non-fatal notices) ─────────────────────────────
function buildEventCoverage(coverageWarnings) {
  const list = (coverageWarnings || []).filter(Boolean);
  if (!list.length) return null;
  return el('div', { class: 'forecast-coverage event-coverage' },
    el('span', { class: 'forecast-coverage__icon', html: warnIcon() }),
    el('span', { class: 'forecast-coverage__text' }, list.join(' ')),
  );
}

// ── Summary ─────────────────────────────────────────────────────────
// Event execution has NO forecast bucket and NO win probability. The
// summary shows lifecycle position, completed-stage count, completion %,
// confidence, days until/since the event, and the event's status + type.
function buildEventSummary({ analysis, board, event, timing }) {
  const confidence = String(analysis.current_stage_confidence || 'low');
  const pos = resolveEventPosition(board);
  const completedStages = board.stages.filter(s => s.status === 'complete').length;

  const headline = pos.def
    ? (pos.complete ? `${pos.def.name} — lifecycle complete` : `${pos.def.name} (in progress)`)
    : 'Not started';

  const chips = el('div', { class: 'event-summary__chips' },
    el('span', { class: 'event-summary__stage-chip' }, headline),
    el('span', { class: 'event-summary__pct-chip' }, `${board.completionPct}% complete`),
    el('span', { class: `event-summary__confidence event-summary__confidence--${confidence}` },
      `Confidence: ${confidence}`),
  );

  const facts = el('div', { class: 'event-summary__facts' },
    summaryFact('Completed stages', `${completedStages} of ${EVENT_STAGES.length}`),
    summaryFact('Activities met', `${board.metCount} of ${board.totalActivities}`),
    summaryFact('Timing', timing ? timing.daysLabel : '—'),
    summaryFact('Status', String(event?.status || '—').trim() || '—'),
    summaryFact('Type', String(event?.event_type || '—').trim() || '—'),
  );

  const children = [
    el('div', { class: 'event-summary__eyebrow' }, 'Lifecycle position'),
    chips,
    facts,
  ];
  if (analysis.summary) {
    children.push(el('p', { class: 'event-summary__text' }, analysis.summary));
  }

  const stateClass = pos.complete ? 'event-summary--complete'
    : (pos.started ? 'event-summary--working' : 'event-summary--none');
  return el('div', { class: `event-summary ${stateClass}` }, ...children);
}

function summaryFact(label, value) {
  return el('div', { class: 'event-summary__fact' },
    el('span', { class: 'event-summary__fact-label' }, label),
    el('span', { class: 'event-summary__fact-value' }, value),
  );
}

// A status legend so completion is never conveyed by colour alone.
function buildEventLegend() {
  const item = (status, label) => el('span', { class: 'event-legend__item' },
    el('span', { class: `event-activity__icon event-activity__icon--${status}`, html: statusIcon(status) }),
    el('span', {}, label),
  );
  return el('div', { class: 'event-legend', role: 'note', 'aria-label': 'Status key' },
    item('met', 'Met'),
    item('partial', 'Partial'),
    item('not_met', 'Not met'),
    item('no_evidence', 'No evidence'),
    el('span', { class: 'event-legend__item' },
      el('span', { class: 'event-legend__manual-dot' }, '✓'),
      el('span', {}, 'Saved playbook (manual)'),
    ),
  );
}

// ── Stage grid ──────────────────────────────────────────────────────
function buildEventGrid({ board, event, descriptions }) {
  const grid = el('div', { class: 'event-grid' });
  board.stages.forEach((stage) => {
    grid.appendChild(buildEventStageColumn({ stage, event, descriptions }));
  });
  return grid;
}

function buildEventStageColumn({ stage, event, descriptions }) {
  const chevron = el('div', { class: `event-chevron event-chevron--${stage.status}` },
    el('span', { class: 'event-chevron__num' }, String(stage.index + 1)),
    el('span', { class: 'event-chevron__name' }, stage.def.name),
    el('span', { class: 'event-chevron__meta' }, stage.def.timing),
  );

  const list = el('ul', { class: 'event-activities' },
    ...stage.activities.map(a => buildEventActivityItem({ activity: a, event, descriptions })),
  );

  const notes = stage.notes
    ? el('p', { class: 'event-stage__notes' }, stage.notes)
    : null;

  return el('div', { class: `event-stage event-stage--${stage.status}` }, chevron, list, notes);
}

function buildEventActivityItem({ activity, event, descriptions }) {
  const hasDetail = !!activity.evidence || activity.manual || activity.status === 'not_met';

  const head = el('button', {
    type: 'button',
    class: `event-activity__head ${hasDetail ? '' : 'event-activity__head--flat'}`,
    'aria-expanded': 'false',
    disabled: !hasDetail,
  },
    el('span', { class: `event-activity__icon event-activity__icon--${activity.status}`, html: statusIcon(activity.status) }),
    el('span', { class: 'event-activity__label' }, activity.label),
    el('span', { class: 'event-activity__meta' },
      el('span', { class: 'event-owner' }, ownerLabel(activity.owner)),
      el('span', { class: `event-activity__status event-activity__status--${activity.status}` }, eventStatusLabel(activity.status)),
      activity.manual ? el('span', { class: 'event-activity__manual' }, 'Saved playbook') : null,
    ),
  );

  const item = el('li', { class: `event-activity event-activity--${activity.status}` }, head);

  if (hasDetail) {
    const detail = buildEventActivityDetail({ activity, event, descriptions });
    detail.hidden = true;
    head.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      item.classList.toggle('event-activity--open', open);
    });
    item.appendChild(detail);
  }
  return item;
}

function buildEventActivityDetail({ activity, event, descriptions }) {
  const rows = [];

  if (activity.manual) {
    rows.push(el('p', { class: 'event-evidence__manual' },
      'Manually confirmed in the saved playbook'
      + (activity.source_date ? ` on ${formatDate(activity.source_date) || activity.source_date}` : '') + '.'));
  } else if (activity.evidence) {
    rows.push(el('blockquote', { class: 'event-evidence__quote' }, activity.evidence));
  } else if (activity.status === 'not_met') {
    rows.push(el('p', { class: 'event-evidence__none' }, 'A source indicates this has not happened.'));
  }

  const meta = [];
  if (activity.source_type && activity.source_type !== 'none') {
    meta.push(el('span', { class: 'event-evidence__type' }, sourceTypeLabel(activity.source_type)));
  }
  if (activity.source_date) {
    meta.push(el('span', { class: 'event-evidence__date' }, formatDate(activity.source_date) || activity.source_date));
  }

  // "Open event" opens the correct event record (which lists its notes and
  // sourced opportunities) — the relevant source for any evidence type.
  if (event && (activity.evidence || activity.manual || activity.source_type !== 'none')) {
    meta.push(el('button', {
      type: 'button',
      class: 'event-evidence__link',
      onClick: () => openEventSource(event, activity),
    }, 'Open event →'));
  }

  if (meta.length) rows.push(el('div', { class: 'event-evidence__meta' }, ...meta));
  return el('div', { class: 'event-evidence' }, ...rows);
}

// Lazy import avoids a static import cycle with admin-events.js.
async function openEventSource(event, activity) {
  try {
    const { openEventModal } = await import('./admin-events.js');
    const container = document.getElementById('view-container') || document.body;
    await openEventModal(event, container);
  } catch (err) {
    console.error('[Event Analyzer] could not open event', err);
    showToast('Could not open the event record', 'error');
  }
}

function buildEventLists(analysis) {
  return el('div', { class: 'event-lists' },
    buildEventListCard('What to do next', 'The most useful next steps', analysis.next_actions),
    buildEventListCard('Gaps', 'What’s missing to finish the current stage', analysis.gaps),
    buildEventListCard('Open questions', 'What the evidence leaves unanswered', analysis.open_questions),
  );
}

function buildEventListCard(title, subtitle, items) {
  const body = (items && items.length)
    ? el('ul', { class: 'forecast-checklist' }, ...items.map(t => buildEventCheckItem(t)))
    : el('p', { class: 'forecast-list__empty' }, 'Nothing flagged from the evidence.');
  return el('div', { class: 'forecast-list-card' },
    el('div', { class: 'forecast-list-card__title' }, title),
    el('div', { class: 'forecast-list-card__subtitle' }, subtitle),
    body,
  );
}

function buildEventCheckItem(text) {
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

function eventStatusLabel(status) {
  switch (status) {
    case 'met': return 'Met';
    case 'partial': return 'Partial';
    case 'not_met': return 'Not met';
    default: return 'No evidence';
  }
}

function sourceTypeLabel(sourceType) {
  switch (sourceType) {
    case 'event_description': return 'Event note';
    case 'event_metadata': return 'Event details';
    case 'event_contacts': return 'Saved contacts';
    case 'linked_opportunities': return 'Linked opportunity';
    case 'saved_playbook': return 'Saved playbook';
    default: return 'Source';
  }
}

// ============================================================
// PARTNER ANALYZER
// ============================================================
// The partner twin of the two flows above. It reuses the same
// background-job pattern (a run survives navigation; a new run supersedes
// the stale one; a late stale response never overwrites a newer result)
// but keeps its OWN state (partnerJob / selectedPartnerId), its OWN DOM
// handles (.partner-analyzer__*), and a typed job key so a stale Partner-A
// response can never render under Partner B. Nothing here can touch the
// opportunity or event boards and vice-versa.
//
// Partner mode shows NO forecast probability and NO event-countdown language.
// Maturity is scored ONLY from validated evidence; the CRM tier/status are
// shown as context and never substituted for maturity evidence. KPIs and
// relationship health are computed deterministically in the client (app code).
// ============================================================

// ── Partner panel + empty state ─────────────────────────────────────
function buildPartnerPanel() {
  const select = el('select', {
    class: 'form-select partner-analyzer__select',
    onChange: (e) => { selectedPartnerId = e.target.value; analyzeBtn.disabled = !selectedPartnerId; },
  },
    el('option', { value: '' }, 'Select a partner…'),
    ...allPartners.map(p => el('option', { value: p.id }, p.label)),
  );
  if (selectedPartnerId) select.value = selectedPartnerId;

  const analyzeBtn = el('button', {
    class: 'btn btn--primary partner-analyzer__analyze',
    disabled: !selectedPartnerId,
    onClick: () => runPartnerAnalysis(),
  }, 'Analyze with Randy');

  const resultSlot = el('div', { class: 'partner-analyzer__result' }, buildPartnerIntroEmptyState());

  return el('div', { class: 'partner-analyzer__panel' },
    el('div', { class: 'forecast__controls' },
      el('label', { class: 'forecast__control' },
        el('span', { class: 'forecast__control-label' }, 'Partner'),
        select,
      ),
      analyzeBtn,
    ),
    resultSlot,
  );
}

function buildPartnerIntroEmptyState() {
  return el('div', { class: 'empty-state partner-analyzer__intro' },
    el('div', { class: 'empty-state__title' }, 'Assess a partner’s maturity'),
    el('div', { class: 'empty-state__description' },
      'Pick a partner and Randy will assess its maturity from meetings, documents, joint activity, '
      + 'pipeline, and revenue—showing the evidence, gaps, and next best actions.'),
  );
}

// ── Partner live DOM handles + paint helpers ────────────────────────
function livePartnerResultSlot() { return $('.forecast .partner-analyzer__result'); }
function livePartnerAnalyzeBtn() { return $('.forecast .partner-analyzer__analyze'); }
function setPartnerAnalyzeDisabled(disabled) {
  const btn = livePartnerAnalyzeBtn();
  if (btn) btn.disabled = disabled;
}

function paintPartnerRunning() {
  const slot = livePartnerResultSlot();
  if (!slot) return;
  slot.replaceChildren(el('div', { class: 'forecast__loading' },
    el('div', { class: 'spinner' }),
    el('span', {}, 'Randy is assessing partner maturity… you can switch tabs — this keeps running.'),
  ));
}
function paintPartnerResult(job) {
  const slot = livePartnerResultSlot();
  if (!slot || !job.result) return;
  slot.replaceChildren(renderPartnerBoard(job.result));
}
function paintPartnerError(job) {
  const slot = livePartnerResultSlot();
  if (!slot) return;
  slot.replaceChildren(el('div', { class: 'empty-state forecast__error' },
    el('div', { class: 'empty-state__title' }, 'Randy could not build the maturity board'),
    el('div', { class: 'empty-state__description' }, job.error || 'Something went wrong. Try again.'),
  ));
}
function notifyPartnerIfAway(job) {
  if (livePartnerResultSlot()) return;
  if (job.status === 'error') {
    showToast(`Partner analysis failed for ${job.label}. Open the Analyzer to retry.`, 'error');
  } else {
    showToast(`Partner analysis ready for ${job.label}. Open the Analyzer to view it.`, 'success');
  }
}
function restorePartnerJob() {
  if (!partnerJob) return;
  if (partnerJob.key && partnerJob.key.entityId) {
    selectedPartnerId = partnerJob.key.entityId;
    const select = $('.forecast .partner-analyzer__select');
    if (select) select.value = partnerJob.key.entityId;
  }
  setPartnerAnalyzeDisabled(partnerJob.status === 'running');
  if (partnerJob.status === 'running') paintPartnerRunning();
  else if (partnerJob.status === 'done') paintPartnerResult(partnerJob);
  else if (partnerJob.status === 'error') paintPartnerError(partnerJob);
}

// ── The partner run ─────────────────────────────────────────────────
// Pass an explicit partner option to score that exact partner (used by a
// re-run so it can't drift to whatever the dropdown now shows); with no
// argument it scores the current dropdown selection.
async function runPartnerAnalysis(explicitOption = null) {
  const option = explicitOption || allPartners.find(p => p.id === selectedPartnerId);
  const partner = option && option.partner;
  if (!partner) { showToast('Pick a partner first', 'error'); return; }

  abortPartnerInflight();
  const controller = new AbortController();
  const runId = uuid('run');
  const key = makeJobKey('partner', partner.partner_id, runId);
  const label = partner.display_name || 'Partner';
  const pill = createPill('Reading partner evidence…', { label });
  const job = { key, label, status: 'running', controller, pill, result: null, error: null };
  partnerJob = job;

  // A late response applies only if THIS job is still the active one AND its
  // typed key (entityType + entityId + runId) still matches — belt and braces
  // against a stale Partner-A result landing on Partner B.
  const stillCurrent = () => job === partnerJob && sameJobKey(job.key, partnerJob && partnerJob.key) && !controller.signal.aborted;

  setPartnerAnalyzeDisabled(true);
  paintPartnerRunning();

  try {
    // Load every partner evidence source in parallel. Core CRM reads are
    // tolerated on failure and surfaced as non-fatal coverage notes; the
    // analysis still runs on whatever succeeded.
    const readFailures = [];
    const soft = (label) => (() => { readFailures.push(label); return []; });
    const [
      transcripts, meetings, documents,
      opportunities, opportunityDescriptions,
      events, eventDescriptions, eventContacts, savedPlaybookRows,
    ] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS).catch(soft('Transcripts could not be loaded, so conversation evidence may be incomplete.')),
      readSheetAsObjects(CONFIG.SHEET_MEETING_INDEX).catch(soft('The meeting index could not be loaded, so indexed meetings may be incomplete.')),
      readSheetAsObjects(CONFIG.SHEET_PARTNER_DOCUMENTS).catch(soft('Partner documents could not be loaded, so document evidence may be incomplete.')),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_OPP_DESCRIPTIONS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_EVENTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_EVENT_DESCRIPTIONS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_EVENT_CONTACTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_EVENT_PLAYBOOK).catch(() => []), // optional evidence source
    ]);

    if (!stillCurrent()) return;
    updatePillStage(pill, 'Randy is scoring partner maturity…');

    const { analysis, kpis, health, coverage } = await requestPartnerAnalysisJson({
      partner,
      transcripts, meetings, documents,
      opportunities, opportunityDescriptions,
      events, eventDescriptions, eventContacts,
      savedPlaybookRows, readFailures,
      signal: controller.signal,
    });

    // A superseding run (or abort) took over — a late stale response must
    // never overwrite the newer job's result or paint over its board.
    if (!stillCurrent()) return;

    const board = derivePartnerBoard(analysis);
    job.status = 'done';
    job.result = { analysis, board, kpis, health, partner, coverage };
    markPillSuccess(pill, 'Analysis ready');
    paintPartnerResult(job);
    notifyPartnerIfAway(job);
  } catch (err) {
    if (!stillCurrent()) return;
    console.error('[Partner Analyzer] failed', err);
    job.status = 'error';
    job.error = err.message || 'Something went wrong. Try again.';
    markPillFailure(pill, 'Analysis failed');
    paintPartnerError(job);
    notifyPartnerIfAway(job);
  } finally {
    if (job === partnerJob) setPartnerAnalyzeDisabled(!selectedPartnerId);
  }
}

// ── Partner board render ────────────────────────────────────────────
function renderPartnerBoard({ analysis, board, kpis, health, partner, coverage }) {
  const frag = el('div', { class: 'partner-board' });

  frag.appendChild(buildPartnerBoardActions({ analysis, board, kpis, health, partner, coverage }));

  const banner = buildPartnerCoverage(coverage);
  if (banner) frag.appendChild(banner);

  frag.appendChild(buildPartnerSummary({ analysis, board, kpis, health }));
  frag.appendChild(buildPartnerKpiStrip(kpis));
  frag.appendChild(buildPartnerLegend());

  frag.appendChild(el('div', { class: 'event-board__scroll' },
    buildPartnerGrid({ board, partner }),
  ));

  frag.appendChild(buildPartnerLists(analysis));

  return frag;
}

// ── PDF export toolbar ──────────────────────────────────────────────
function buildPartnerBoardActions({ analysis, board, kpis, health, partner, coverage }) {
  const btn = el('button', {
    class: 'btn btn--secondary btn--sm partner-board__pdf-btn',
    type: 'button',
  }, el('span', { class: 'forecast-board__pdf-icon', html: pdfIcon() }), 'Create PDF');

  btn.addEventListener('click', () => handleCreatePartnerPdf({ analysis, board, kpis, health, partner, coverage, btn }));
  return el('div', { class: 'forecast-board__actions' }, btn);
}

async function handleCreatePartnerPdf({ analysis, board, kpis, health, partner, coverage, btn }) {
  if (btn.disabled) return;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    const blob = await buildPartnerAnalysisPdf({
      analysis, board, partner, kpis, health,
      coverageWarnings: (coverage && coverage.warnings) || [],
    });
    const filename = partnerAnalysisFilename(analysis.partner_name || partner?.display_name || 'Partner');
    downloadBlob(blob, filename);
    showToast('Partner analysis PDF downloaded', 'success');
  } catch (err) {
    console.error('[Partner Analyzer] PDF export failed', err);
    showToast(err.message || 'Could not create the PDF', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ── Coverage banner (non-fatal notices) ─────────────────────────────
function buildPartnerCoverage(coverage) {
  const list = ((coverage && coverage.warnings) || []).filter(Boolean);
  if (!list.length) return null;
  return el('div', { class: 'forecast-coverage event-coverage' },
    el('span', { class: 'forecast-coverage__icon', html: warnIcon() }),
    el('span', { class: 'forecast-coverage__text' }, list.join(' ')),
  );
}

// ── Summary ─────────────────────────────────────────────────────────
// Partner maturity has NO forecast bucket and NO win probability. The summary
// shows the operational maturity stage, completed-stage count, criteria
// completion %, confidence, the CRM tier + status (as CONTEXT), partner type +
// region, last meaningful activity, and relationship health (separate from
// maturity). A note surfaces a tier-vs-evidence discrepancy when present.
function buildPartnerSummary({ analysis, board, kpis, health }) {
  const confidence = String(analysis.confidence || 'low');
  const pos = resolvePartnerPosition(board);
  const furthest = resolveFurthestDemonstrated(board);
  const completedStages = board.stages.filter(s => s.status === 'complete').length;

  const headline = pos.def
    ? (pos.mature ? `${pos.def.name} — Mature` : pos.def.name)
    : 'Not started';

  const chips = el('div', { class: 'event-summary__chips' },
    el('span', { class: 'event-summary__stage-chip' }, headline),
    el('span', { class: 'event-summary__pct-chip' }, `${board.completionPct}% of criteria`),
    el('span', { class: `event-summary__confidence event-summary__confidence--${confidence}` }, `Confidence: ${confidence}`),
    buildHealthChip(health),
  );

  const facts = el('div', { class: 'event-summary__facts' },
    summaryFact('Stages complete', `${completedStages} / ${PARTNER_STAGES.length}`),
    summaryFact('Criteria met', `${board.metCount} of ${board.totalCriteria}`),
    summaryFact('CRM tier', String(kpis.tier || '—').trim() || '—'),
    summaryFact('CRM status', String(kpis.status || '—').trim() || '—'),
    summaryFact('Type · Region', [kpis.partner_type, kpis.region].filter(Boolean).join(' · ') || '—'),
    summaryFact('Last activity', kpis.mostRecentActivityDate ? (formatDate(kpis.mostRecentActivityDate) || kpis.mostRecentActivityDate) : '—'),
  );

  const children = [
    el('div', { class: 'event-summary__eyebrow' }, 'Operational maturity'),
    chips,
    facts,
  ];

  // Later-stage demonstration despite earlier gaps.
  if (furthest.def && (!pos.def || furthest.index > pos.index) && !pos.mature) {
    children.push(el('div', { class: 'partner-summary__note' },
      el('span', { class: 'forecast-summary__note-icon', html: infoIcon() }),
      el('span', {}, `Demonstrates later-stage behavior up to “${furthest.def.name}” despite earlier-stage gaps.`),
    ));
  }

  // Tier-vs-evidence discrepancy (deterministic honesty surface).
  const disc = tierDiscrepancyNote(kpis.tier, pos, board);
  if (disc) {
    children.push(el('div', { class: 'partner-summary__note partner-summary__note--warn' },
      el('span', { class: 'forecast-summary__note-icon', html: warnIcon() }),
      el('span', {}, disc),
    ));
  }

  if (analysis.summary) {
    children.push(el('p', { class: 'event-summary__text' }, analysis.summary));
  }

  const stateClass = pos.mature ? 'event-summary--complete'
    : (pos.started ? 'event-summary--working' : 'event-summary--none');
  return el('div', { class: `event-summary partner-summary ${stateClass}` }, ...children);
}

// A high CRM tier not yet backed by evidence is worth reconciling. Fires only
// for the two advanced tiers when the operational stage is still early.
function tierDiscrepancyNote(tier, pos, board) {
  const t = String(tier || '').toLowerCase();
  const advancedTier = /premier|strategic|value|preferred/.test(t);
  if (!advancedTier || !pos.def || pos.mature) return '';
  // Early = still within the first four stages (before Market Engagement).
  if (board.operationalIndex >= 0 && board.operationalIndex <= 3) {
    return `CRM tier is ${tier}, but the available evidence only supports ${pos.def.name} maturity so far.`;
  }
  return '';
}

function buildHealthChip(health) {
  const status = String(health && health.status || 'insufficient_history');
  const label = String(health && health.label || 'Insufficient history');
  return el('span', { class: `partner-health-chip partner-health-chip--${status}` }, `Health: ${label}`);
}
// (summaryFact is shared with the Event summary above.)

// ── Deterministic KPI strip ─────────────────────────────────────────
function buildPartnerKpiStrip(kpis) {
  const k = kpis || {};
  const cells = [
    ['Transcripts', String(k.transcriptCount || 0)],
    ['Indexed meetings', String(k.meetingCount || 0)],
    ['Documents', String(k.documentCount || 0)],
    ['Partner events', String(k.eventCount || 0)],
    ['Total opportunities', String(k.totalOpps || 0)],
    ['Active pipeline', formatCurrencySafe(k.activePipelineValue)],
    ['Won revenue', formatCurrencySafe(k.wonRevenue)],
    ['Deals won', String(k.wonOppCount || 0)],
    ['Last activity', k.mostRecentActivityDate ? (formatDate(k.mostRecentActivityDate) || k.mostRecentActivityDate) : '—'],
  ];
  return el('div', { class: 'partner-kpi-strip', role: 'group', 'aria-label': 'Deterministic KPIs' },
    ...cells.map(([label, value]) => el('div', { class: 'partner-kpi' },
      el('div', { class: 'partner-kpi__value' }, value),
      el('div', { class: 'partner-kpi__label' }, label),
    )),
  );
}

function formatCurrencySafe(n) {
  const num = Number(n) || 0;
  return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// A status legend so completion is never conveyed by colour alone.
function buildPartnerLegend() {
  const item = (status, label) => el('span', { class: 'event-legend__item' },
    el('span', { class: `event-activity__icon event-activity__icon--${status}`, html: statusIcon(status) }),
    el('span', {}, label),
  );
  return el('div', { class: 'event-legend', role: 'note', 'aria-label': 'Status key' },
    item('met', 'Met'),
    item('partial', 'Partial'),
    item('not_met', 'Not met'),
    item('no_evidence', 'No evidence'),
  );
}

// ── Stage grid ──────────────────────────────────────────────────────
function buildPartnerGrid({ board, partner }) {
  const grid = el('div', { class: 'event-grid' });
  board.stages.forEach((stage) => {
    grid.appendChild(buildPartnerStageColumn({ stage, partner }));
  });
  return grid;
}

function buildPartnerStageColumn({ stage, partner }) {
  const chevron = el('div', { class: `event-chevron event-chevron--${stage.status}` },
    el('span', { class: 'event-chevron__num' }, String(stage.index + 1)),
    el('span', { class: 'event-chevron__name' }, stage.def.name),
    el('span', { class: 'event-chevron__meta' }, `${stage.metCount}/3 met`),
  );

  const list = el('ul', { class: 'event-activities' },
    ...stage.criteria.map(c => buildPartnerCriterionItem({ criterion: c, partner })),
  );

  const notes = stage.notes
    ? el('p', { class: 'event-stage__notes' }, stage.notes)
    : null;

  return el('div', { class: `event-stage event-stage--${stage.status}` }, chevron, list, notes);
}

function buildPartnerCriterionItem({ criterion, partner }) {
  const hasDetail = !!criterion.evidence || criterion.status === 'not_met' || criterion.source_type !== 'none';

  const head = el('button', {
    type: 'button',
    class: `event-activity__head ${hasDetail ? '' : 'event-activity__head--flat'}`,
    'aria-expanded': 'false',
    disabled: !hasDetail,
  },
    el('span', { class: `event-activity__icon event-activity__icon--${criterion.status}`, html: statusIcon(criterion.status) }),
    el('span', { class: 'event-activity__label' }, criterion.label),
    el('span', { class: 'event-activity__meta' },
      el('span', { class: `event-activity__status event-activity__status--${criterion.status}` }, partnerStatusLabel(criterion.status)),
    ),
  );

  const item = el('li', { class: `event-activity event-activity--${criterion.status}` }, head);

  if (hasDetail) {
    const detail = buildPartnerCriterionDetail({ criterion, partner });
    detail.hidden = true;
    head.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      item.classList.toggle('event-activity--open', open);
    });
    item.appendChild(detail);
  }
  return item;
}

function buildPartnerCriterionDetail({ criterion, partner }) {
  const rows = [];

  if (criterion.evidence) {
    rows.push(el('blockquote', { class: 'event-evidence__quote' }, criterion.evidence));
  } else if (criterion.status === 'not_met') {
    rows.push(el('p', { class: 'event-evidence__none' }, 'A source indicates this has not happened.'));
  } else if (criterion.source_type !== 'none') {
    rows.push(el('p', { class: 'event-evidence__none' }, 'Supported by a deterministic CRM fact.'));
  }

  const meta = [];
  if (criterion.source_type && criterion.source_type !== 'none') {
    meta.push(el('span', { class: 'event-evidence__type' }, partnerSourceTypeLabel(criterion.source_type)));
  }
  if (criterion.source_date) {
    meta.push(el('span', { class: 'event-evidence__date' }, formatDate(criterion.source_date) || criterion.source_date));
  }

  // A source link opens the correct CRM entity (opportunity / event / partner).
  if (criterion.source_type !== 'none') {
    meta.push(el('button', {
      type: 'button',
      class: 'event-evidence__link',
      onClick: () => openPartnerSource(criterion, partner),
    }, `${partnerSourceLinkLabel(criterion.source_type)} →`));
  }

  if (meta.length) rows.push(el('div', { class: 'event-evidence__meta' }, ...meta));
  return el('div', { class: 'event-evidence' }, ...rows);
}

// Open the right CRM record for a criterion's evidence: the correct opportunity
// modal, the correct event modal, or the selected partner's detail page.
async function openPartnerSource(criterion, partner) {
  const type = criterion.source_type;
  const relatedId = String(criterion.related_entity_id || '').trim();
  try {
    if ((type === 'opportunity' || type === 'opportunity_description') && relatedId) {
      const opps = await readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES).catch(() => []);
      const opp = opps.find(o => String(o.opportunity_id || '') === relatedId);
      if (opp) {
        openOppDetailsModal(opp, criterion.source_id && type === 'opportunity_description'
          ? { focusDescription: { id: criterion.source_id, date: criterion.source_date || '' } }
          : {});
        return;
      }
    }
    if ((type === 'event' || type === 'event_description' || type === 'event_contacts') && relatedId) {
      const events = await readSheetAsObjects(CONFIG.SHEET_EVENTS).catch(() => []);
      const ev = events.find(e => String(e.event_id || '') === relatedId);
      if (ev) {
        const { openEventModal } = await import('./admin-events.js');
        const container = document.getElementById('view-container') || document.body;
        await openEventModal(ev, container);
        return;
      }
    }
    // Fallback (transcripts, meetings, documents, partner_profile, or an
    // unresolved link): the selected partner's detail page.
    if (partner && partner.partner_id) navigate(`/admin/partner-detail?id=${partner.partner_id}`);
  } catch (err) {
    console.error('[Partner Analyzer] could not open source', err);
    showToast('Could not open the source record', 'error');
  }
}

function buildPartnerLists(analysis) {
  return el('div', { class: 'event-lists' },
    buildPartnerListCard('Do this next', 'The most useful next best actions', analysis.next_actions),
    buildPartnerListCard('Maturity gaps', 'What’s missing to advance the operational stage', analysis.gaps),
    buildPartnerListCard('Open questions', 'What the evidence leaves unanswered', analysis.open_questions),
    buildPartnerListCard('Relationship risks', 'Risks to the relationship', analysis.risks),
    buildPartnerListCard('Positive momentum', 'What’s going well', analysis.momentum),
  );
}

function buildPartnerListCard(title, subtitle, items) {
  const body = (items && items.length)
    ? el('ul', { class: 'forecast-checklist' }, ...items.map(t => buildEventCheckItem(t)))
    : el('p', { class: 'forecast-list__empty' }, 'Nothing flagged from the evidence.');
  return el('div', { class: 'forecast-list-card' },
    el('div', { class: 'forecast-list-card__title' }, title),
    el('div', { class: 'forecast-list-card__subtitle' }, subtitle),
    body,
  );
}

function partnerStatusLabel(status) {
  switch (status) {
    case 'met': return 'Met';
    case 'partial': return 'Partial';
    case 'not_met': return 'Not met';
    default: return 'No evidence';
  }
}

function partnerSourceTypeLabel(sourceType) {
  switch (sourceType) {
    case 'partner_profile': return 'Partner profile';
    case 'transcript': return 'Transcript';
    case 'meeting_index': return 'Indexed meeting';
    case 'partner_document': return 'Partner document';
    case 'opportunity': return 'Opportunity';
    case 'opportunity_description': return 'Opportunity note';
    case 'event': return 'Partner event';
    case 'event_description': return 'Event note';
    case 'event_contacts': return 'Event contacts';
    case 'saved_event_playbook': return 'Saved event playbook';
    default: return 'Source';
  }
}

function partnerSourceLinkLabel(sourceType) {
  if (sourceType === 'opportunity' || sourceType === 'opportunity_description') return 'Open opportunity';
  if (sourceType === 'event' || sourceType === 'event_description' || sourceType === 'event_contacts') return 'Open event';
  return 'Open partner';
}
