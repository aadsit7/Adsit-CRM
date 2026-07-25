// ============================================
// Quick Form — Floating Quick-Add Panel
// ============================================
// Surfaced via the form icon button on the Randy assistant widget.
// Lets admins create Opportunities, Partners, or Events without
// navigating to their respective admin pages. Partner and Opportunity
// tabs include a "New?" toggle: No (default) appends to an existing
// record; Yes shows the full new-record creation fields.

import { CONFIG } from '../config.js';
import { appendRow, updateRowById, isConfigured, addDemoRow, readSheetAsObjects } from '../sheets.js';
import { showToast } from './toast.js';
import { uuid } from '../utils/dom.js';
import { nowISO, todayISO } from '../utils/date.js';
import { getCurrentUser } from '../auth.js';
import { sha256 } from '../utils/hash.js';
import { TIER_OPTIONS } from '../utils/tiers.js';
import { initQuillEditor } from './quill-editor.js';

const OPP_STAGES    = ['Prospect', 'Qualified', 'Develop', 'Proposal', 'Negotiation', 'Closed'];
const OPP_STATUSES  = ['Registered', 'In Progress', 'Won', 'Lost'];
const PARTNER_TYPES = ['Technology', 'MSP/SI', 'OEM', 'MENA Regional Distributor'];
const EVENT_TYPES   = ['Webinar', 'Workshop', 'Conference', 'Campaign', 'Other'];
const EVENT_STATUSES = ['Upcoming', 'In Progress', 'Completed', 'Cancelled'];

const SUBMIT_LABELS = { event: 'Create Event' };

// false = append-to-existing (default); true = create new
const modeIsNew = { partner: false, opportunity: false };

let panelEl             = null;
let backdropEl          = null;
let isVisible           = false;
let isEmbedded          = false;   // true when mounted inline on the Randy page
let activeType          = 'opportunity';
let cachedPartners      = null;
let cachedOpportunities = null;
let activeDescEditor    = null; // Quill instance for opp description
let activeTransEditor   = null; // Quill instance for transcript

// ── Public API ────────────────────────────────────────────────────

export function initQuickForm() {
  if (panelEl) return;
  backdropEl = document.createElement('div');
  backdropEl.className = 'qf-backdrop';
  backdropEl.addEventListener('click', hidePanel);
  document.body.appendChild(backdropEl);

  panelEl = buildPanel();
  document.body.appendChild(panelEl);
}

export function toggleQuickForm() {
  if (!panelEl) initQuickForm();
  isVisible ? hidePanel() : showPanel();
}

export function isQuickFormVisible() {
  return isVisible;
}

// ── Embedded (dedicated-page) mode ────────────────────────────────
// The dedicated Randy page shows the Quick Add form inline in its right
// column rather than as a floating overlay. mountQuickFormInline()
// relocates the SAME panel into a host element and pins it open;
// unmountQuickFormInline() returns it to the body so the floating Randy
// "Add" button toggle keeps working everywhere else. It's the same
// singleton panel — never a second copy — so form state stays coherent.
export function mountQuickFormInline(hostEl) {
  if (!hostEl) return false;
  initQuickForm();
  if (!panelEl) return false;

  isEmbedded = true;
  hostEl.appendChild(panelEl);
  panelEl.classList.add('qf-panel--embedded');
  panelEl.classList.remove('qf-panel--visible');
  // Drop any inline positioning/size left by the floating path.
  panelEl.style.top = panelEl.style.left = panelEl.style.right = panelEl.style.bottom = '';
  panelEl.style.height = panelEl.style.maxHeight = '';
  panelEl.style.opacity = '';
  panelEl.style.transform = '';
  panelEl.style.display = 'flex';
  isVisible = true;

  if (!panelEl.dataset.bound) {
    panelEl.dataset.bound = '1';
    bindEvents();
  }

  Promise.all([loadPartners(), loadOpportunities()])
    .then(() => renderTypeForm(activeType))
    .catch(() => {});
  return true;
}

export function unmountQuickFormInline() {
  isEmbedded = false;
  if (!panelEl) return;
  panelEl.classList.remove('qf-panel--embedded');
  isVisible = false;
  panelEl.style.display = 'none';
  document.body.appendChild(panelEl);
}

// ── Panel lifecycle ───────────────────────────────────────────────

function showPanel() {
  if (!panelEl) return;
  isVisible = true;
  panelEl.style.display = 'flex';
  positionPanel();

  if (backdropEl) backdropEl.classList.add('qf-backdrop--visible');

  if (!panelEl.dataset.bound) {
    panelEl.dataset.bound = '1';
    bindEvents();
  }

  // Load reference data, then (re)render current type
  Promise.all([loadPartners(), loadOpportunities()]).then(() => renderTypeForm(activeType));

  requestAnimationFrame(() => panelEl.classList.add('qf-panel--visible'));
}

export function hidePanel() {
  if (!panelEl) return;
  // While embedded on the Randy page the form is always shown — ignore
  // dismissals (Escape, Cancel, close X, or a stray Add-button toggle).
  if (isEmbedded) return;
  panelEl.classList.remove('qf-panel--visible');
  isVisible = false;
  if (backdropEl) backdropEl.classList.remove('qf-backdrop--visible');
  setTimeout(() => { if (!isVisible && panelEl) panelEl.style.display = 'none'; }, 320);

  // Reflect toggle state on both Randy buttons
  updateToggleButtons(false);
}

// ── Positioning ───────────────────────────────────────────────────

function positionPanel() {
  // On mobile let CSS own the bottom-sheet layout; clear any inline styles
  if (window.innerWidth <= 768) {
    panelEl.style.top       = '';
    panelEl.style.left      = '';
    panelEl.style.bottom    = '';
    panelEl.style.right     = '';
    panelEl.style.height    = '';
    panelEl.style.maxHeight = '';
    return;
  }

  const PANEL_WIDTH = 340;
  const GAP = 12;

  // Prefer aligning with the open Randy window
  const randyWin = document.getElementById('randy-window');
  if (randyWin && getComputedStyle(randyWin).display !== 'none') {
    const r = randyWin.getBoundingClientRect();
    const top  = Math.max(20, r.top);
    const left = Math.max(20, r.left - PANEL_WIDTH - GAP);
    const availableHeight = window.innerHeight - top - 20;
    const matchedHeight = Math.min(r.height, availableHeight);
    panelEl.style.top       = top + 'px';
    panelEl.style.left      = left + 'px';
    panelEl.style.bottom    = 'auto';
    panelEl.style.right     = 'auto';
    panelEl.style.height    = matchedHeight + 'px';
    panelEl.style.maxHeight = matchedHeight + 'px';
    return;
  }

  panelEl.style.height = '';
  panelEl.style.maxHeight = '';

  // Collapsed state: appear above+left of the avatar button
  const randyBtn = document.getElementById('randy-btn');
  if (randyBtn) {
    const r = randyBtn.getBoundingClientRect();
    panelEl.style.bottom = (window.innerHeight - r.top + GAP) + 'px';
    panelEl.style.right  = (window.innerWidth  - r.right) + 'px';
    panelEl.style.top    = 'auto';
    panelEl.style.left   = 'auto';
    return;
  }

  panelEl.style.bottom = '80px';
  panelEl.style.right  = '20px';
  panelEl.style.top    = 'auto';
  panelEl.style.left   = 'auto';
}

// ── Panel DOM ─────────────────────────────────────────────────────

function buildPanel() {
  const el = document.createElement('div');
  el.className = 'qf-panel';
  el.id = 'qf-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Quick Add Form');
  el.style.display = 'none';

  el.innerHTML = `
    <div class="qf-header">
      <div class="qf-header__left">
        <svg class="qf-header__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span class="qf-header__title">Quick Add</span>
      </div>
      <button class="qf-close" id="qf-close-btn" aria-label="Close quick add form">&times;</button>
    </div>

    <div class="qf-type-selector" role="tablist" aria-label="Record type">
      <button class="qf-type-btn qf-type-btn--active" data-type="opportunity" role="tab" aria-selected="true">Opportunity</button>
      <button class="qf-type-btn" data-type="partner" role="tab" aria-selected="false">Partner</button>
      <button class="qf-type-btn" data-type="event" role="tab" aria-selected="false">Event</button>
    </div>

    <div class="qf-body" id="qf-body"></div>

    <div class="qf-footer">
      <button class="qf-btn qf-btn--secondary" id="qf-cancel-btn">Cancel</button>
      <button class="qf-btn qf-btn--primary"   id="qf-submit-btn">Add Description</button>
    </div>
  `;

  return el;
}

// ── Event binding ─────────────────────────────────────────────────

function bindEvents() {
  panelEl.querySelector('#qf-close-btn').addEventListener('click',  hidePanel);
  panelEl.querySelector('#qf-cancel-btn').addEventListener('click', hidePanel);
  panelEl.querySelector('#qf-submit-btn').addEventListener('click', handleSubmit);

  panelEl.querySelectorAll('.qf-type-btn').forEach(btn => {
    btn.addEventListener('click', () => switchType(btn.dataset.type));
  });

  document.addEventListener('keydown', onDocKeydown);
}

function onDocKeydown(e) {
  if (e.key === 'Escape' && isVisible) hidePanel();
}

// ── Type switching ────────────────────────────────────────────────

function switchType(type) {
  activeType = type;

  // Reset to append mode (No) whenever the tab changes
  if (type in modeIsNew) modeIsNew[type] = false;

  panelEl.querySelectorAll('.qf-type-btn').forEach(btn => {
    const active = btn.dataset.type === type;
    btn.classList.toggle('qf-type-btn--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const submitBtn = panelEl.querySelector('#qf-submit-btn');
  if (submitBtn) submitBtn.textContent = getSubmitLabel();

  renderTypeForm(type);
}

function getSubmitLabel() {
  if (activeType === 'partner')     return modeIsNew.partner     ? 'Add Partner'     : 'Add Transcript';
  if (activeType === 'opportunity') return modeIsNew.opportunity ? 'Add Opportunity' : 'Add Description';
  return SUBMIT_LABELS[activeType] || 'Submit';
}

// ── Data loading ──────────────────────────────────────────────────

async function loadPartners() {
  if (cachedPartners) return;
  try {
    const rows = await readSheetAsObjects(CONFIG.SHEET_PARTNERS);
    cachedPartners = rows.filter(p => String(p.is_admin).toUpperCase() !== 'TRUE');
  } catch {
    cachedPartners = [];
  }
}

async function loadOpportunities() {
  if (cachedOpportunities) return;
  try {
    const rows = await readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES);
    cachedOpportunities = rows;
  } catch {
    cachedOpportunities = [];
  }
}

// ── Form rendering ────────────────────────────────────────────────

function renderTypeForm(type) {
  const body = panelEl.querySelector('#qf-body');
  if (!body) return;
  activeDescEditor  = null;
  activeTransEditor = null;
  body.innerHTML = '';

  const frag = {
    opportunity: buildOpportunityFields,
    partner:     buildPartnerFields,
    event:       buildEventFields,
  }[type]?.() || document.createDocumentFragment();

  body.appendChild(frag);
  postRenderSetup(type);
}

function postRenderSetup(type) {
  if (type === 'partner') {
    const modeBody = panelEl.querySelector('.qf-mode-body');
    if (modeBody) renderPartnerModeBody(modeBody, modeIsNew.partner);
  } else if (type === 'opportunity') {
    const modeBody = panelEl.querySelector('.qf-mode-body');
    if (modeBody) {
      renderOppModeBody(modeBody, modeIsNew.opportunity);
      if (!modeIsNew.opportunity) wireOppNoteFilters();
    }
  }
}

// ── Tab form builders ─────────────────────────────────────────────

function buildOpportunityFields() {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildModeToggle('New Opportunity?', 'opportunity'));
  const modeBody = document.createElement('div');
  modeBody.className = 'qf-mode-body';
  frag.appendChild(modeBody);
  return frag;
}

function buildPartnerFields() {
  const frag = document.createDocumentFragment();
  frag.appendChild(buildModeToggle('New Partner?', 'partner'));
  const modeBody = document.createElement('div');
  modeBody.className = 'qf-mode-body';
  frag.appendChild(modeBody);
  return frag;
}

function buildEventFields() {
  const frag = document.createDocumentFragment();

  frag.appendChild(field('title', 'Event Name', 'text', true, 'e.g., Q2 Partner Kickoff Webinar'));

  const row1 = row();
  row1.appendChild(field('event_date', 'Start Date', 'date', true));
  row1.appendChild(field('end_date',   'End Date',   'date', false));
  frag.appendChild(row1);

  const row2 = row();
  row2.appendChild(selectField('event_type', 'Type', true, [
    { value: '', label: 'Select type…' },
    ...EVENT_TYPES.map(t => ({ value: t, label: t })),
  ]));
  row2.appendChild(selectField('status', 'Status', false,
    EVENT_STATUSES.map(s => ({ value: s, label: s })), 'Upcoming'
  ));
  frag.appendChild(row2);

  frag.appendChild(selectField('partner_id', 'Assigned Partner', false, [
    { value: '', label: 'All Partners (no specific partner)' },
    ...(cachedPartners || []).map(p => ({ value: p.partner_id, label: p.display_name })),
  ]));

  frag.appendChild(field('location',    'Location',    'text',     false, 'e.g., Virtual (Zoom), San Francisco, CA'));
  frag.appendChild(field('description', 'Description', 'textarea', false, 'Describe the event…'));

  return frag;
}

// ── Mode toggle widget ────────────────────────────────────────────

function buildModeToggle(label, stateKey) {
  const wrap = document.createElement('div');
  wrap.className = 'qf-mode-toggle';

  const lbl = document.createElement('span');
  lbl.className = 'qf-mode-label';
  lbl.textContent = label;
  wrap.appendChild(lbl);

  const grp = document.createElement('div');
  grp.className = 'qf-toggle-group';

  // Reflect the persisted mode so a re-render (e.g. the dashboard rebuilds
  // when a type filter changes) keeps the toggle in sync with the body,
  // which postRenderSetup draws from modeIsNew.
  const isNewNow = !!modeIsNew[stateKey];

  ['No', 'Yes'].forEach(val => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const active = (val === 'Yes') === isNewNow;
    btn.className = 'qf-toggle-btn' + (active ? ' qf-toggle-btn--active' : '');
    btn.textContent = val;

    btn.addEventListener('click', () => {
      const isNew = val === 'Yes';
      if (modeIsNew[stateKey] === isNew) return;
      modeIsNew[stateKey] = isNew;

      grp.querySelectorAll('.qf-toggle-btn').forEach(b => {
        b.classList.toggle('qf-toggle-btn--active', b === btn);
      });

      const modeBody = panelEl.querySelector('.qf-mode-body');
      if (modeBody) {
        activeDescEditor  = null;
        activeTransEditor = null;
        modeBody.innerHTML = '';
        if (stateKey === 'partner') {
          renderPartnerModeBody(modeBody, isNew);
        } else {
          renderOppModeBody(modeBody, isNew);
          if (!isNew) wireOppNoteFilters();
        }
      }

      const submitBtn = panelEl.querySelector('#qf-submit-btn');
      if (submitBtn) submitBtn.textContent = getSubmitLabel();
    });

    grp.appendChild(btn);
  });

  wrap.appendChild(grp);
  return wrap;
}

// ── Mode body renderers ───────────────────────────────────────────

function renderPartnerModeBody(container, isNew) {
  if (isNew) {
    container.appendChild(field('username',     'Username',     'text', true, 'e.g., nerdio'));
    container.appendChild(field('display_name', 'Company Name', 'text', true, 'e.g., Nerdio'));

    const r1 = row();
    r1.appendChild(selectField('partner_type', 'Partner Type', true, [
      { value: '', label: 'Select type…' },
      ...PARTNER_TYPES.map(t => ({ value: t, label: t })),
    ]));
    r1.appendChild(selectField('tier', 'Tier', true, [
      { value: '', label: 'Select tier…' },
      ...TIER_OPTIONS.map(t => ({ value: t, label: t })),
    ]));
    container.appendChild(r1);

    const r2 = row();
    r2.appendChild(field('region', 'Region', 'text', true, 'e.g., North America'));
    r2.appendChild(selectField('status', 'Status', false,
      [{ value: 'engaged', label: 'Engaged' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], 'engaged'
    ));
    container.appendChild(r2);

    container.appendChild(field('hq_location', 'HQ Location', 'text', false, 'e.g., Chicago, Illinois, USA'));
  } else {
    container.appendChild(selectField('partner_id', 'Partner', true, [
      { value: '', label: 'Select partner…' },
      ...(cachedPartners || []).map(p => ({ value: p.partner_id, label: p.display_name })),
    ]));

    const dateWrap = field('conversation_date', 'Conversation Date', 'date', true);
    const dateInput = dateWrap.querySelector('input');
    if (dateInput) dateInput.value = todayISO();
    container.appendChild(dateWrap);

    activeTransEditor = initQuillEditor({ placeholder: 'Paste or type the call transcript here…' });
    const transcriptField = document.createElement('div');
    transcriptField.className = 'qf-field';
    transcriptField.appendChild(makeLabel('transcript_text', 'Transcript', true));
    transcriptField.appendChild(activeTransEditor.wrapper);
    transcriptField.appendChild(errEl('transcript_text'));
    container.appendChild(transcriptField);
    requestAnimationFrame(() => activeTransEditor.mount());
  }
}

function renderOppModeBody(container, isNew) {
  if (isNew) {
    container.appendChild(field('deal_name',     'Deal Name',     'text',   true,  'e.g., Enterprise Cloud Migration'));
    container.appendChild(field('customer_name', 'Customer Name', 'text',   true,  'e.g., Acme Corp'));
    container.appendChild(selectField('partner_id', 'Partner', true, [
      { value: '', label: 'Select partner…' },
      ...(cachedPartners || []).map(p => ({ value: p.partner_id, label: p.display_name })),
    ]));

    const r1 = row();
    r1.appendChild(field('deal_value',     'Deal Value ($)',  'number', true, '0'));
    r1.appendChild(field('expected_close', 'Expected Close',  'date',   true));
    container.appendChild(r1);

    const r2 = row();
    r2.appendChild(selectField('stage', 'Stage', true, [
      { value: '', label: 'Select stage…' },
      ...OPP_STAGES.map(s => ({ value: s, label: s })),
    ]));
    r2.appendChild(selectField('status', 'Status', false,
      OPP_STATUSES.map(s => ({ value: s, label: s })), 'Registered'
    ));
    container.appendChild(r2);
  } else {
    container.appendChild(selectField('filter_partner_id', 'Filter by Partner', false, [
      { value: '', label: 'All partners…' },
      ...(cachedPartners || []).map(p => ({ value: p.partner_id, label: p.display_name })),
    ]));

    container.appendChild(selectField('opportunity_id', 'Opportunity', true, [
      { value: '', label: 'Select opportunity…' },
      ...(cachedOpportunities || []).map(o => ({ value: o.opportunity_id, label: o.deal_name })),
    ]));

    const dateWrap = field('description_date', 'Description Date', 'date', true);
    const dateInput = dateWrap.querySelector('input');
    if (dateInput) dateInput.value = todayISO();
    container.appendChild(dateWrap);

    activeDescEditor = initQuillEditor({ placeholder: 'Add or update the opportunity description…' });
    const descField = document.createElement('div');
    descField.className = 'qf-field';
    descField.appendChild(makeLabel('description_text', 'Description', true));
    descField.appendChild(activeDescEditor.wrapper);
    descField.appendChild(errEl('description_text'));
    container.appendChild(descField);
    requestAnimationFrame(() => activeDescEditor.mount());
  }
}

// ── Filter cascade (opp note mode) ───────────────────────────────

function wireOppNoteFilters() {
  const partnerFilter = panelEl.querySelector('#qf-filter_partner_id');
  const oppSelect     = panelEl.querySelector('#qf-opportunity_id');
  if (!partnerFilter || !oppSelect) return;

  partnerFilter.addEventListener('change', () => {
    const partnerId = partnerFilter.value;
    const filtered  = (cachedOpportunities || []).filter(o => !partnerId || o.partner_id === partnerId);

    oppSelect.innerHTML = '';
    [{ value: '', label: 'Select opportunity…' }, ...filtered.map(o => ({ value: o.opportunity_id, label: o.deal_name }))]
      .forEach(({ value, label: lbl }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = lbl;
        oppSelect.appendChild(opt);
      });
  });
}

// ── Field helpers ─────────────────────────────────────────────────

function field(name, label, type, required, placeholder = '') {
  const wrap = document.createElement('div');
  wrap.className = 'qf-field';

  wrap.appendChild(makeLabel(name, label, required));

  let input;
  if (type === 'textarea') {
    input = document.createElement('textarea');
    input.className = 'qf-input qf-textarea';
    input.placeholder = placeholder;
    input.rows = 3;
    input.setAttribute('autocorrect', 'on');
    input.setAttribute('autocapitalize', 'sentences');
  } else {
    input = document.createElement('input');
    input.className = 'qf-input';
    input.type = type;
    input.placeholder = placeholder;
    if (type === 'number') {
      input.min = '0';
      input.step = 'any';
      input.setAttribute('inputmode', 'decimal');
    } else if (type === 'email') {
      input.setAttribute('inputmode', 'email');
      input.setAttribute('autocapitalize', 'none');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');
    } else if (type === 'tel') {
      input.setAttribute('inputmode', 'tel');
    } else if (type === 'url') {
      input.setAttribute('inputmode', 'url');
      input.setAttribute('autocapitalize', 'none');
      input.setAttribute('autocorrect', 'off');
    } else if (type === 'text') {
      // username: no caps, no autocorrect
      if (name === 'username') {
        input.setAttribute('autocapitalize', 'none');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('spellcheck', 'false');
      } else {
        // names, titles, locations benefit from word-caps
        input.setAttribute('autocapitalize', 'words');
      }
    }
  }
  input.id   = `qf-${name}`;
  input.name = name;
  input.dataset.required = required ? 'true' : 'false';

  wrap.appendChild(input);
  wrap.appendChild(errEl(name));
  return wrap;
}

function selectField(name, label, required, options, defaultValue = '') {
  const wrap = document.createElement('div');
  wrap.className = 'qf-field';

  wrap.appendChild(makeLabel(name, label, required));

  const sel = document.createElement('select');
  sel.className = 'qf-input qf-select';
  sel.id   = `qf-${name}`;
  sel.name = name;
  sel.dataset.required = required ? 'true' : 'false';

  options.forEach(({ value, label: lbl }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = lbl;
    sel.appendChild(opt);
  });

  if (defaultValue) sel.value = defaultValue;

  wrap.appendChild(sel);
  wrap.appendChild(errEl(name));
  return wrap;
}

function makeLabel(name, label, required) {
  const lbl = document.createElement('label');
  lbl.className = 'qf-label';
  lbl.htmlFor   = `qf-${name}`;
  lbl.textContent = label;
  if (required) {
    const star = document.createElement('span');
    star.textContent = ' *';
    star.style.color = 'var(--color-danger, #dc2626)';
    lbl.appendChild(star);
  }
  return lbl;
}

function errEl(name) {
  const d = document.createElement('div');
  d.className = 'qf-error';
  d.id = `qf-err-${name}`;
  return d;
}

function row() {
  const d = document.createElement('div');
  d.className = 'qf-row';
  return d;
}

// ── Validation ────────────────────────────────────────────────────

function validate() {
  const body = panelEl.querySelector('#qf-body');
  if (!body) return false;
  let valid = true;

  body.querySelectorAll('.qf-error').forEach(el => { el.textContent = ''; });
  body.querySelectorAll('.qf-input').forEach(el => el.classList.remove('qf-input--error'));

  body.querySelectorAll('[data-required="true"]').forEach(input => {
    if (!input.value.trim()) {
      const lbl = body.querySelector(`label[for="${input.id}"]`);
      const text = lbl ? lbl.textContent.replace(/\s*\*$/, '').trim() : input.name;
      const err  = body.querySelector(`#qf-err-${input.name}`);
      if (err) err.textContent = `${text} is required`;
      input.classList.add('qf-input--error');
      valid = false;
    }
  });

  // Validate Quill editors (they replace textareas, so not caught above)
  if (activeTransEditor && activeTransEditor.isEmpty()) {
    const err = body.querySelector('#qf-err-transcript_text');
    if (err) err.textContent = 'Transcript is required';
    valid = false;
  }
  if (activeDescEditor && activeDescEditor.isEmpty()) {
    const err = body.querySelector('#qf-err-description_text');
    if (err) err.textContent = 'Description is required';
    valid = false;
  }

  return valid;
}

// ── Submission ────────────────────────────────────────────────────

function collectData() {
  const data = {};
  panelEl.querySelectorAll('#qf-body [name]').forEach(inp => {
    data[inp.name] = inp.value.trim();
  });
  // Quill editors aren't standard inputs — pull HTML directly
  if (activeTransEditor) data.transcript_text  = activeTransEditor.getHtml();
  if (activeDescEditor)  data.description_text = activeDescEditor.getHtml();
  return data;
}

async function handleSubmit() {
  if (!validate()) return;

  const data      = collectData();
  const submitBtn = panelEl.querySelector('#qf-submit-btn');
  submitBtn.disabled    = true;
  submitBtn.textContent = 'Saving…';

  try {
    switch (activeType) {
      case 'opportunity':
        modeIsNew.opportunity ? await submitOpportunity(data) : await submitOppNote(data);
        break;
      case 'partner':
        modeIsNew.partner ? await submitPartner(data) : await submitTranscript(data);
        break;
      case 'event':
        await submitEvent(data);
        break;
    }
    hidePanel();
  } catch (err) {
    showToast(err.message || 'Failed to save. Please try again.', 'error');
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = getSubmitLabel();
  }
}

async function submitOpportunity(data) {
  const now    = nowISO();
  const oppId  = uuid('opp');
  const values = [
    oppId, data.partner_id, data.deal_name, data.customer_name,
    data.deal_value, data.status || 'Registered', data.stage,
    data.expected_close, '', now, now, '', 'salesperson',
  ];

  if (isConfigured()) {
    await appendRow(CONFIG.SHEET_OPPORTUNITIES, values);
  } else {
    addDemoRow(CONFIG.SHEET_OPPORTUNITIES, values);
  }
  showToast('Opportunity created!', 'success');
}

async function submitPartner(data) {
  const passwordHash = await sha256(CONFIG.DEFAULT_PASSWORD);
  const values = [
    uuid('p'), data.username, data.display_name, data.partner_type,
    data.tier, data.region, nowISO(), 'FALSE', passwordHash,
    data.status || 'engaged', data.hq_location || '',
  ];

  if (isConfigured()) {
    await appendRow(CONFIG.SHEET_PARTNERS, values);
  } else {
    addDemoRow(CONFIG.SHEET_PARTNERS, values);
  }
  cachedPartners = null; // invalidate so dropdowns refresh next open
  showToast('Partner added!', 'success');
}

async function submitEvent(data) {
  const user   = getCurrentUser();
  const values = [
    uuid('evt'), data.title, data.description || '', data.event_date,
    data.end_date || data.event_date, data.event_type, data.location || '',
    data.url || '', user?.partner_id || '', nowISO(), data.status || 'Upcoming',
    data.partner_id || '', '[]',
  ];

  if (isConfigured()) {
    await appendRow(CONFIG.SHEET_EVENTS, values);
  } else {
    addDemoRow(CONFIG.SHEET_EVENTS, values);
  }
  showToast('Event created!', 'success');
}

async function submitTranscript(data) {
  const now     = nowISO();
  const partner = (cachedPartners || []).find(p => p.partner_id === data.partner_id);
  const values  = [
    uuid('trn'),
    data.partner_id,
    partner?.display_name || '',
    data.conversation_date,
    data.transcript_text,
    now,
  ];

  if (isConfigured()) {
    await appendRow(CONFIG.SHEET_TRANSCRIPTS, values);
  } else {
    addDemoRow(CONFIG.SHEET_TRANSCRIPTS, values);
  }
  showToast(`Transcript added for ${partner?.display_name || 'partner'}!`, 'success');
}

async function submitOppNote(data) {
  const now = nowISO();
  const opp = (cachedOpportunities || []).find(o => o.opportunity_id === data.opportunity_id);

  const descValues = [
    uuid('dsc'),
    data.opportunity_id,
    opp?.deal_name || '',
    data.description_date,
    data.description_text,
    now,
  ];

  if (isConfigured()) {
    await appendRow(CONFIG.SHEET_OPP_DESCRIPTIONS, descValues);
    if (opp?.opportunity_id) {
      // Only `description` and `updated_at` are being set here; every other
      // column is read back from the sheet so adding a description cannot
      // revert an edit made elsewhere since this form was opened.
      await updateRowById(CONFIG.SHEET_OPPORTUNITIES, 'opportunity_id', opp.opportunity_id, (fresh) => [
        fresh.opportunity_id, fresh.partner_id, fresh.deal_name, fresh.customer_name,
        fresh.deal_value, fresh.status, fresh.stage, fresh.expected_close,
        data.description_text, fresh.created_at, now,
        fresh.notes || '', fresh.lead_source || 'salesperson',
      ]);
    }
  } else {
    addDemoRow(CONFIG.SHEET_OPP_DESCRIPTIONS, descValues);
  }

  cachedOpportunities = null; // invalidate so next open reflects the update
  showToast(`Description added to "${opp?.deal_name || 'opportunity'}"!`, 'success');
}

// ── Toggle button state helper ────────────────────────────────────
// Called by randy.js to keep both toggle buttons in sync.

function updateToggleButtons(active) {
  ['randy-form-btn', 'randy-form-bottom-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('randy-form-btn--active', active);
  });
}
