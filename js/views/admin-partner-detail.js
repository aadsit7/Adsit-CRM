// ============================================
// Admin Partner Detail View
// ============================================

import { readSheetAsObjects, appendRow, appendRows, updateRowById, updateRowsById, deleteRowById, isConfigured, addDemoRow, ensureSheetWithHeaders } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, formatCurrency, uuid } from '../utils/dom.js';
import { formatDate, todayISO, nowISO } from '../utils/date.js';
import { navigate, getCurrentPath, getQueryParams } from '../router.js';
import { tierSlug } from '../utils/tiers.js';
import { dealCard } from '../components/card.js';
import { openModal, closeModal, confirmDialog } from '../components/modal.js';
import { openEventModal } from './admin-events.js';
import { openOppModal } from './admin-opportunities.js';
import { setTopbar, setTopbarTitle } from '../components/sidebar.js';
import { showToast } from '../components/toast.js';
import { filterOpportunities, filterEvents } from '../utils/filters.js';
import { stripHtml, ensureHtml, initQuillEditor } from '../components/quill-editor.js';
import { buildDocumentsPanel, listEntityDocuments } from '../components/documents-panel.js';
import { fileApiRequest } from '../utils/file-api.js';
import {
  PARTNER_CONTACT_HEADERS,
  collectPartnerContactSources,
  attendeeContactsToExtracted,
  mergeExtractedContacts,
  partnerContactRowValues,
  partnerContactFromRow,
  sortContactsForDisplay,
  applyPartnerCompanyDefaults,
} from '../utils/partner-contacts.js';
import { requestPartnerContactsExtraction } from '../utils/partner-contacts-client.js';
import {
  withoutAnalyzerExports,
  indexContactAnalyzerPdfs,
  findContactAnalyzerPdf,
} from '../utils/analyzer-export-files.js';
import { fileStoreKey, legacyFileStoreKey } from '../utils/file-store-keys.js';
import { initMobileSections } from '../utils/mobile-sections.js';
import {
  LEADCHECK_FRESH_DAYS,
  NO_DIRECT_REPORTS_NOTE,
  checklistItemLabel,
  assessLeadCheckInput,
  buildLeadCheckSnapshot,
  contactFingerprint,
  parseAnalysisRecord,
  buildAnalysisRecord,
  shrinkAnalysisRecordToFit,
  applyAnalysisRoleToContact,
  applyAnalysisRoleBackfill,
  leadCheckButtonState,
  leadCheckReportToPlainText,
} from '../utils/partner-contact-leadcheck.js';
import {
  requestLeadCheckAnalysis,
  LEADCHECK_STALL_MS,
} from '../utils/partner-contact-leadcheck-client.js';
import { createResearchProgress, researchFailureText } from '../utils/research-progress.js';
import {
  PARTNER_BIO_HEADERS,
  NA,
  partnerBioRowValues,
  partnerBioToMarkdown,
  partnerBioIsEmpty,
  selectPartnerBioRow,
} from '../utils/partner-bio-schema.js';
import { requestPartnerBio, BIO_MAX_ROUNDS } from '../utils/partner-bio-client.js';
import {
  PARTNER_NEXT_STEP_HEADERS,
  NEXT_STEP_STATUSES,
  nextStepRowValues,
  nextStepFromRow,
  selectPartnerNextSteps,
  groupNextStepsIntoRuns,
  MANUAL_STEPS_GROUP_KEY,
  lastAnalyzedAt,
  sanitizeNoteTextForAnalysis,
} from '../utils/partner-next-steps-schema.js';
import { requestPartnerNextSteps } from '../utils/partner-next-steps-client.js';
import { createPill, updatePillStage, setPillProgress, markPillSuccess, markPillFailure } from '../components/map-pdf-pill.js';
import { ICONS, iconButton } from '../components/icon-button.js';
import { sectionIcon } from '../components/section-icon.js';

export const title = 'Partner Detail';

export async function render(container, params) {
  const partnerId = params?.id;

  if (!partnerId) {
    navigate('/admin/dashboard');
    return;
  }

  setTopbarTitle('Partner Detail');
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    // Partner_Contacts may not exist yet in older spreadsheets (it is created
    // on first scan / via Setup → Initialize Sheet), so its read — like the
    // optional Meeting_Index — must never take down the whole page.
    // The document store is read here too, so the Contacts table can link each
    // contact to their Analyzer brief. It is ONE cached Sheets read covering
    // every contact on the page — the alternative, an Apps Script listFiles per
    // contact, would be dozens of round-trips for one column. It runs in
    // parallel with the reads the page already needs, so it costs no extra
    // wall-clock, and a failure (or a spreadsheet with no such tab yet) just
    // means no links, never a broken page.
    const [partners, opportunities, events, transcripts, contactRows, documentRows, bioRows, nextStepRows] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_PARTNERS),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
      readSheetAsObjects(CONFIG.SHEET_EVENTS),
      readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS),
      readSheetAsObjects(CONFIG.SHEET_PARTNER_CONTACTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITY_DOCUMENTS).catch(() => []),
      // Partner_Bios is created on the first Analyze run, so a spreadsheet
      // that has never had one simply has no such tab — never a page error.
      readSheetAsObjects(CONFIG.SHEET_PARTNER_BIOS).catch(() => []),
      // Partner_Next_Steps is created on the first Analyze / Add Step, so a
      // spreadsheet without it simply shows an empty agenda — never an error.
      readSheetAsObjects(CONFIG.SHEET_PARTNER_NEXT_STEPS).catch(() => []),
    ]);

    const partner = partners.find(p => p.partner_id === partnerId);
    if (!partner) {
      mount(container, el('div', { class: 'empty-state' },
        el('div', { class: 'empty-state__title' }, 'Partner not found'),
        el('button', { class: 'btn btn--primary', onClick: () => navigate('/admin/dashboard') }, 'Back to Dashboard')
      ));
      return;
    }

    const partnerOpps = filterOpportunities(opportunities).filter(o => o.partner_id === partnerId);
    const partnerEvents = filterEvents(events).filter(e => !e.partner_id || e.partner_id === partnerId);
    const partnerTranscripts = transcripts
      .filter(t => t.partner_id === partnerId)
      .sort((a, b) => new Date(b.conversation_date || b.created_at) - new Date(a.conversation_date || a.created_at));
    const partnerContacts = sortContactsForDisplay(
      contactRows
        .filter(c => String(c.partner_id || '').trim() === partnerId)
        .map(partnerContactFromRow)
    );

    // Company backfill: every row in this table is a partner-side person
    // (the affiliation rule), so a blank Company means the partner itself.
    // Fill it for this render and persist the fix to Partner_Contacts in
    // the background — the sheet then carries the company on every contact,
    // for this page and any other reader of the spreadsheet. One-time per
    // row: once saved, later loads find nothing blank.
    const companyBackfill = applyPartnerCompanyDefaults(partnerContacts, partner.display_name, nowISO());
    // Role backfill: a stored analysis that identified the person's role —
    // under the strict gates in verifiedRoleFromAnalysis (completed run,
    // CONFIRMED identity, multi-source title, unchanged identity fields) —
    // fills an EMPTY Role field on the row. A role already on file is
    // never replaced. Covers analyses executed before this write-back
    // existed; new analyses fill the role in their own save.
    const roleBackfill = applyAnalysisRoleBackfill(partnerContacts, nowISO());
    const contactBackfill = [...new Set([...companyBackfill, ...roleBackfill])];
    if (contactBackfill.length && !contactBackfillPromise) {
      contactBackfillPromise = persistContactBackfill(contactBackfill)
        .finally(() => { contactBackfillPromise = null; });
    }

    // contact_id → their newest Analyzer brief (or nothing). Keyed on the raw
    // file-store key, so only a file actually filed against that contact can
    // ever surface on their row.
    const contactPdfIndex = indexContactAnalyzerPdfs(documentRows);

    // The saved Partner Bio, if this partner has been researched. The
    // session fallback covers the window where the write did not land (demo
    // mode, or a save that failed after the research succeeded) — the user
    // still sees the profile they just paid for instead of an empty panel.
    const bioRecord = selectPartnerBioRow(bioRows, partnerId) || partnerBioSessionCache.get(partnerId) || null;

    // The saved next-steps rows: every analysis run's snapshot plus the
    // manual rows, in stored order (see selectPartnerNextSteps) — the
    // section groups them into the analysis log's entries.
    const partnerNextSteps = selectPartnerNextSteps(nextStepRows, partnerId);

    renderDetail(container, partner, partnerOpps, partnerEvents, partnerTranscripts, partnerContacts, contactPdfIndex, bioRecord, partnerNextSteps);
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading data'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

function reRender(partnerId) {
  const viewContainer = document.getElementById('view-container');
  render(viewContainer, { id: partnerId });
}

function renderDetail(container, partner, opportunities, partnerEvents, transcripts, partnerContacts = [], contactPdfIndex = null, bioRecord = null, nextSteps = []) {
  const tierClass = tierSlug(partner.tier);
  const pipelineValue = opportunities.filter(o => o.status !== 'Won').reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const wonDeals = opportunities.filter(o => o.status === 'Won');
  const wonValue = wonDeals.reduce((s, o) => s + (parseFloat(o.deal_value) || 0), 0);
  const totalValue = pipelineValue + wonValue;
  const sortedEvents = [...partnerEvents].sort((a, b) => new Date(b.event_date) - new Date(a.event_date));

  // Topbar header: eyebrow "PARTNER" + meta carrying name, tier, type, region
  const metaParts = [partner.display_name, partner.tier, partner.partner_type, partner.region].filter(Boolean);
  setTopbar({
    title: 'Partner',
    meta: '· ' + metaParts.join(' · '),
    actions: el('a', {
      class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary',
      href: '#/admin/dashboard',
      onClick: (e) => { e.preventDefault(); navigate('/admin/dashboard'); },
    },
      el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
      'Dashboard',
    ),
  });

  const initials = (partner.display_name || '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';

  // Documents — drag-drop file uploads + AI "Analyze", the same panel used in
  // the Opportunities and Events modals. Built here so its refresh() handle can
  // be invoked after mount (below). See buildPartnerDocumentsSection.
  const { section: documentsSection, docsHandle } = buildPartnerDocumentsSection(partner);

  const content = el('div', { class: 'partner-detail-page' },
    // Hero: condensed metadata strip + flat Revenue chart card
    el('div', { class: 'partner-detail-page__hero' },
      el('div', { class: 'partner-detail-page__hero-strip' },
        el('div', { class: 'partner-detail-page__hero-info' },
          el('div', {
            class: `partner-detail-page__hero-avatar partner-detail-page__hero-avatar--${tierClass}`,
          }, initials),
          el('div', { class: 'partner-detail-page__hero-text' },
            el('div', { class: 'partner-detail-page__hero-name-row' },
              el('h2', { class: 'partner-detail-page__hero-name' }, partner.display_name),
              partner.tier
                ? el('span', { class: 'partner-detail-page__hero-tier' }, partner.tier)
                : null,
              // Sits with the name because that is what it researches — the
              // company, not the CRM relationship. Icon-only: a labeled pill
              // here crowded the name row at laptop widths until it collided
              // with the stat cells; the labeled twin lives in the Bio
              // section header below.
              buildBioAnalyzeButton(partner, bioRecord, { iconOnly: true }),
            ),
            metaParts.length > 1
              ? el('div', { class: 'partner-detail-page__hero-meta' },
                  partner.partner_type
                    ? el('span', { class: 'partner-detail-page__hero-meta-item' }, partner.partner_type)
                    : null,
                  partner.region
                    ? el('span', { class: 'partner-detail-page__hero-meta-item' }, partner.region)
                    : null,
                  partner.hq_location
                    ? el('span', { class: 'partner-detail-page__hero-meta-item' }, partner.hq_location)
                    : null,
                )
              : null,
          ),
        ),
        el('div', { class: 'partner-detail-page__hero-stats' },
          el('div', { class: 'partner-detail-page__hero-cell' },
            el('div', { class: 'partner-detail-page__hero-label' }, 'Deals'),
            el('div', { class: 'partner-detail-page__hero-value' }, String(opportunities.length)),
          ),
          el('div', { class: 'partner-detail-page__hero-cell' },
            el('div', { class: 'partner-detail-page__hero-label' }, 'Pipeline'),
            el('div', { class: 'partner-detail-page__hero-value' }, formatCurrency(pipelineValue)),
          ),
          el('div', { class: 'partner-detail-page__hero-cell' },
            el('div', { class: 'partner-detail-page__hero-label' }, 'Won'),
            el('div', { class: 'partner-detail-page__hero-value' }, formatCurrency(wonValue)),
          ),
        ),
      ),
      buildPartnerRevenueByEvent(partnerEvents, opportunities),
    ),

    // Section 0: Partner Bio — the researched company profile, directly under
    // the hero because it answers "who is this company" before anything about
    // our pipeline with them makes sense.
    buildPartnerBioSection(partner, bioRecord),

    // Section 0.5: Next Steps — the mutual action plan, between the bio (who the
    // company is) and the events/pipeline (what we are doing with them),
    // because "what happens next" is the question those notes answer.
    buildNextStepsSection(partner, nextSteps, transcripts),

    // Section 1: Upcoming Joint Events
    buildUpcomingEventsSection(sortedEvents, partner, container),

    // Section 2: Opportunities — eyebrow header + 4-cell stat strip + deal cards
    el('div', { class: 'partner-detail-page__section' },
      el('div', { class: 'partner-detail-page__section-header' },
        el('div', { class: 'partner-detail-page__section-title' },
          sectionIcon('briefcase', 'blue', { size: 'sm' }),
          'Opportunities',
          el('span', { class: 'partner-detail-page__section-count' }, String(opportunities.length)),
        ),
        el('div', { class: 'partner-detail-page__section-actions' },
          el('button', {
            class: 'partner-detail-page__section-cta',
            onClick: () => {
              openOppModal(null, null, () => reRender(partner.partner_id));
              setTimeout(() => {
                const sel = document.querySelector('#field-partner_id');
                if (sel) { sel.value = partner.partner_id; }
              }, 50);
            },
          },
            el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
            'New Opportunity',
          ),
        ),
      ),

      el('div', { class: 'partner-detail-page__stat-strip stagger' },
        buildPartnerStatCell('Total Deals', String(opportunities.length)),
        buildPartnerStatCell('Active Pipeline', formatCurrency(totalValue)),
        buildPartnerStatCell('Deals Won', String(wonDeals.length)),
        buildPartnerStatCell('Revenue Won', formatCurrency(wonValue)),
      ),

      opportunities.length > 0
        ? el('div', { class: 'card-grid stagger' },
            ...opportunities.map(opp => dealCard(opp, {
              onEdit: (o) => openOppModal(o, null, () => reRender(partner.partner_id)),
            }))
          )
        : el('div', { class: 'empty-state', style: { padding: 'var(--space-8) var(--space-4)' } },
            el('div', { class: 'empty-state__title' }, 'No deals registered'),
            el('div', { class: 'empty-state__description' }, 'Click "New Opportunity" to add a deal for this partner.')
          )
    ),

    // Section 3: Contacts — extracted from this partner's description notes
    // and attachments, shown as a branded table matrix on click.
    buildPartnerContactsSection(partner, partnerContacts, contactPdfIndex),

    // Section 4: Call Transcripts
    el('div', { class: 'partner-detail-page__section' },
      buildTranscriptsPanel(partner, transcripts),
    ),

    // Section 5: Documents (file uploader + AI Analyze)
    documentsSection,
  );

  mount(container, content);

  // Phones: fold each section down to its header so the page opens as a short,
  // scannable index instead of a ~3,000px scroll. Keyed on the partner so one
  // partner's expanded sections don't carry over to the next. No-op on desktop.
  initMobileSections(content, { scope: partner.partner_id });

  // Load the partner's attached documents in the background so the page paints
  // immediately, then the list fills in — mirrors the opp/event modals, which
  // also fetch the document list via the Apps Script after the modal opens.
  docsHandle.refresh();
}

// ============================================
// Documents Panel (file uploader + AI Analyze)
// ============================================

/**
 * Build the partner Documents section: a drag-and-drop uploader backed by the
 * same Apps Script file API the Opportunities and Events views use. Files are
 * keyed on partner_id, whose `p_` prefix is distinct from opportunity (`opp_`)
 * and event (`evt_`) ids, so a partner's documents never cross-list with those
 * entities even though all three share one backing sheet.
 *
 * "Analyze" runs the same generic document extraction as Opportunities and
 * appends the formatted result as a new dated Description (a Transcripts row),
 * since the partner's "Descriptions" section is backed by that sheet.
 */
function buildPartnerDocumentsSection(partner) {
  const docsHandle = buildDocumentsPanel({
    // Type-qualified: partners and events share one untyped file-store
    // namespace, and legacy rows of both are numbered from 1 (see
    // js/utils/file-store-keys.js). A partner id the app generated is already
    // prefixed and keys exactly as before.
    entityId: fileStoreKey('partner', partner.partner_id),
    // Until the one-time Setup repair runs, this partner's existing files are
    // still under its bare id — matched by folder name so an event sharing
    // that id cannot leak in.
    legacy: {
      key: legacyFileStoreKey('partner', partner.partner_id),
      contextName: partner.display_name || '',
    },
    // Drive folder name for this partner's uploads (analogous to the customer
    // name for opportunities and the title for events).
    getContextName: () => partner.display_name || '',
    initialFiles: [],
    loading: true,
    onAnalyze: async (file) => {
      const data = await fileApiRequest({
        action: 'analyzeDocument',
        docId: file.doc_id,
        driveUrl: file.drive_url,
      });
      const fileName = data.fileName || file.file_name || 'Document';
      const dateISO = todayISO();
      const dateLabel = formatDate(dateISO);
      const descriptionHtml =
        `<h4>📄 ${escapeHtml(fileName)} — Analyzed ${escapeHtml(dateLabel)}</h4>` +
        ensureHtml(data.html || '');
      // A partner "description" is a Transcripts row:
      // [transcript_id, partner_id, partner_name, conversation_date, transcript_text, created_at]
      const values = [uuid('trn'), partner.partner_id, partner.display_name, dateISO, descriptionHtml, nowISO()];
      if (isConfigured()) {
        await appendRow(CONFIG.SHEET_TRANSCRIPTS, values);
      } else {
        addDemoRow(CONFIG.SHEET_TRANSCRIPTS, values);
      }
      file.analyzed = 'TRUE';
      showToast('Document analyzed and added to descriptions', 'success');
      // Reload so the new description appears (with a real row index) and the
      // document shows as analyzed — but only if the user is still on THIS
      // partner's page. The analysis is persisted regardless, and the floating
      // Randy pill reports completion if they have navigated away (guarding
      // this prevents a late re-render from clobbering another view).
      if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partner.partner_id) {
        reRender(partner.partner_id);
      }
    },
  });

  const section = el('div', { class: 'partner-detail-page__section' }, docsHandle.panel);
  return { section, docsHandle };
}

function buildPartnerStatCell(label, value) {
  return el('div', { class: 'partner-detail-page__stat-cell' },
    el('div', { class: 'partner-detail-page__stat-label' }, label),
    el('div', { class: 'partner-detail-page__stat-value' }, value),
  );
}

// ============================================
// Partner Bio — the researched company profile
// ============================================
// One AI research pass over the authoritative public sources (Crunchbase,
// LinkedIn, SEC EDGAR, Bloomberg, Hoovers, Glassdoor, CRN, Channel Futures,
// ISG, Google News — see js/utils/partner-bio-prompts.js) fills the profile
// matrix and the three value sections below.
//
// Nothing in this panel is CRM data. The partner's name is only the search
// seed; every field has to be confirmed against those sources or it shows as
// NA. That is why an NA here is a result, not a bug — it says the research
// could not verify the field to the required standard, which is more useful
// than a plausible guess.
//
// This is the complement to the Partner Analyzer: that scores OUR relationship
// from OUR notes, this describes THEIR company from the public record.

// Which partners' bio panels the user has expanded, surviving the full-page
// re-renders every mutation in this view performs. Absence means collapsed —
// the default for every partner, so the page opens on the relationship data
// and the bio is a click away.
const expandedBioSections = new Set();

// partner_id → the record produced in this session. Read ONLY as a fallback
// when the sheet has no row for the partner: in demo mode, or when the save
// failed after the research succeeded. Several minutes of research is too
// expensive to lose to a failed write, and the panel says so when that is why
// it is showing.
const partnerBioSessionCache = new Map();

// The partner_id whose research is running, or null. A partner id rather than
// a bare boolean so a re-rendered button shows the correct per-partner state.
let bioRunInFlight = null;

// The research legitimately runs for minutes across several rounds of
// searching, so the pill gets a budget that matches the work — on the default
// 4-minute timeout it would declare a healthy run failed while it was still
// going, and then give no success signal when it finished.
const BIO_PILL_TIMEOUT_MS = 20 * 60 * 1000;

function bioAnalyzeIconSvg() {
  return ICONS.sparkle;
}

/**
 * Paint the Analyze button's visual state. One function serves both the
 * build path and the async run's start/finally mutations, so the icon-only
 * and labeled variants can never drift apart — the old direct
 * `btn.textContent = …` writes would wipe the glyph out of an icon-only
 * button. Purely presentational: which state to show is decided exactly
 * where it was before.
 */
function paintBioAnalyzeButton(btn, { running, hasBio }) {
  const iconOnly = btn.dataset.variant === 'icon';
  const label = running ? 'Analyzing…' : (hasBio ? 'Re-analyze' : 'Analyze');
  btn.disabled = !!running;
  btn.classList.toggle('partner-bio__analyze--running', !!running);
  btn.title = running
    ? 'Analyzing… — the research is running'
    : (hasBio
        ? 'Research this company again and replace the saved bio'
        : 'Research this company on the authoritative sources and build its bio');
  btn.setAttribute('aria-label', label);
  if (iconOnly) btn.dataset.label = label;
  btn.innerHTML = '';
  btn.appendChild(el('span', {
    class: `partner-bio__analyze-icon${running ? ' icon-btn-spin' : ''}`,
    html: running ? ICONS.spinner : bioAnalyzeIconSvg(),
  }));
  if (!iconOnly) btn.appendChild(document.createTextNode(label));
}

/**
 * The Analyze button. The same control appears beside the partner's name and
 * in the Bio section header, so whichever one the user reaches for does the
 * same thing. It reads the in-flight state at build time, so a re-render
 * during a run rebuilds it as "Analyzing…" rather than looking idle.
 * `iconOnly` compresses it to a square glyph (tooltip + aria-label carry the
 * name) for the spots where a labeled pill would crowd its row.
 */
function buildBioAnalyzeButton(partner, bioRecord, { className = 'partner-bio__analyze', iconOnly = false } = {}) {
  const running = bioRunInFlight === partner.partner_id;
  const hasBio = !!(bioRecord && bioRecord.bio && !partnerBioIsEmpty(bioRecord.bio));
  const btn = el('button', {
    type: 'button',
    class: `${className}${iconOnly ? ` ${className}--icon` : ''}`,
    dataset: iconOnly ? { variant: 'icon' } : {},
    onClick: (e) => {
      e.stopPropagation();
      runPartnerBioAnalysis(partner, btn);
    },
  });
  paintBioAnalyzeButton(btn, { running, hasBio });
  return btn;
}

// A verified value, or the honest NA the research protocol requires.
function bioValueCell(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s === NA) {
    return el('span', {
      class: 'partner-bio__na',
      title: 'Not confirmed across the authoritative sources',
    }, NA);
  }
  return s;
}

// linkedin.com/company/acme rather than the full query-string-laden URL. The
// href keeps the exact URL the research verified; only the label is shortened.
function prettyUrlLabel(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./i, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return href;
  }
}

function bioLinkCell(href) {
  const s = String(href == null ? '' : href).trim();
  if (!s || s === NA) return bioValueCell(NA);
  return el('a', {
    class: 'partner-bio__link',
    href: s,
    target: '_blank',
    rel: 'noopener',
    title: s,
  }, prettyUrlLabel(s));
}

// Long enough that the two-line clamp in the profile grid could hide something.
// Anything past this carries the full text as its own tooltip.
const BIO_TOOLTIP_AT = 56;

/**
 * One fact in the profile grid: a micro label with its value underneath.
 * `variant` picks the overflow behaviour — plain text clamps to two lines,
 * a link truncates to one with an ellipsis, a badge is left alone.
 */
function bioFact(label, valueNode, { variant = '', title = '' } = {}) {
  return el('div', { class: 'partner-bio__fact' },
    el('dt', { class: 'partner-bio__fact-label' }, label),
    el('dd', {
      class: `partner-bio__fact-value${variant ? ` partner-bio__fact-value--${variant}` : ''}`,
      title: title || undefined,
    }, valueNode),
  );
}

function bioTextFact(label, value) {
  const s = String(value == null ? '' : value).trim();
  const long = s && s !== NA && s.length > BIO_TOOLTIP_AT;
  return bioFact(label, bioValueCell(value), { variant: 'text', title: long ? s : '' });
}

/**
 * The profile grid — the researched facts as label-above-value cells, three to
 * a row on desktop, with the website and LinkedIn page as live links. This was
 * a full-width Field/Detail table; nine one-line facts spent nine tall rows and
 * half the page width on an empty label column, which is what made a finished
 * bio read as messy. Same nine facts, a third of the height, nothing dropped.
 */
function buildPartnerBioFacts(bio) {
  const rating = bio.research_competency_rating == null ? NA : `${bio.research_competency_rating}/10`;
  const sources = bio.verification_level == null
    ? NA
    : `${bio.verification_level} per data point`;

  return el('dl', { class: 'partner-bio__facts' },
    bioTextFact('Company', bio.company_name),
    bioTextFact('Industry', bio.company_industry),
    bioTextFact('Headquarters', bio.headquarters),
    bioFact('Website', bioLinkCell(bio.company_website), { variant: 'link' }),
    bioFact('LinkedIn', bioLinkCell(bio.company_linkedin_url), { variant: 'link' }),
    bioTextFact('Employees', bio.number_of_employees),
    bioFact('Partner fit', bio.partner_fit_category && bio.partner_fit_category !== NA
      ? el('span', { class: 'partner-bio__fit' }, bio.partner_fit_category)
      : bioValueCell(NA)),
    bioFact('Research confidence', bioValueCell(rating), { variant: 'text' }),
    bioFact('Sources confirmed', bioValueCell(sources), { variant: 'text' }),
  );
}

function buildPartnerBioList(title, items) {
  const list = (items || []).filter(Boolean);
  return el('div', { class: 'partner-bio__block' },
    el('div', { class: 'partner-bio__block-title' }, title),
    list.length
      ? el('ul', { class: 'partner-bio__list' }, ...list.map(line => el('li', {}, line)))
      : el('div', { class: 'partner-bio__block-empty' },
          'Nothing the research could support from the authoritative sources.'),
  );
}

async function copyPartnerBio(bio) {
  const markdown = partnerBioToMarkdown(bio);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(markdown);
      showToast('Bio copied as markdown', 'success');
      return;
    }
    throw new Error('clipboard unavailable');
  } catch {
    // The async Clipboard API needs a secure context; the legacy path still
    // works over plain http and in older browsers.
    try {
      const ta = document.createElement('textarea');
      ta.value = markdown;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(ok ? 'Bio copied as markdown' : 'Could not copy the bio', ok ? 'success' : 'error');
    } catch {
      showToast('Could not copy the bio', 'error');
    }
  }
}

function buildPartnerBioContent(partner, bioRecord) {
  const bio = bioRecord.bio;
  const unsaved = !bioRecord._rowIndex && partnerBioSessionCache.has(partner.partner_id);

  return el('div', { class: 'partner-bio__content' },
    unsaved
      ? el('div', { class: 'partner-bio__banner' },
          'This bio has not been saved to the spreadsheet — it will be lost when you reload. '
          + 'Check the Setup page, then run Analyze again.')
      : null,
    buildPartnerBioFacts(bio),
    el('div', { class: 'partner-bio__blocks' },
      buildPartnerBioList('What they do', bio.what_they_do),
      buildPartnerBioList('How Recast brings value', bio.how_recast_brings_value),
      buildPartnerBioList('Why partner', bio.why_partner),
    ),
    el('div', { class: 'partner-bio__footnote' },
      'Researched only on Crunchbase, LinkedIn, SEC EDGAR, Bloomberg, Hoovers, Glassdoor, CRN, '
      + 'Channel Futures, ISG and Google News. "NA" means the field could not be confirmed across '
      + 'those sources.'),
  );
}

function buildPartnerBioSection(partner, bioRecord) {
  const bio = bioRecord && bioRecord.bio ? bioRecord.bio : null;
  const hasBio = !!(bio && !partnerBioIsEmpty(bio));
  const isOpen = expandedBioSections.has(partner.partner_id);

  const chevron = el('span', {
    class: `partner-bio__chevron${isOpen ? ' partner-bio__chevron--open' : ''}`,
    html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });

  const body = el('div', {
    class: `partner-bio__body${isOpen ? '' : ' partner-bio__body--collapsed'}`,
  },
    hasBio
      ? buildPartnerBioContent(partner, bioRecord)
      : el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-4)' } },
          el('div', { class: 'empty-state__title' }, 'No bio yet'),
          el('div', { class: 'empty-state__description' },
            'Click "Analyze" to research this company on Crunchbase, LinkedIn, SEC EDGAR, Bloomberg '
            + 'and the other authoritative sources, and build its profile.'),
        )
  );

  const researched = hasBio ? String(bioRecord.researched_at || '').slice(0, 10) : '';
  const subtitle = hasBio
    ? (researched ? `researched ${formatDate(researched) || researched}` : 'researched from public sources')
    : 'not researched yet';

  const header = el('div', {
    class: 'partner-detail-page__section-header partner-bio__header',
    onClick: () => {
      const nowOpen = body.classList.toggle('partner-bio__body--collapsed') === false;
      chevron.classList.toggle('partner-bio__chevron--open', nowOpen);
      if (nowOpen) expandedBioSections.add(partner.partner_id);
      else expandedBioSections.delete(partner.partner_id);
    },
  },
    el('div', { class: 'partner-detail-page__section-title' },
      sectionIcon('person', 'blue', { size: 'sm' }),
      'Partner Bio',
      el('span', { class: 'partner-detail-page__section-subtitle' }, subtitle),
      chevron,
    ),
    el('div', { class: 'partner-detail-page__section-actions' },
      hasBio
        ? el('button', {
            type: 'button',
            class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary partner-detail-page__section-cta--icon',
            title: 'Copy the bio as markdown',
            'aria-label': 'Copy bio',
            'data-label': 'Copy',
            onClick: (e) => { e.stopPropagation(); copyPartnerBio(bio); },
          }, el('span', { class: 'cta-glyph', html: ICONS.copy }))
        : null,
      // First run gets the labeled button ("Analyze" has to be discoverable);
      // once a bio exists the repeat action compresses to the sparkle glyph.
      buildBioAnalyzeButton(partner, bioRecord, {
        className: 'partner-detail-page__section-cta',
        iconOnly: hasBio,
      }),
    ),
  );

  return el('div', { class: 'partner-detail-page__section partner-bio' }, header, body);
}

/**
 * Persist one researched bio. There is exactly one row per partner: a
 * re-analysis replaces it, so the sheet always shows the current profile
 * rather than a pile of historical passes.
 */
async function savePartnerBio(record) {
  await ensureSheetWithHeaders(CONFIG.SHEET_PARTNER_BIOS, PARTNER_BIO_HEADERS);
  const values = partnerBioRowValues(record);
  const rows = await readSheetAsObjects(CONFIG.SHEET_PARTNER_BIOS, { forceRefresh: true }).catch(() => []);
  const exists = rows.some(r => String(r.partner_id || '').trim() === record.partner_id);
  if (exists) {
    await updateRowById(CONFIG.SHEET_PARTNER_BIOS, 'partner_id', record.partner_id, values);
  } else {
    await appendRow(CONFIG.SHEET_PARTNER_BIOS, values);
  }
}

async function runPartnerBioAnalysis(partner, btn) {
  const partnerId = String(partner.partner_id || '').trim();
  if (!partnerId) {
    showToast('This partner has no record id — reload the page and try again.', 'error');
    return;
  }
  if (bioRunInFlight) {
    showToast(bioRunInFlight === partnerId
      ? 'This partner is already being analyzed.'
      : 'Another partner analysis is still running.', 'info');
    return;
  }
  bioRunInFlight = partnerId;
  if (btn) paintBioAnalyzeButton(btn, { running: true, hasBio: false });

  // Progress rides the global Randy pill so it stays visible after the user
  // leaves this partner page — the research keeps running either way.
  const pill = createPill('Researching…', {
    label: partner.display_name || 'Partner',
    hardTimeoutMs: BIO_PILL_TIMEOUT_MS,
    progress: { steps: BIO_MAX_ROUNDS, stepMs: 60_000 },
  });
  let researched = false;

  try {
    const bio = await requestPartnerBio({
      partner,
      today: todayISO(),
      onProgress: (round) => {
        setPillProgress(pill, round - 1, BIO_MAX_ROUNDS);
        updatePillStage(pill, round <= 1 ? 'Researching…' : `Researching… (pass ${round})`);
      },
    });

    // An all-NA profile is a failed run, not a result worth storing over a
    // previous good one.
    if (partnerBioIsEmpty(bio)) {
      throw new Error('The authoritative sources returned nothing verifiable for this company.');
    }

    updatePillStage(pill, 'Saving…');
    const now = nowISO();
    const record = {
      partner_id: partnerId,
      partner_name: partner.display_name || '',
      researched_at: now,
      updated_at: now,
      bio,
    };
    partnerBioSessionCache.set(partnerId, record);
    researched = true;

    let saveError = '';
    try {
      await savePartnerBio(record);
      // The write landed, so the sheet is the source of truth again.
      partnerBioSessionCache.delete(partnerId);
    } catch (err) {
      saveError = err.message || 'the spreadsheet write failed';
      console.warn('[Partner Bio] not saved:', err);
    }

    // A freshly researched bio must be visible, so expand the panel for the
    // re-render below even though panels default to collapsed.
    expandedBioSections.add(partnerId);
    markPillSuccess(pill, saveError ? 'Researched (not saved)' : 'Bio ready');
    showToast(saveError ? `Bio ready, but not saved: ${saveError}` : 'Partner bio ready',
      saveError ? 'error' : 'success');

    // Only re-render if the user is still on THIS partner's page — the bio is
    // saved regardless, and the pill has already reported completion.
    if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partnerId) {
      reRender(partnerId);
    }
  } catch (err) {
    markPillFailure(pill, 'Analysis failed');
    showToast(err.message || 'Failed to analyze this partner', 'error');
  } finally {
    bioRunInFlight = null;
    // Usually moot — the re-render replaces this button — but a run that
    // failed, or finished after the user navigated back, must not leave a
    // button stuck on "Analyzing…".
    if (btn && btn.isConnected) {
      paintBioAnalyzeButton(btn, { running: false, hasBio: researched });
    }
  }
}

// ============================================
// Next Steps — the analysis log of mutual action plans
// ============================================
// The section between the Partner Bio and Upcoming Joint Events. "Analyze"
// asks the user to SELECT description notes (one or many), reasons over
// exactly those notes — extended thinking, no tools, no outside knowledge —
// and appends the verified plan to the section as a NEW LOG ENTRY: its own
// dropdown, headed by when it ran and which notes fed it, expanding to the
// plan table — one row per milestone, with a check-off box, the milestone
// (major gates bold), its owner (Recast / partner / both teams), its target
// (date, stated relative timing, or "To be scheduled") and a one-word
// status from the fixed MAP set — Complete green, In Progress / Next /
// Scheduled amber, Pending dark, never red. Rows sit in plan order.
// A re-analysis never erases or rewrites an earlier entry: every run is a
// snapshot, saved whole, and the log keeps them all — newest first, the
// latest expanded and older ones collapsed until clicked.
// Every saved analysis row passed the verbatim evidence gate in
// js/utils/partner-next-steps-schema.js: its supporting snippet is literally
// present in a selected note, its applicable date is a real calendar date
// the notes stated, and its provenance (which notes, analyzed when) is on
// the row — the "From" chips link straight to those notes and open them.
// Manual "Add Step" rows live in their own "Added by hand" entry, pinned
// above the runs, and the checkbox lets the user check any row off live in
// a working session without waiting for a re-analysis.

// Which partners' Next Steps panels the user has collapsed, surviving the
// full-page re-renders every mutation in this view performs. Absence means
// open — the default for every partner.
const collapsedNextStepsSections = new Set();

// Per-partner open/collapsed overrides for the log's entries, keyed by the
// entry key (a run's analyzed_at stamp, or MANUAL_STEPS_GROUP_KEY).
// Absence means the default: the newest run open, older runs collapsed,
// the hand-added entry open only while it is the only entry. In-memory
// only — like the section set above, it survives re-renders, not reloads.
const nextStepsEntryToggles = new Map();

function nextStepsEntryOverride(partnerId, entryKey) {
  const perPartner = nextStepsEntryToggles.get(partnerId);
  return perPartner && perPartner.has(entryKey) ? perPartner.get(entryKey) : undefined;
}

function setNextStepsEntryToggle(partnerId, entryKey, open) {
  let perPartner = nextStepsEntryToggles.get(partnerId);
  if (!perPartner) {
    perPartner = new Map();
    nextStepsEntryToggles.set(partnerId, perPartner);
  }
  perPartner.set(entryKey, open);
}

// The partner_id whose next-steps analysis is running, or null. A partner id
// rather than a bare boolean so a re-rendered button shows the correct
// per-partner state.
let nextStepsRunInFlight = null;

// The analysis reads at most this much of each selected note — the same
// per-item cap the contacts scan applies to description notes.
const NEXT_STEPS_CHARS_PER_NOTE = 6000;

// Reasoning over many notes takes a while; the pill budget matches the
// client's request timeout rather than the default 4 minutes.
const NEXT_STEPS_PILL_TIMEOUT_MS = 10 * 60 * 1000;

function nextStepsAnalyzeIconSvg() {
  return ICONS.sparkle;
}

/**
 * The section's Analyze button. Reads the in-flight state at build time so a
 * re-render during a run rebuilds it as "Analyzing…" rather than idle.
 * `hasAnalysis` flips the label to "Re-analyze" once an analysis has landed.
 * `iconOnly` compresses the repeat action to a square sparkle glyph —
 * tooltip + aria-label carry the name, and the running state swaps the
 * glyph for a spinner.
 */
function buildNextStepsAnalyzeButton(partner, transcripts, hasAnalysis, { iconOnly = false } = {}) {
  const running = nextStepsRunInFlight === partner.partner_id;
  const label = running ? 'Analyzing…' : (hasAnalysis ? 'Re-analyze' : 'Analyze');
  const btn = el('button', {
    type: 'button',
    class: `partner-detail-page__section-cta${iconOnly ? ' partner-detail-page__section-cta--icon' : ''}`,
    disabled: running || undefined,
    title: hasAnalysis
      ? 'Select description notes and run a new analysis — it joins the log as its own entry; earlier analyses are never erased'
      : 'Select description notes to analyze into a mutual action plan',
    'aria-label': label,
    'data-label': label,
    onClick: (e) => {
      e.stopPropagation();
      openNextStepsSourceModal(partner, transcripts);
    },
  },
    el('span', {
      class: `partner-next-steps__analyze-icon${running ? ' icon-btn-spin' : ''}`,
      html: running ? ICONS.spinner : nextStepsAnalyzeIconSvg(),
    }),
    iconOnly ? null : label,
  );
  return btn;
}

/** "Jun 12, 2026 · Jul 17, 2026" from the stored "2026-06-12; 2026-07-17". */
function nextStepSourceDatesLabel(step) {
  const dates = String(step.source_dates || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(d => formatDate(d))
    .filter(d => d && d !== '—');
  return dates.join(' · ');
}

/** A note's display date: its conversation date, else when it was added. */
function noteDateLabel(transcript) {
  const conv = formatDate(transcript.conversation_date);
  return conv !== '—' ? conv : formatDate(transcript.created_at);
}

/** A note's YYYY-MM-DD, derived exactly as the analysis run stores it. */
function noteDateISO(transcript) {
  return String(transcript.conversation_date || transcript.created_at || '').trim().slice(0, 10);
}

/** "2:14 PM" from an ISO datetime, in the viewer's timezone, or ''. */
function formatTimeOfDay(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!ms) return '';
  const d = new Date(ms);
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const half = d.getHours() >= 12 ? 'PM' : 'AM';
  return `${d.getHours() % 12 || 12}:${minutes} ${half}`;
}

// ── The "From" chips: provenance that opens the note ─────────────────
// One chip per source note. A chip whose note is on this page is a button
// that opens that very note (read-only) in a modal; a chip whose note can
// no longer be pinned down — deleted, or a pre-source_ids row whose stored
// date matches several notes — stays a plain label of the stored dates.

/** The read-only note viewer the provenance chips open. */
function openNextStepNoteModal(transcript) {
  openModal({
    title: `Description Note · ${noteDateLabel(transcript)}`,
    className: 'modal--wide',
    content: el('div', { class: 'partner-next-steps__note-view' },
      el('div', { class: 'transcript-card__text', html: ensureHtml(transcript.transcript_text || '') }),
    ),
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Close'),
    ],
  });
}

/**
 * Build the From-cell chips for one analysis row. Notes are resolved by
 * their stored transcript_id first — exact provenance, immune to date
 * edits. Rows saved before source_ids existed fall back to matching their
 * stored note dates against this partner's notes; a date carried by
 * exactly one note still links, an ambiguous or vanished one degrades to
 * the plain chip this cell has always shown.
 */
function buildNextStepNoteChips(step, transcripts, stamp) {
  const byId = new Map();
  for (const t of transcripts || []) {
    const id = String(t.transcript_id || '').trim();
    if (id && !byId.has(id)) byId.set(id, t);
  }

  const ids = Array.isArray(step.source_ids) ? step.source_ids : [];
  const resolved = ids.map(id => byId.get(id)).filter(Boolean);

  // Stored dates not accounted for by an id-resolved note: for legacy rows
  // that is every stored date; for new rows only the notes that vanished.
  const resolvedDates = new Set(resolved.map(noteDateISO));
  const leftoverDates = ids.length && resolved.length === ids.length
    ? []
    : String(step.source_dates || '')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .filter(d => !resolvedDates.has(d));

  const linkChip = (transcript) => el('button', {
    type: 'button',
    class: 'partner-next-steps__source-chip partner-next-steps__source-chip--link',
    title: [`Open the description note of ${noteDateLabel(transcript)}`, stamp].filter(Boolean).join(' · '),
    onClick: (e) => {
      e.stopPropagation();
      openNextStepNoteModal(transcript);
    },
  }, `Notes · ${noteDateLabel(transcript)}`);

  const plainChip = (label, title) => el('span', {
    class: 'partner-next-steps__source-chip',
    title: [title, stamp].filter(Boolean).join(' · '),
  }, label);

  const chips = resolved.map(linkChip);
  for (const date of leftoverDates) {
    const matches = (transcripts || []).filter(t => noteDateISO(t) === date && String(t.transcript_id || '').trim());
    const dateStr = formatDate(date);
    if (matches.length === 1 && !resolved.includes(matches[0])) {
      chips.push(linkChip(matches[0]));
    } else {
      chips.push(plainChip(
        dateStr !== '—' ? `Notes · ${dateStr}` : 'Notes',
        dateStr !== '—'
          ? `Analyzed from a description note of ${dateStr} — that exact note could not be pinned down to open (${matches.length > 1 ? 'several notes share this date' : 'it may have been edited or deleted'}); see the Descriptions section`
          : 'Analyzed from the selected description notes',
      ));
    }
  }
  if (!chips.length) {
    const noteDates = nextStepSourceDatesLabel(step);
    chips.push(plainChip(
      noteDates ? `Notes · ${noteDates}` : 'Notes',
      noteDates ? `Analyzed from the description note(s) of ${noteDates}` : 'Analyzed from the selected description notes',
    ));
  }
  return el('div', { class: 'partner-next-steps__from-chips' }, ...chips);
}

// The check-off glyphs — filled green square when complete, gray outline
// when open. Colors ride on `currentColor` so the CSS states own them.
const NEXT_STEP_CHECKED_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="14" height="14" fill="currentColor"/><path d="M4.5 8.2l2.4 2.4 4.6-5" stroke="#FFFFFF" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const NEXT_STEP_UNCHECKED_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" stroke="currentColor" stroke-width="1.6"/></svg>';

/** Status word → pill modifier. Complete green, the three active states
 *  amber, Pending dark — the MAP palette; there is deliberately no red. */
function nextStepStatusClass(status) {
  if (status === 'Complete') return 'partner-next-steps__status--complete';
  if (status === 'Pending') return 'partner-next-steps__status--pending';
  return 'partner-next-steps__status--active'; // In Progress / Next / Scheduled
}

function buildNextStepsTable(partner, steps, transcripts) {
  return el('div', { class: 'events-page__table-wrapper partner-next-steps__table-wrapper' },
    el('table', { class: 'events-page__table events-page__table--compact partner-next-steps__table' },
      el('thead', {},
        el('tr', {},
          el('th', { class: 'partner-next-steps__check-col', title: 'Check a step off as it completes' }, ''),
          el('th', {}, 'Milestone'),
          el('th', {}, 'Owner'),
          el('th', {}, 'Target'),
          el('th', {}, 'Status'),
          el('th', {}, 'From'),
          el('th', {}, 'Actions'),
        )
      ),
      el('tbody', {},
        ...steps.map(step => {
          const isAnalysis = step.source === 'analysis';
          const complete = step.status === 'Complete';
          const stampISO = isAnalysis ? step.analyzed_at : step.created_at;
          const stampDate = formatDate(String(stampISO || '').slice(0, 10));
          const stamp = stampDate && stampDate !== '—' ? `${isAnalysis ? 'Analyzed' : 'Added'} ${stampDate}` : '';
          return el('tr', { class: complete ? 'partner-next-steps__row--complete' : undefined },
            el('td', { class: 'partner-next-steps__check-cell' },
              el('button', {
                type: 'button',
                class: `partner-next-steps__check${complete ? ' partner-next-steps__check--done' : ''}`,
                title: complete ? 'Completed — click to reopen' : 'Mark this step complete',
                'aria-label': complete ? 'Reopen this step' : 'Mark this step complete',
                'aria-pressed': complete ? 'true' : 'false',
                html: complete ? NEXT_STEP_CHECKED_SVG : NEXT_STEP_UNCHECKED_SVG,
                onClick: () => handleToggleNextStepComplete(step, partner),
              }),
            ),
            el('td', { class: 'partner-next-steps__step-cell' },
              el('div', {
                class: `partner-next-steps__step-text${step.kind === 'gate' ? ' partner-next-steps__step-text--gate' : ''}`,
                // The verbatim note snippet this step was verified against.
                title: step.evidence ? `From the notes: “${step.evidence}”` : undefined,
              }, step.next_step),
            ),
            el('td', {},
              step.owner
                ? el('span', { class: 'partner-next-steps__owner' }, step.owner)
                : el('span', {
                    class: 'partner-contacts__muted',
                    title: 'The notes did not state who owns this step',
                  }, '—'),
            ),
            el('td', {},
              step.due_date
                ? el('span', {
                    class: 'partner-next-steps__due',
                    title: step.timing ? `Stated timing: ${step.timing}` : undefined,
                  }, formatDate(step.due_date))
                : (step.timing
                    ? el('span', {
                        class: 'partner-next-steps__timing',
                        title: 'Relative timing as the notes state it — no calendar date confirmed yet',
                      }, step.timing)
                    : el('span', {
                        class: 'partner-next-steps__tbs',
                        title: 'The notes give no date or timing for this step',
                      }, 'To be scheduled')),
            ),
            el('td', {},
              step.status
                ? el('span', { class: `partner-next-steps__status ${nextStepStatusClass(step.status)}` }, step.status)
                : el('span', { class: 'partner-contacts__muted' }, '—'),
            ),
            el('td', {},
              isAnalysis
                ? buildNextStepNoteChips(step, transcripts, stamp)
                : el('span', {
                    class: 'partner-next-steps__source-chip partner-next-steps__source-chip--manual',
                    title: stamp ? `Added by hand · ${stamp}` : 'Added by hand',
                  }, 'Manual'),
            ),
            el('td', { class: 'events-page__td--actions' },
              iconButton({
                icon: ICONS.trash,
                label: 'Delete',
                title: 'Remove this step from the plan',
                danger: true,
                onClick: () => handleDeleteNextStep(step, partner),
              }),
            ),
          );
        })
      )
    )
  );
}

// ── The log entries: one dropdown per analysis run ───────────────────

/** "Jun 12, 2026 · Jul 17, 2026" — every note date a run's steps cite. */
function runNoteDatesLabel(group) {
  const seen = new Set();
  const dates = [];
  for (const step of group.steps) {
    for (const raw of String(step.source_dates || '').split(';')) {
      const date = raw.trim();
      if (date && !seen.has(date)) {
        seen.add(date);
        dates.push(date);
      }
    }
  }
  return dates.map(d => formatDate(d)).filter(d => d && d !== '—').join(' · ');
}

/**
 * One entry of the analysis log: a collapsible header — when the run
 * happened (date and time, so two runs on one day stay tellable apart),
 * which notes fed it, how many steps and how many are complete — over the
 * run's own plan table, exactly as that run produced it. The hand-added
 * rows form the same shape of entry, labeled "Added by hand".
 */
function buildNextStepsRunEntry(partner, group, transcripts, defaultOpen) {
  const override = nextStepsEntryOverride(partner.partner_id, group.key);
  const isOpen = override === undefined ? defaultOpen : override;

  const chevron = el('span', {
    class: `partner-next-steps__chevron${isOpen ? ' partner-next-steps__chevron--open' : ''}`,
    html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });

  const body = el('div', {
    class: `partner-next-steps__entry-body${isOpen ? '' : ' partner-next-steps__entry-body--collapsed'}`,
  }, buildNextStepsTable(partner, group.steps, transcripts));

  const completeCount = group.steps.filter(s => s.status === 'Complete').length;
  const runDate = formatDate(String(group.analyzed_at || '').slice(0, 10));
  const runTime = formatTimeOfDay(group.analyzed_at);
  const title = group.manual
    ? 'Added by hand'
    : `Analyzed ${runDate !== '—' ? runDate : 'earlier'}${runTime ? ` · ${runTime}` : ''}`;
  const noteDates = group.manual ? '' : runNoteDatesLabel(group);

  const header = el('div', {
    class: 'partner-next-steps__entry-header',
    role: 'button',
    'aria-expanded': isOpen ? 'true' : 'false',
    title: group.manual
      ? 'Steps added by hand — click to expand or collapse'
      : 'One analysis run — click to expand or collapse its plan',
    onClick: () => {
      const nowOpen = body.classList.toggle('partner-next-steps__entry-body--collapsed') === false;
      chevron.classList.toggle('partner-next-steps__chevron--open', nowOpen);
      header.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      setNextStepsEntryToggle(partner.partner_id, group.key, nowOpen);
    },
  },
    chevron,
    el('span', { class: 'partner-next-steps__entry-title' }, title),
    noteDates
      ? el('span', {
          class: 'partner-next-steps__entry-meta',
          title: `Built from the description note${noteDates.includes('·') ? 's' : ''} of ${noteDates}`,
        }, `from notes of ${noteDates}`)
      : el('span', { class: 'partner-next-steps__entry-meta' }),
    el('span', { class: 'partner-next-steps__entry-count' },
      `${group.steps.length} step${group.steps.length === 1 ? '' : 's'}`),
    completeCount
      ? el('span', { class: 'partner-next-steps__entry-done' }, `${completeCount} complete`)
      : null,
  );

  return el('div', { class: 'partner-next-steps__entry' }, header, body);
}

// ── Copy for email ───────────────────────────────────────────────────
// The header's little copy button puts the plan as it currently stands —
// the hand-added steps plus the latest analysis run, in the order the
// section shows them — on the clipboard in BOTH flavors: an inline-styled
// HTML table that pastes nicely into Gmail/Outlook, and a tab-separated
// plain-text fallback for plain-text composers (and spreadsheets). The
// email table carries only the client-safe plan columns — Milestone,
// Owner, Target, Status; the check-off box, provenance chips and row
// actions are internal UI and deliberately stay out of it.

/** The steps the copy button copies: hand-added first (as pinned in the
 *  section), then the newest analysis run — the current plan. Older runs
 *  are historical snapshots and stay out of the email. */
function nextStepsEmailSteps(groups) {
  const manual = groups.find(g => g.manual);
  const newestRun = groups.find(g => !g.manual);
  return [...(manual ? manual.steps : []), ...(newestRun ? newestRun.steps : [])];
}

/** The Target column's text, exactly as the on-screen table words it. */
function nextStepEmailTargetLabel(step) {
  if (step.due_date) return formatDate(step.due_date);
  if (step.timing) return step.timing;
  return 'To be scheduled';
}

/**
 * The HTML clipboard flavor: a title line and a bordered table. Every
 * style is inline (email clients strip classes and stylesheets on paste)
 * and the palette mirrors the section's MAP colors — complete green,
 * active amber, pending dark, no red anywhere.
 */
function buildNextStepsEmailHtml(partner, steps) {
  const cell = 'border:1px solid #DDDDEE;padding:6px 10px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#1A1A2E;vertical-align:top;text-align:left;';
  const head = `${cell}background-color:#F6F8FF;font-weight:700;font-size:12px;`;
  const muted = '<span style="color:#67677A;">&mdash;</span>';
  const statusColor = (status) => {
    if (status === 'Complete') return '#0F7A3F';
    if (status === 'Pending') return '#1A1A2E';
    return '#CC8800'; // In Progress / Next / Scheduled
  };

  const rows = steps.map(step => {
    const rowCell = step.status === 'Complete' ? `${cell}background-color:#E7F2EC;` : cell;
    const milestone = step.kind === 'gate'
      ? `<strong>${escapeHtml(step.next_step)}</strong>`
      : escapeHtml(step.next_step);
    const target = step.due_date
      ? `<span style="font-weight:600;">${escapeHtml(formatDate(step.due_date))}</span>`
      : (step.timing
          ? escapeHtml(step.timing)
          : '<span style="color:#67677A;font-style:italic;">To be scheduled</span>');
    const status = step.status
      ? `<strong style="color:${statusColor(step.status)};">${escapeHtml(step.status)}</strong>`
      : muted;
    return '<tr>'
      + `<td style="${rowCell}">${milestone}</td>`
      + `<td style="${rowCell}">${step.owner ? escapeHtml(step.owner) : muted}</td>`
      + `<td style="${rowCell}">${target}</td>`
      + `<td style="${rowCell}">${status}</td>`
      + '</tr>';
  }).join('');

  return `<p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1A1A2E;"><strong>Next Steps &mdash; ${escapeHtml(partner.display_name || 'Partner')}</strong></p>`
    + '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">'
    + '<thead><tr>'
    + `<th style="${head}">Milestone</th>`
    + `<th style="${head}">Owner</th>`
    + `<th style="${head}">Target</th>`
    + `<th style="${head}">Status</th>`
    + '</tr></thead>'
    + `<tbody>${rows}</tbody>`
    + '</table>';
}

/** The plain-text clipboard flavor: the title, then a tab-separated table
 *  (which plain-text composers keep readable and spreadsheets split into
 *  columns). Fields are flattened to single lines so a wrapped milestone
 *  cannot break a row. */
function buildNextStepsEmailText(partner, steps) {
  const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
  return [
    `Next Steps — ${clean(partner.display_name) || 'Partner'}`,
    '',
    ['Milestone', 'Owner', 'Target', 'Status'].join('\t'),
    ...steps.map(step => [
      clean(step.next_step),
      clean(step.owner) || '—',
      clean(nextStepEmailTargetLabel(step)),
      clean(step.status) || '—',
    ].join('\t')),
  ].join('\n');
}

async function copyNextStepsForEmail(partner, groups) {
  const steps = nextStepsEmailSteps(groups);
  if (!steps.length) {
    showToast('No next steps to copy yet', 'info');
    return;
  }
  const html = buildNextStepsEmailHtml(partner, steps);
  const text = buildNextStepsEmailText(partner, steps);
  const copied = () => showToast('Next steps copied — paste the table into your email', 'success');

  try {
    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      copied();
      return;
    }
    throw new Error('rich clipboard unavailable');
  } catch {
    // The async Clipboard API needs a secure context; selecting a hidden
    // node that holds the same table lets execCommand('copy') capture the
    // HTML flavor over plain http and in older browsers.
    try {
      const host = document.createElement('div');
      host.setAttribute('contenteditable', 'true');
      host.style.position = 'fixed';
      host.style.top = '0';
      host.style.left = '-9999px';
      host.style.opacity = '0';
      host.innerHTML = html;
      document.body.appendChild(host);
      const range = document.createRange();
      range.selectNodeContents(host);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const ok = document.execCommand('copy');
      selection.removeAllRanges();
      document.body.removeChild(host);
      if (!ok) throw new Error('copy command refused');
      copied();
    } catch {
      // Last resort: at least the plain-text table.
      try {
        await navigator.clipboard.writeText(text);
        copied();
      } catch {
        showToast('Could not copy the next steps', 'error');
      }
    }
  }
}

function buildNextStepsSection(partner, steps, transcripts) {
  const isOpen = !collapsedNextStepsSections.has(partner.partner_id);
  const groups = groupNextStepsIntoRuns(steps);
  const runs = groups.filter(g => !g.manual);
  const hasAnalysis = runs.length > 0;
  const analyzed = lastAnalyzedAt(steps);
  const newestRunKey = hasAnalysis ? runs[0].key : '';

  const chevron = el('span', {
    class: `partner-next-steps__chevron${isOpen ? ' partner-next-steps__chevron--open' : ''}`,
    html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });

  const body = el('div', {
    class: `partner-next-steps__body${isOpen ? '' : ' partner-next-steps__body--collapsed'}`,
  },
    groups.length > 0
      ? el('div', { class: 'partner-next-steps__log' },
          // The hand-added entry is pinned first, open only while it is the
          // only entry; the newest run opens by default, older runs wait
          // collapsed. A user toggle (nextStepsEntryToggles) always wins.
          ...groups.map(group => buildNextStepsRunEntry(partner, group, transcripts,
            group.manual ? !hasAnalysis : group.key === newestRunKey)))
      // The empty state stays deliberately quiet — the header's own Analyze
      // and Add Step buttons are the calls to action.
      : el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-4)' } },
          el('div', { class: 'empty-state__title' }, 'No next steps yet'),
        )
  );

  const subtitle = hasAnalysis
    ? `${runs.length} ${runs.length === 1 ? 'analysis' : 'analyses'} · latest ${formatDate(String(analyzed).slice(0, 10)) || String(analyzed).slice(0, 10)}`
    : (steps.length ? 'added by hand' : 'from your description notes');

  const header = el('div', {
    class: 'partner-detail-page__section-header partner-next-steps__header',
    onClick: () => {
      const nowOpen = body.classList.toggle('partner-next-steps__body--collapsed') === false;
      chevron.classList.toggle('partner-next-steps__chevron--open', nowOpen);
      if (nowOpen) collapsedNextStepsSections.delete(partner.partner_id);
      else collapsedNextStepsSections.add(partner.partner_id);
    },
  },
    el('div', { class: 'partner-detail-page__section-title' },
      sectionIcon('checklist', 'green', { size: 'sm' }),
      'Next Steps',
      steps.length ? el('span', { class: 'partner-detail-page__section-count' }, String(steps.length)) : null,
      el('span', { class: 'partner-detail-page__section-subtitle' }, subtitle),
      chevron,
    ),
    el('div', { class: 'partner-detail-page__section-actions' },
      // The little copy button: the current plan (hand-added steps plus the
      // latest analysis) as a table that pastes nicely into an email.
      groups.length > 0
        ? el('button', {
            type: 'button',
            class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary partner-detail-page__section-cta--icon',
            title: 'Copy all next steps as a table that pastes nicely into an email',
            'aria-label': 'Copy next steps for email',
            'data-label': 'Copy',
            onClick: (e) => {
              e.stopPropagation();
              copyNextStepsForEmail(partner, groups);
            },
          }, el('span', { class: 'cta-glyph', html: ICONS.copy }))
        : null,
      el('button', {
        class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary',
        onClick: (e) => {
          e.stopPropagation();
          openAddNextStepModal(partner);
        },
      },
        el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
        'Add Step',
      ),
      // First run keeps the label; once an analysis is on the agenda the
      // repeat action compresses to the sparkle glyph.
      buildNextStepsAnalyzeButton(partner, transcripts, hasAnalysis, { iconOnly: hasAnalysis }),
    ),
  );

  return el('div', { class: 'partner-detail-page__section partner-next-steps' }, header, body);
}

// ── Note-selection modal ─────────────────────────────────────────────
// The user picks WHICH description notes feed the analysis — one or many.
// Notes are the partner's Transcripts rows, listed newest first exactly as
// the Descriptions section shows them.
function openNextStepsSourceModal(partner, transcripts) {
  if (nextStepsRunInFlight) {
    showToast(nextStepsRunInFlight === partner.partner_id
      ? 'This partner\'s next steps are already being analyzed.'
      : 'Another next-steps analysis is still running.', 'info');
    return;
  }

  // A note needs its transcript_id to be citable as a step's source, so
  // hand-entered sheet rows missing one are excluded — and SAID to be, not
  // silently hidden while the Descriptions section shows them.
  const withText = (transcripts || []).filter(t => stripHtml(t.transcript_text || '').trim());
  const notes = withText.filter(t => String(t.transcript_id || '').trim());
  const missingId = withText.length - notes.length;
  if (!notes.length) {
    showToast(missingId
      ? `${missingId} description note${missingId === 1 ? ' is' : 's are'} missing a transcript_id in the Transcripts sheet and can't be analyzed — re-add ${missingId === 1 ? 'it' : 'them'} via "Add Description".`
      : 'This partner has no description notes to analyze yet — add one under Descriptions first.', 'info');
    return;
  }
  if (missingId) {
    showToast(`${missingId} note${missingId === 1 ? '' : 's'} without a transcript_id ${missingId === 1 ? 'is' : 'are'} not listed — re-add ${missingId === 1 ? 'it' : 'them'} via "Add Description" to make ${missingId === 1 ? 'it' : 'them'} analyzable.`, 'info');
  }

  const selected = new Set();
  const rowInputs = new Map();

  const analyzeBtn = el('button', {
    class: 'btn btn--primary',
    disabled: true,
    onClick: () => {
      const chosen = notes.filter(t => selected.has(t.transcript_id));
      if (!chosen.length) return;
      closeModal();
      runNextStepsAnalysis(partner, chosen);
    },
  }, 'Analyze');

  const selectAllInput = el('input', { type: 'checkbox', class: 'partner-next-steps-select__checkbox' });

  const syncControls = () => {
    analyzeBtn.disabled = selected.size === 0;
    analyzeBtn.textContent = selected.size
      ? `Analyze ${selected.size} note${selected.size === 1 ? '' : 's'}`
      : 'Analyze';
    selectAllInput.checked = selected.size === notes.length;
    selectAllInput.indeterminate = selected.size > 0 && selected.size < notes.length;
  };

  selectAllInput.addEventListener('change', () => {
    if (selectAllInput.checked) notes.forEach(t => selected.add(t.transcript_id));
    else selected.clear();
    rowInputs.forEach((input, id) => { input.checked = selected.has(id); });
    syncControls();
  });

  const rows = notes.map(t => {
    const input = el('input', {
      type: 'checkbox',
      class: 'partner-next-steps-select__checkbox',
      onChange: () => {
        if (input.checked) selected.add(t.transcript_id);
        else selected.delete(t.transcript_id);
        syncControls();
      },
    });
    rowInputs.set(t.transcript_id, input);
    const dateStr = formatDate(t.conversation_date) !== '—'
      ? formatDate(t.conversation_date)
      : formatDate(t.created_at);
    const plain = stripHtml(t.transcript_text || '');
    const preview = plain.slice(0, 140) + (plain.length > 140 ? '…' : '');
    return el('label', { class: 'partner-next-steps-select__row' },
      input,
      el('span', { class: 'partner-next-steps-select__date' }, dateStr),
      el('span', { class: 'partner-next-steps-select__preview' }, preview),
    );
  });

  openModal({
    title: 'Analyze Description Notes',
    className: 'modal--wide',
    content: el('div', { class: 'partner-next-steps-select' },
      el('p', { class: 'partner-next-steps-select__intro' },
        'Select the description notes to analyze. The AI reads ONLY the notes you select, works out '
        + 'what has completed, what is in motion and what gate comes next, and saves the plan as a '
        + 'new entry in the Next Steps log — earlier analyses stay exactly as they were, and every '
        + 'step is checked word-for-word against the notes before it is saved.'),
      el('label', { class: 'partner-next-steps-select__row partner-next-steps-select__row--all' },
        selectAllInput,
        el('span', { class: 'partner-next-steps-select__date' }, 'Select all'),
        el('span', { class: 'partner-next-steps-select__preview' },
          `${notes.length} description note${notes.length === 1 ? '' : 's'}`),
      ),
      el('div', { class: 'partner-next-steps-select__list' }, ...rows),
    ),
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      analyzeBtn,
    ],
  });
}

// ── Analysis run ─────────────────────────────────────────────────────
async function runNextStepsAnalysis(partner, chosenTranscripts) {
  const partnerId = String(partner.partner_id || '').trim();
  if (!partnerId) {
    showToast('This partner has no record id — reload the page and try again.', 'error');
    return;
  }
  if (nextStepsRunInFlight) {
    showToast('A next-steps analysis is already running.', 'info');
    return;
  }
  nextStepsRunInFlight = partnerId;
  // Rebuild the section so its Analyze buttons show the running state — the
  // click came from the (now closed) selection modal, so unlike the bio flow
  // there is no on-screen button to flip in place. Same page guard as the
  // finally-block re-render, which restores the idle state when the run ends.
  if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partnerId) {
    reRender(partnerId);
  }

  // Progress rides the global Randy pill so it stays visible after the user
  // leaves this partner page — the analysis keeps running either way.
  // One opaque model call — there are no checkpoints inside it to measure, so
  // the bar sweeps rather than pretending to a percentage it cannot know. It
  // turns determinate at 'Saving…', the one real checkpoint this flow has.
  const pill = createPill('Analyzing notes…', {
    label: partner.display_name || 'Partner',
    hardTimeoutMs: NEXT_STEPS_PILL_TIMEOUT_MS,
    progress: true,
  });

  try {
    // The sources exactly as the parser will verify against them: HTML
    // stripped, prompt-structure markers neutralized, bounded per note. The
    // model and the evidence gate must see the SAME text or verbatim
    // verification would be meaningless.
    const sources = chosenTranscripts.map(t => ({
      source_id: String(t.transcript_id || '').trim(),
      label: 'Description',
      date: String(t.conversation_date || t.created_at || '').trim().slice(0, 10),
      text: sanitizeNoteTextForAnalysis(stripHtml(t.transcript_text || '')).slice(0, NEXT_STEPS_CHARS_PER_NOTE),
    })).filter(s => s.source_id && s.text.trim());
    if (!sources.length) throw new Error('The selected notes have no readable text.');

    const result = await requestPartnerNextSteps({
      partnerName: partner.display_name || '',
      sources,
      today: todayISO(),
    });

    if (result.dropped.length) {
      console.info('[Partner Next Steps] proposals rejected by the verbatim evidence check:', result.dropped);
    }

    setPillProgress(pill, 0.85);
    updatePillStage(pill, 'Saving…');

    let records = [];
    if (result.steps.length) {
      // ensureSheetWithHeaders creates the tab on first use and extends an
      // older tab's header row in place when appended columns (the plan
      // columns, source_ids) are missing.
      await ensureSheetWithHeaders(CONFIG.SHEET_PARTNER_NEXT_STEPS, PARTNER_NEXT_STEP_HEADERS);

      const dateById = new Map(sources.map(s => [s.source_id, s.date]));
      const sourceDatesFor = (step) =>
        [...new Set((step.source_ids || []).map(id => dateById.get(id)).filter(Boolean))].join('; ');
      // ONE stamp for every row of the run — it is the log entry's identity
      // (groupNextStepsIntoRuns groups the section's dropdowns by it).
      const now = nowISO();

      // The analysis-log save: this run is appended WHOLE, as its own
      // snapshot entry — rows saved by earlier runs are never touched, so
      // re-analyzing can never erase or rewrite what a previous run found.
      records = result.steps.map(step => ({
        step_id: uuid('pns'),
        partner_id: partnerId,
        partner_name: partner.display_name || '',
        next_step: step.next_step,
        due_date: step.due_date,
        source: 'analysis',
        source_dates: sourceDatesFor(step),
        evidence: step.evidence,
        analyzed_at: now,
        created_at: now,
        updated_at: now,
        owner: step.owner,
        status: step.status,
        timing: step.timing,
        kind: step.kind,
        source_ids: step.source_ids,
      }));

      await appendRows(CONFIG.SHEET_PARTNER_NEXT_STEPS, records.map(nextStepRowValues));
    }

    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (records.length) {
      const completeCount = records.filter(r => r.status === 'Complete').length;
      const bits = [plural(records.length, 'step')];
      if (completeCount) bits.push(`${completeCount} complete`);
      if (result.dropped.length) bits.push(`${plural(result.dropped.length, 'unverified proposal')} discarded`);
      showToast(`New analysis added to the log: ${bits.join(', ')} — earlier entries are untouched.`, 'success');
      markPillSuccess(pill, `${plural(records.length, 'step')} logged`);
    } else if (result.dropped.length) {
      showToast('Analysis found no verifiable next steps in the selected notes — nothing was saved. See the console for what was rejected.', 'info');
      markPillSuccess(pill, 'Nothing verifiable found');
    } else {
      showToast('Analysis found no plan content in the selected notes.', 'info');
      markPillSuccess(pill, 'No next steps found');
    }
    // The internal handoff line — anything the client-safe rules filtered
    // out of the plan (so it can be tracked elsewhere) and any name/owner/
    // date the model flagged as ambiguous. Internal only: it is surfaced
    // here to the account owner, never stored on the plan itself.
    if (result.note) {
      showToast(`Analysis note (internal): ${result.note}`, 'info');
    }
    if (result.partial) {
      showToast('The analysis reply was cut off — the plan may be incomplete. Re-analyze with fewer notes selected.', 'error');
    }

    collapsedNextStepsSections.delete(partnerId);
  } catch (err) {
    console.error('[Partner Next Steps]', err);
    showToast(err.message || 'Next steps analysis failed', 'error');
    markPillFailure(pill, 'Analysis failed');
  } finally {
    nextStepsRunInFlight = null;
    // Re-render after the in-flight flag clears so the rebuilt button shows
    // its idle state — but only if the user is still on THIS partner's page.
    // The results are persisted regardless.
    if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partnerId) {
      reRender(partnerId);
    }
  }
}

// ── Manual add ───────────────────────────────────────────────────────
function openAddNextStepModal(partner) {
  const stepInput = el('textarea', {
    class: 'form-input partner-next-steps__textarea',
    id: 'next-step-text',
    rows: '3',
    placeholder: 'e.g. Send the business justification deck to the services team',
  });
  const ownerInput = el('input', {
    class: 'form-input', type: 'text', id: 'next-step-owner',
    placeholder: `e.g. Recast, ${partner.display_name || 'Partner'} (Name), Both teams`,
  });
  // Manual rows speak the same fixed status vocabulary as analysis rows —
  // an empty choice is allowed and renders as an open row with no status.
  const statusSelect = el('select', { class: 'form-input', id: 'next-step-status' },
    el('option', { value: '' }, '— no status —'),
    ...NEXT_STEP_STATUSES.map(s => el('option', { value: s }, s)),
  );
  const dateInput = el('input', { class: 'form-input', type: 'date', id: 'next-step-date' });

  const saveBtn = el('button', {
    class: 'btn btn--primary',
    onClick: async () => {
      const text = stepInput.value.replace(/\s+/g, ' ').trim();
      if (!text) { showToast('Please enter the next step', 'error'); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        await ensureSheetWithHeaders(CONFIG.SHEET_PARTNER_NEXT_STEPS, PARTNER_NEXT_STEP_HEADERS);
        const now = nowISO();
        await appendRow(CONFIG.SHEET_PARTNER_NEXT_STEPS, nextStepRowValues({
          step_id: uuid('pns'),
          partner_id: partner.partner_id,
          partner_name: partner.display_name || '',
          next_step: text,
          due_date: dateInput.value || '',
          source: 'manual',
          source_dates: '',
          evidence: '',
          analyzed_at: '',
          created_at: now,
          updated_at: now,
          owner: ownerInput.value.replace(/\s+/g, ' ').trim(),
          status: statusSelect.value,
          timing: '',
          kind: 'step',
          source_ids: [],
        }));
        showToast('Next step added', 'success');
        closeModal();
        collapsedNextStepsSections.delete(partner.partner_id);
        // Surface the row: the "Added by hand" log entry expands so the new
        // step is visible the moment the section repaints.
        setNextStepsEntryToggle(partner.partner_id, MANUAL_STEPS_GROUP_KEY, true);
        // The modal survives a hash navigation, so only repaint if the user
        // is still on THIS partner's page — the row is saved regardless.
        if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partner.partner_id) {
          reRender(partner.partner_id);
        }
      } catch (err) {
        showToast(err.message || 'Failed to save the next step', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Add Step';
      }
    },
  }, 'Add Step');

  openModal({
    title: 'Add Next Step',
    content: el('div', {},
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label' }, 'Partner'),
        el('input', {
          class: 'form-input', type: 'text', value: partner.display_name, readOnly: true,
          style: { background: 'var(--color-bg)', cursor: 'default' },
        })
      ),
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label', for: 'next-step-text' }, 'Next Step *'),
        stepInput,
      ),
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label', for: 'next-step-owner' }, 'Owner (optional)'),
        ownerInput,
      ),
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label', for: 'next-step-status' }, sectionIcon('flag', 'indigo', { size: 'sm' }), 'Status (optional)'),
        statusSelect,
      ),
      el('div', { class: 'form-group' },
        el('label', { class: 'form-label', for: 'next-step-date' }, 'Target Date (optional)'),
        dateInput,
      ),
    ),
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      saveBtn,
    ],
  });
}

// ── Live check-off ───────────────────────────────────────────────────
// The plan is a living checklist: in a working session the user checks a
// row off the moment it completes — no re-analysis needed. The write merges
// into the FRESH stored row (status + updated_at only), so a concurrent
// analysis update is never clobbered by a stale snapshot. Reopening clears
// the status rather than guessing a new one.
async function handleToggleNextStepComplete(step, partner) {
  if (!step.step_id) {
    showToast('This row has no record id — update it in the spreadsheet instead.', 'error');
    return;
  }
  const makeComplete = step.status !== 'Complete';
  try {
    await updateRowById(
      CONFIG.SHEET_PARTNER_NEXT_STEPS,
      'step_id',
      step.step_id,
      (freshRow) => nextStepRowValues({
        ...nextStepFromRow(freshRow),
        status: makeComplete ? 'Complete' : '',
        updated_at: nowISO(),
      }),
      { expect: { partner_id: partner.partner_id } },
    );
    showToast(makeComplete ? 'Step checked off — it stays on the plan as the record of momentum.' : 'Step reopened', 'success');
    if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partner.partner_id) {
      reRender(partner.partner_id);
    }
  } catch (err) {
    console.error('[Partner Next Steps] toggle failed', err);
    showToast(err.message || 'Could not update the step', 'error');
  }
}

// ── Delete ───────────────────────────────────────────────────────────
async function handleDeleteNextStep(step, partner) {
  if (!step.step_id) {
    showToast('This row has no record id — it can only be removed in the spreadsheet.', 'error');
    return;
  }
  const label = step.next_step.length > 80 ? `${step.next_step.slice(0, 80)}…` : step.next_step;
  const confirmed = await confirmDialog(
    'Delete Next Step',
    `Remove "${label}" from ${partner.display_name}'s action plan? This cannot be undone.`
  );
  if (!confirmed) return;

  try {
    await deleteRowById(CONFIG.SHEET_PARTNER_NEXT_STEPS, 'step_id', step.step_id);
    showToast('Next step removed', 'success');
    // The confirm dialog survives a hash navigation, so only repaint if the
    // user is still on THIS partner's page — the row is gone regardless.
    if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partner.partner_id) {
      reRender(partner.partner_id);
    }
  } catch (err) {
    showToast(err.message || 'Failed to delete', 'error');
  }
}

// ============================================
// Contacts Section — extracted from descriptions & attachments
// ============================================
// Every contact shown here was either verified verbatim against this
// partner's own sources (see js/utils/partner-contacts.js for the accuracy
// contract) or entered manually. The section is expanded by default on
// every partner page — the roster is the point of visiting — and clicking
// the header collapses it.

// Which partners' contact tables the user has collapsed, surviving the
// full-page re-renders every mutation in this view performs. Absence means
// open — the default for every partner.
const collapsedContactSections = new Set();

// The in-flight load-time backfill (company defaults + analysis-verified
// roles), if any. Deleting a contact awaits it first: a delete shifts the
// row indexes beneath it, and a pending in-place update aimed at a
// pre-delete index would land on the wrong row. Also stops overlapping
// re-renders from starting a second, identical backfill pass.
let contactBackfillPromise = null;

// Persist the load-time backfills (blank company → partner name, blank
// role → analysis-verified title) without blocking the page paint — the
// filled values are already on screen. A failure only logs: the next page
// open retries, and nothing else depends on it.
async function persistContactBackfill(contacts) {
  const entries = contacts
    .filter(c => c.contact_id)
    .map(c => ({
      id: c.contact_id,
      values: (fresh) => partnerContactRowValues({ ...partnerContactFromRow(fresh), ...c }),
    }));
  if (!entries.length) return;
  try {
    // One read and one write. This used to resolve each contact separately,
    // which meant a full read of the tab per contact on every page open.
    await updateRowsById(CONFIG.SHEET_PARTNER_CONTACTS, 'contact_id', entries);
  } catch (err) {
    console.warn('[Partner Contacts] contact backfill not saved:', err.message);
  }
}

const CONTACT_SOURCE_TYPE_LABELS = {
  description: 'Description',
  meeting: 'Meeting',
  partner_document: 'Document',
  attachment: 'Attachment',
  manual: 'Manual',
};

function contactSourceChips(contact) {
  const sources = contact.sources || [];
  if (sources.length === 0) {
    return el('span', { class: 'partner-contacts__muted' }, '—');
  }
  return el('div', { class: 'partner-contacts__sources' },
    ...sources.map(s => {
      const typeLabel = CONTACT_SOURCE_TYPE_LABELS[s.type] || 'Source';
      // Attachments and documents are identified by file/doc title; the
      // dated note types read better as "Description · Jun 10".
      const text = (s.type === 'attachment' || s.type === 'partner_document')
        ? (s.label || typeLabel)
        : (s.date ? `${typeLabel} · ${formatDate(s.date)}` : typeLabel);
      const tooltip = [typeLabel, s.label && s.label !== typeLabel ? s.label : '', s.date ? formatDate(s.date) : '']
        .filter(Boolean).join(' · ');
      return el('span', { class: 'partner-contacts__source-chip', title: tooltip }, text);
    })
  );
}

function contactCell(value, { muted = 'partner-contacts__muted' } = {}) {
  const v = String(value || '').trim();
  return v ? v : el('span', { class: muted }, '—');
}

function pdfLinkIconSvg() {
  return '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<path d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14V1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
    + '<path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
    + '</svg>';
}

/**
 * The Analyzer PDF cell: a link to this contact's Account Intelligence Brief
 * when the Analyzer has produced one, and an honest dash when it hasn't.
 *
 * The brief is found by contact_id, the same key the Analyzer files it under
 * and the same key the contact's Documents panel lists it by — so what shows
 * here is exactly what is attached to the record, never an inference from a
 * name. A brief whose Drive link never resolved is shown as present but
 * unlinked rather than silently hidden: the file exists, and saying "—" would
 * be a lie the user could disprove by opening the contact.
 */
function contactAnalyzerPdfCell(contact, contactPdfIndex) {
  const pdf = findContactAnalyzerPdf(contactPdfIndex, contact && contact.contact_id);
  if (!pdf) return el('span', { class: 'partner-contacts__muted' }, '—');

  const dated = pdf.brief_date ? (formatDate(pdf.brief_date) || pdf.brief_date) : '';
  const label = dated ? `Brief · ${dated}` : 'Brief';

  if (!pdf.drive_url) {
    return el('span', {
      class: 'partner-contacts__muted',
      title: `${pdf.file_name} is attached to this contact, but its Drive link did not resolve. Open the contact to reach it.`,
    }, `${label} (no link)`);
  }

  return el('a', {
    class: 'partner-contacts__pdf-link',
    href: pdf.drive_url,
    target: '_blank',
    rel: 'noopener',
    title: pdf.file_name,
  },
    el('span', { class: 'partner-contacts__pdf-icon', html: pdfLinkIconSvg() }),
    label,
  );
}

function buildContactsTable(partner, contacts, contactPdfIndex) {
  return el('div', { class: 'events-page__table-wrapper partner-contacts__table-wrapper' },
    el('table', { class: 'events-page__table events-page__table--compact partner-contacts__table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Name'),
          el('th', {}, 'Role'),
          el('th', {}, 'Company'),
          el('th', {}, 'Email'),
          // Replaces the Phone column: a phone number is one more thing to
          // read past on a roster, while "has this person been analyzed, and
          // where is that brief?" is the question this table gets opened for.
          // Phone is still captured, stored and edited on the contact itself —
          // it just no longer costs a column here.
          el('th', {}, 'Analyzer PDF'),
          el('th', {}, 'Sources'),
          el('th', {}, 'Actions'),
        )
      ),
      el('tbody', {},
        ...contacts.map(c => el('tr', {},
          el('td', {},
            el('div', {
              class: 'partner-contacts__name',
              // The verbatim source snippet that evidences this contact.
              title: c.evidence ? `“${c.evidence}”` : undefined,
            }, c.name || el('span', { class: 'partner-contacts__muted' }, '(no name — from attachment)')),
          ),
          el('td', {}, contactCell(c.role)),
          el('td', {}, contactCell(c.company)),
          el('td', {}, c.email
            ? el('a', { class: 'partner-contacts__email-link', href: `mailto:${c.email}` }, c.email)
            : el('span', { class: 'partner-contacts__muted' }, '—')),
          el('td', {}, contactAnalyzerPdfCell(c, contactPdfIndex)),
          el('td', {}, contactSourceChips(c)),
          el('td', { class: 'events-page__td--actions' },
            el('div', { class: 'partner-contacts__actions' },
              buildLeadCheckButton(partner, c),
              iconButton({
                icon: ICONS.edit,
                label: 'Edit',
                title: 'Edit this contact',
                onClick: () => openContactModal(partner, c, () => reRender(partner.partner_id)),
              }),
              iconButton({
                icon: ICONS.trash,
                label: 'Delete',
                title: 'Delete this contact',
                danger: true,
                onClick: () => handleDeleteContact(c, partner),
              }),
            )
          ),
        ))
      )
    )
  );
}

// ── Copy contact emails ──────────────────────────────────────────────
// The little copy button in the Contacts header opens a picker: check the
// people you want, and their email addresses — and nothing else — go on the
// clipboard, comma-separated, ready to paste straight into the To: line of
// an email. Names, roles and companies deliberately stay out of the copied
// text: this exists to start an outreach email, not to export the roster.

const CONTACT_EMAIL_SEPARATOR = ', ';

/** The email on a contact, trimmed — '' when there is none. */
function contactEmailAddress(contact) {
  return String((contact && contact.email) || '').trim();
}

/**
 * The addresses to copy for a set of contacts, in the order the section
 * lists them. Blank emails drop out, and an address that appears on two
 * contacts is carried once (case-insensitively, keeping the casing of the
 * first row that had it) — pasting the same address twice would put a
 * duplicate recipient on the email.
 */
function contactEmailList(contacts) {
  const seen = new Set();
  const emails = [];
  for (const contact of contacts || []) {
    const email = contactEmailAddress(contact);
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

/** The exact string that lands on the clipboard. Commas (not semicolons):
 *  Gmail, Outlook and Apple Mail all split a comma-separated To: line. */
function contactEmailListText(contacts) {
  return contactEmailList(contacts).join(CONTACT_EMAIL_SEPARATOR);
}

/** Plain-text clipboard write, falling back to the legacy path — the async
 *  Clipboard API needs a secure context. Mirrors copyPartnerBio's ladder. */
async function writeTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error('clipboard unavailable');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch {
      return false;
    }
  }
}

/** Put a list of addresses on the clipboard and say what happened. The
 *  caller has already resolved and deduped them (the picker shows the very
 *  string this writes), so nothing is filtered here. */
async function copyEmailAddresses(emails) {
  if (!emails.length) {
    showToast('Those contacts have no email addresses to copy', 'info');
    return;
  }
  const ok = await writeTextToClipboard(emails.join(CONTACT_EMAIL_SEPARATOR));
  showToast(
    ok
      ? `${emails.length} email address${emails.length === 1 ? '' : 'es'} copied — paste into your email`
      : 'Could not copy the email addresses',
    ok ? 'success' : 'error',
  );
}

/**
 * The picker body, its Copy button and the wiring that keeps them in sync.
 * Built as one unit (and returned rather than mounted) so the selection
 * behaviour can be tested without a modal or a browser.
 *
 * Everyone on the roster is listed, in the section's order. Contacts with
 * an email start checked — copying the whole roster is the common case, and
 * unchecking is one click — while contacts without one are shown disabled
 * and labelled, so a missing person reads as "no email on file" rather than
 * looking like the picker dropped them.
 *
 * @param {Array<Object>} contacts
 * @param {{ onCopy: (emails: string[]) => void }} handlers
 */
function buildContactEmailPicker(contacts, { onCopy }) {
  const roster = contacts || [];
  const mailable = roster.filter(c => contactEmailAddress(c));
  const selected = new Set(mailable);

  const copyButton = el('button', { class: 'btn btn--primary' }, 'Copy');
  const selectAllInput = el('input', {
    type: 'checkbox',
    class: 'partner-contacts-copy__checkbox',
    disabled: mailable.length === 0,
  });
  const preview = el('div', { class: 'partner-contacts-copy__preview' });

  // The addresses currently checked, in roster order and deduped — the same
  // list the button counts, the preview shows and the clipboard receives.
  const selectedEmails = () => contactEmailList(roster.filter(c => selected.has(c)));

  const syncControls = () => {
    const emails = selectedEmails();
    copyButton.disabled = emails.length === 0;
    copyButton.textContent = emails.length
      ? `Copy ${emails.length} email${emails.length === 1 ? '' : 's'}`
      : 'Copy';
    selectAllInput.checked = mailable.length > 0 && selected.size === mailable.length;
    selectAllInput.indeterminate = selected.size > 0 && selected.size < mailable.length;
    preview.textContent = emails.length
      ? emails.join(CONTACT_EMAIL_SEPARATOR)
      : 'Nobody selected — check at least one contact.';
    preview.classList.toggle('partner-contacts-copy__preview--empty', emails.length === 0);
  };

  const rowInputs = [];
  const rows = roster.map(contact => {
    const email = contactEmailAddress(contact);
    const input = el('input', {
      type: 'checkbox',
      class: 'partner-contacts-copy__checkbox',
      disabled: !email,
      onChange: () => {
        if (input.checked) selected.add(contact);
        else selected.delete(contact);
        syncControls();
      },
    });
    input.checked = !!email;
    if (email) rowInputs.push({ contact, input });

    const meta = [contact.role, contact.company].map(v => String(v || '').trim()).filter(Boolean).join(' · ');
    return el('label', {
      class: `partner-contacts-copy__row${email ? '' : ' partner-contacts-copy__row--disabled'}`,
    },
      input,
      el('span', { class: 'partner-contacts-copy__who' },
        el('span', { class: 'partner-contacts-copy__name' }, contact.name || '(no name)'),
        meta ? el('span', { class: 'partner-contacts-copy__meta' }, meta) : null,
      ),
      email
        ? el('span', { class: 'partner-contacts-copy__email' }, email)
        : el('span', { class: 'partner-contacts-copy__email partner-contacts-copy__email--none' }, 'No email on file'),
    );
  });

  selectAllInput.addEventListener('change', () => {
    selected.clear();
    if (selectAllInput.checked) mailable.forEach(c => selected.add(c));
    rowInputs.forEach(({ contact, input }) => { input.checked = selected.has(contact); });
    syncControls();
  });

  copyButton.addEventListener('click', () => {
    const emails = selectedEmails();
    if (!emails.length) return;
    onCopy(emails);
  });

  const withoutEmail = roster.length - mailable.length;
  const body = el('div', { class: 'partner-contacts-copy' },
    el('p', { class: 'partner-contacts-copy__intro' },
      'Pick the people to reach out to. Copying puts their email addresses — and nothing '
      + 'else — on the clipboard, separated by commas, ready to paste into the To: line.'),
    el('label', { class: 'partner-contacts-copy__row partner-contacts-copy__row--all' },
      selectAllInput,
      el('span', { class: 'partner-contacts-copy__who' },
        el('span', { class: 'partner-contacts-copy__name' }, 'Select all'),
      ),
      el('span', { class: 'partner-contacts-copy__email' },
        `${mailable.length} with an email${withoutEmail ? ` · ${withoutEmail} without` : ''}`),
    ),
    el('div', { class: 'partner-contacts-copy__list' }, ...rows),
    el('div', { class: 'partner-contacts-copy__preview-label' }, 'What gets copied'),
    preview,
  );

  syncControls();
  return { body, copyButton, selectAllInput, rowInputs, selectedEmails };
}

function openContactEmailCopyModal(partner, contacts) {
  const roster = contacts || [];
  if (!roster.some(c => contactEmailAddress(c))) {
    showToast('None of these contacts has an email address yet — add one first', 'info');
    return;
  }

  const picker = buildContactEmailPicker(roster, {
    onCopy: (emails) => {
      closeModal();
      copyEmailAddresses(emails);
    },
  });

  openModal({
    title: `Copy Emails — ${partner.display_name || 'Partner'}`,
    className: 'modal--wide',
    content: picker.body,
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      picker.copyButton,
    ],
  });
}

function buildPartnerContactsSection(partner, contacts, contactPdfIndex) {
  const isOpen = !collapsedContactSections.has(partner.partner_id);

  const chevron = el('span', {
    class: `partner-contacts__chevron${isOpen ? ' partner-contacts__chevron--open' : ''}`,
    html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });

  const body = el('div', {
    class: `partner-contacts__body${isOpen ? '' : ' partner-contacts__body--collapsed'}`,
  },
    contacts.length > 0
      ? buildContactsTable(partner, contacts, contactPdfIndex)
      : el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-4)' } },
          el('div', { class: 'empty-state__title' }, 'No contacts yet'),
          el('div', { class: 'empty-state__description' },
            'Click "Scan Sources" to extract the people named in this partner\'s descriptions and attachments.'),
        )
  );

  // A scan started here keeps running in the background even if the view
  // re-renders (or the user leaves and comes back), so a freshly built button
  // reflects that in-flight state instead of looking idle. The floating Randy
  // pill is the primary, always-visible progress indicator.
  const scanning = contactScanInFlight === partner.partner_id;
  const scanBtn = el('button', {
    class: 'partner-detail-page__section-cta',
    disabled: scanning,
    onClick: (e) => {
      e.stopPropagation();
      handleScanContacts(partner, scanBtn);
    },
  },
    scanning ? null : el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="3.5" stroke="currentColor" stroke-width="1.6"/><path d="M8.8 8.8L12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
    scanning ? 'Scanning…' : 'Scan Sources',
  );

  const header = el('div', {
    class: 'partner-detail-page__section-header partner-contacts__header',
    onClick: () => {
      const nowOpen = body.classList.toggle('partner-contacts__body--collapsed') === false;
      chevron.classList.toggle('partner-contacts__chevron--open', nowOpen);
      if (nowOpen) collapsedContactSections.delete(partner.partner_id);
      else collapsedContactSections.add(partner.partner_id);
    },
  },
    el('div', { class: 'partner-detail-page__section-title' },
      sectionIcon('people', 'purple', { size: 'sm' }),
      'Contacts',
      el('span', { class: 'partner-detail-page__section-count' }, String(contacts.length)),
      el('span', { class: 'partner-detail-page__section-subtitle' }, 'from descriptions & attachments'),
      chevron,
    ),
    el('div', { class: 'partner-detail-page__section-actions' },
      // Copy emails: pick contacts, get their addresses on the clipboard.
      // Same icon-only idiom as the Next Steps and Descriptions copy buttons.
      contacts.length > 0
        ? el('button', {
            type: 'button',
            class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary partner-detail-page__section-cta--icon',
            title: 'Copy contact email addresses — pick who, then paste into an email',
            'aria-label': 'Copy contact emails',
            'data-label': 'Copy Emails',
            onClick: (e) => {
              e.stopPropagation();
              openContactEmailCopyModal(partner, contacts);
            },
          }, el('span', { class: 'cta-glyph', html: ICONS.copy }))
        : null,
      el('button', {
        class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary',
        onClick: (e) => {
          e.stopPropagation();
          openContactModal(partner, null, () => {
            collapsedContactSections.delete(partner.partner_id);
            reRender(partner.partner_id);
          });
        },
      },
        el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
        'Add Contact',
      ),
      scanBtn,
    ),
  );

  return el('div', { class: 'partner-detail-page__section partner-contacts' }, header, body);
}

// ── Add / Edit contact modal ─────────────────────────────────────────
function openContactModal(partner, existingContact, onSaved) {
  const isEdit = !!existingContact;

  const field = (label, id, value, type = 'text', placeholder = '') => {
    const input = el('input', { class: 'form-input', type, id, placeholder });
    input.value = value || '';
    return { input, group: el('div', { class: 'form-group' }, el('label', { class: 'form-label', for: id }, label), input) };
  };

  // Company pre-fills with the partner: adding a contact from this partner's
  // page means a partner-side person, so their company is the partner
  // organization unless the user types something more specific. A saved
  // (blank-company) row gets the same default when reopened for editing.
  const partnerCompany = partner.display_name || '';

  const name = field('Name *', 'contact-name', isEdit ? existingContact.name : '');
  const role = field('Role / Title', 'contact-role', isEdit ? existingContact.role : '');
  const company = field('Company', 'contact-company', (isEdit ? existingContact.company : '') || partnerCompany);
  const email = field('Email', 'contact-email', isEdit ? existingContact.email : '', 'email');
  const phone = field('Phone', 'contact-phone', isEdit ? existingContact.phone : '', 'tel');

  const formContent = el('div', {},
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Partner'),
      el('input', {
        class: 'form-input', type: 'text', value: partner.display_name, readOnly: true,
        style: { background: 'var(--color-bg)', cursor: 'default' },
      })
    ),
    name.group,
    el('div', { class: 'form-row' }, role.group, company.group),
    el('div', { class: 'form-row' }, email.group, phone.group),
  );

  // Documents panel — contacts now get the same drag-and-drop, Drive-backed
  // uploader that Opportunities, Events and Partners already have. Files key on
  // contact_id (whose `pct_` prefix is distinct from opportunity `opp_`, event
  // `evt_` and partner `p_` ids, so a contact's documents never cross-list with
  // those entities even though all four share one backing sheet). This is also
  // where the Analyzer's Contacts "Create PDF" files its Account Intelligence
  // Brief automatically. A brand-new, unsaved contact has no id to attach to
  // yet, so the dropzone shows a save-first note; existing contacts open in a
  // loading state and fetch their list in the background (docsHandle.refresh()
  // after openModal) so the Apps Script round-trip doesn't block the modal.
  const contactIdForDocs = isEdit ? existingContact.contact_id : null;
  const docsHandle = buildDocumentsPanel({
    entityId: contactIdForDocs,
    // Drive folder name — the contact's own name, matching the Analyzer's
    // contact auto-attach so manual uploads and exported briefs share a folder.
    getContextName: () => name.input.value.trim() || (isEdit ? (existingContact.name || '') : ''),
    initialFiles: [],
    loading: isEdit,
    savePrompt: 'Save this contact first to attach documents',
  });

  const modalContent = el('div', {}, formContent, docsHandle.panel);

  const saveBtn = el('button', {
    class: 'btn btn--primary',
    onClick: async () => {
      const nameVal = name.input.value.trim();
      const emailVal = email.input.value.trim();
      if (!nameVal) { showToast('Please enter a name', 'error'); return; }
      if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
        showToast('That email address doesn\'t look valid', 'error');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const now = nowISO();
        // A cleared Company snaps back to the partner name on save — every
        // saved contact carries a company, so the sheet is self-explanatory
        // wherever it's read.
        const companyVal = company.input.value.trim() || partnerCompany;
        if (isEdit) {
          // Spread the row as it is in the sheet, not as it was when this
          // modal opened, so editing a phone number cannot revert an analysis
          // that finished in the meantime — analysis_json and friends are
          // columns on this same row that nothing in this form touches.
          await updateRowById(
            CONFIG.SHEET_PARTNER_CONTACTS, 'contact_id', existingContact.contact_id,
            (fresh) => partnerContactRowValues({
              ...partnerContactFromRow(fresh),
              name: nameVal,
              role: role.input.value.trim(),
              company: companyVal,
              email: emailVal,
              phone: phone.input.value.trim(),
              updated_at: now,
            }),
          );
          showToast('Contact updated', 'success');
        } else {
          await ensureSheetWithHeaders(CONFIG.SHEET_PARTNER_CONTACTS, PARTNER_CONTACT_HEADERS);
          const fresh = {
            contact_id: uuid('pct'),
            partner_id: partner.partner_id,
            partner_name: partner.display_name || '',
            name: nameVal,
            role: role.input.value.trim(),
            company: companyVal,
            email: emailVal,
            phone: phone.input.value.trim(),
            evidence: '',
            sources: [{ type: 'manual', id: '', label: 'Added manually', date: todayISO() }],
            first_seen: todayISO(),
            last_seen: todayISO(),
            created_at: now,
            updated_at: now,
          };
          await appendRow(CONFIG.SHEET_PARTNER_CONTACTS, partnerContactRowValues(fresh));
          showToast('Contact added', 'success');
        }
        closeModal();
        if (onSaved) onSaved();
      } catch (err) {
        showToast(err.message || 'Failed to save contact', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Contact';
      }
    },
  }, isEdit ? 'Save Changes' : 'Add Contact');

  openModal({
    title: isEdit ? 'Edit Contact' : 'Add Contact',
    content: modalContent,
    // Wider layout to match the other documents-bearing modals (Opportunity /
    // Event), now that the contact modal hosts a Documents panel too.
    className: 'modal--wide',
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      saveBtn,
    ],
  });

  // Kick off the documents fetch only after the modal is on screen so the form
  // shows immediately, then the document list fills in. refresh() self-guards
  // its errors and is a no-op for a new (unsaved) contact with no id.
  if (isEdit) docsHandle.refresh();
}

async function handleDeleteContact(contact, partner) {
  const label = contact.name || contact.email || 'this contact';
  const confirmed = await confirmDialog(
    'Delete Contact',
    `Remove "${label}" from ${partner.display_name}'s contacts? A future scan may re-add it if it still appears in the sources.`
  );
  if (!confirmed) return;

  try {
    // Let any in-flight contact backfill finish first — its in-place row
    // updates must not race a delete that shifts row indexes.
    if (contactBackfillPromise) await contactBackfillPromise;
    await deleteRowById(CONFIG.SHEET_PARTNER_CONTACTS, 'contact_id', contact.contact_id);
    showToast('Contact removed', 'success');
    reRender(partner.partner_id);
  } catch (err) {
    showToast(err.message || 'Failed to delete', 'error');
  }
}

// ── Scan orchestration ───────────────────────────────────────────────
// Reads every partner-scoped source, extracts contacts, verifies them, and
// merges them into Partner_Contacts:
//   1. Drive attachments not yet analyzed run through the Apps Script
//      attendee pipeline (deterministic for spreadsheets); the extraction
//      record is appended to Descriptions — exactly like the Events flow —
//      and the file is marked analyzed so it is never re-processed.
//   2. Description notes, indexed meetings and partner documents go through
//      the client-side extraction, strictly validated verbatim against the
//      sources (js/utils/partner-contacts.js).
//   3. Results merge fill-blanks-only into existing rows, so manual edits
//      always survive; new people become new rows.
// Each stage degrades independently — one broken attachment or a missing AI
// key never discards what the other stages found.
// Holds the partner_id whose contact scan is currently running (or null).
// A partner id — rather than a bare boolean — lets a re-rendered Scan button
// show the correct per-partner state.
let contactScanInFlight = null;

// Bounds for the scan's file-API calls, so a wedged connection turns into a
// per-stage warning instead of a button stuck on "Preparing…" forever.
// Attendee analysis legitimately runs minutes (Apps Script caps it at 6).
const SCAN_LIST_FILES_TIMEOUT_MS = 30_000;
const SCAN_ANALYZE_FILE_TIMEOUT_MS = 300_000;

function scanTimeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
  return c.signal;
}

async function handleScanContacts(partner, btn) {
  if (contactScanInFlight) return;
  contactScanInFlight = partner.partner_id;
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  // Progress rides the global Randy pill so it stays visible after the user
  // leaves this partner page; setLabel also mirrors the current stage onto the
  // button while it is still on-screen.
  // The bar starts indeterminate because the step count is not knowable until
  // the attachment listing comes back; setScanProgress switches it to a real
  // bar the moment that number exists. The budget is per-file: each attachment
  // gets its own server-side analyze call worth up to SCAN_ANALYZE_FILE_TIMEOUT_MS,
  // so a ten-file scan is legitimately a long job and must not be mistaken for
  // a stuck one.
  const pill = createPill('Preparing…', {
    label: partner.display_name || 'Partner',
    hardTimeoutMs: SCAN_ANALYZE_FILE_TIMEOUT_MS * 2,
    progress: true,
  });
  // Total steps = prepare + one per attachment + the notes/extraction pass.
  let scanSteps = 0;
  const setScanProgress = (done) => { if (scanSteps > 0) setPillProgress(pill, done, scanSteps); };
  const setLabel = (text) => {
    updatePillStage(pill, text);
    if (btn.isConnected) btn.textContent = text;
  };
  const warnings = [];

  try {
    setLabel('Preparing…');
    await ensureSheetWithHeaders(CONFIG.SHEET_PARTNER_CONTACTS, PARTNER_CONTACT_HEADERS);

    // Snapshot sources BEFORE attachment analysis appends new description
    // rows, so the AI pass never re-reads content whose contacts were just
    // captured structurally from the file itself.
    const [transcripts, meetings, documentsRows, contactRows] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS, { forceRefresh: true }),
      readSheetAsObjects(CONFIG.SHEET_MEETING_INDEX).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_PARTNER_DOCUMENTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_PARTNER_CONTACTS, { forceRefresh: true }).catch(() => []),
    ]);
    const existing = contactRows
      .filter(c => String(c.partner_id || '').trim() === partner.partner_id)
      .map(partnerContactFromRow);

    const extracted = [];
    const attachmentTextSources = [];

    // ── Stage 1: attachments (Drive files) ──────────────────────────
    let files = [];
    try {
      files = await listEntityDocuments(fileStoreKey('partner', partner.partner_id), {
        signal: scanTimeoutSignal(SCAN_LIST_FILES_TIMEOUT_MS),
        // Include attachments still filed under the bare id, so a scan run
        // before the Setup repair does not silently skip them.
        legacy: {
          key: legacyFileStoreKey('partner', partner.partner_id),
          contextName: partner.display_name || '',
        },
      });
    } catch (err) {
      warnings.push(`Could not list attachments: ${err.message}`);
    }
    // The Analyzer files its own "Create PDF" exports onto this partner, so
    // they appear in this listing. They must never be scanned for contacts:
    // a Partner Analysis PDF contains Randy's LIKELY org chart — people and
    // titles the model inferred — and the attendee pipeline would read those
    // back as if the file were a real attendee list, promoting inferences
    // into verified Partner_Contacts rows. Everything in this table has to be
    // traceable to a genuine source, so the Analyzer's own output is excluded
    // before anything else looks at the files.
    const pendingFiles = withoutAnalyzerExports(files)
      .filter(f => String(f.analyzed || '').toUpperCase() !== 'TRUE');
    // Step count is knowable now: preparing (done) + one per attachment + the
    // notes pass. The bar turns determinate here.
    scanSteps = pendingFiles.length + 2;
    setScanProgress(1);
    for (let i = 0; i < pendingFiles.length; i++) {
      const file = pendingFiles[i];
      setScanProgress(1 + i);
      setLabel(`Attachment ${i + 1}/${pendingFiles.length}…`);
      try {
        const data = await fileApiRequest({
          action: 'analyzeDocument',
          docId: file.doc_id,
          driveUrl: file.drive_url,
          analysisType: 'attendee_list',
          entityType: 'partner',
          eventTitle: partner.display_name || '',
        }, { signal: scanTimeoutSignal(SCAN_ANALYZE_FILE_TIMEOUT_MS) });
        const fileName = data.fileName || file.file_name || 'Attachment';
        const dateISO = todayISO();
        const htmlParts = Array.isArray(data.htmlParts) && data.htmlParts.length
          ? data.htmlParts
          : [data.html || ''];

        // Persist the extraction record as dated Description card(s) — the
        // same durable, visible audit trail the Events flow leaves.
        for (let p = 0; p < htmlParts.length; p++) {
          if (!htmlParts[p]) continue;
          const partLabel = p > 0 ? ` (part ${p + 1} of ${htmlParts.length})` : '';
          const descriptionHtml =
            `<h4>📇 ${escapeHtml(fileName)} — Contacts scanned ${escapeHtml(formatDate(dateISO))}${escapeHtml(partLabel)}</h4>` +
            ensureHtml(htmlParts[p]);
          await appendRow(CONFIG.SHEET_TRANSCRIPTS,
            [uuid('trn'), partner.partner_id, partner.display_name, dateISO, descriptionHtml, nowISO()]);
        }

        if (Array.isArray(data.contacts)) {
          // partnerName arms the affiliation filter: attendee rows whose
          // stated company is ours or some other non-partner company are
          // not partner contacts.
          extracted.push(...attendeeContactsToExtracted(data.contacts, {
            docId: file.doc_id, fileName, date: dateISO,
            partnerName: partner.display_name || '',
          }));
        } else {
          // Older deployed Apps Script without the attendee pipeline — feed
          // its generic analysis text to the strict client-side extraction.
          const text = stripHtml(htmlParts.join('\n'));
          if (text.trim()) {
            attachmentTextSources.push({
              source_id: `att_${file.doc_id}`,
              source_type: 'attachment',
              label: fileName,
              date: dateISO,
              text,
            });
          }
        }
        file.analyzed = 'TRUE'; // server persists the flag; mirror locally
      } catch (err) {
        warnings.push(`${file.file_name || 'Attachment'}: ${err.message}`);
      }
    }

    // ── Stage 2: descriptions / meetings / partner documents ────────
    setScanProgress(scanSteps - 1);
    setLabel('Scanning notes…');
    const { sources, coverage } = collectPartnerContactSources({
      partnerId: partner.partner_id,
      transcripts,
      meetings,
      documents: documentsRows,
    });
    const allSources = [...sources, ...attachmentTextSources];
    if (allSources.length > 0) {
      try {
        const result = await requestPartnerContactsExtraction({
          partnerName: partner.display_name || '',
          sources: allSources,
          today: todayISO(),
        });
        extracted.push(...result.contacts);
        if (result.partial) {
          // The AI reply was cut off at its output limit even after source
          // splitting. Everything recovered is verified and still saved —
          // this only means the roster may not be complete.
          warnings.push(`Note scan: the AI reply was cut off — kept ${result.contacts.length} verified contact(s); some people may be missing.`);
        }
        if (result.dropped.length) {
          console.info('[Partner Contacts] proposals rejected by verbatim verification:', result.dropped);
        }
      } catch (err) {
        warnings.push(`Note scan: ${err.message}`);
      }
    }
    if (coverage.truncatedItems > 0) {
      warnings.push(`${coverage.truncatedItems} long source(s) were truncated for the note scan.`);
    }

    // ── Stage 3: merge + persist ────────────────────────────────────
    setLabel('Saving…');
    const merge = mergeExtractedContacts({
      existing,
      extracted,
      partnerId: partner.partner_id,
      partnerName: partner.display_name || '',
      nowIso: nowISO(),
      makeId: () => uuid('pct'),
    });
    if (merge.toAppend.length) {
      await appendRows(CONFIG.SHEET_PARTNER_CONTACTS, merge.toAppend.map(partnerContactRowValues));
    }
    // Merged onto the row as it stands, not as it was when the scan started.
    // A scan runs attachment fetches and an AI pass, so minutes can pass; an
    // analysis finishing in that window writes analysis_state/analysis_json on
    // this same row, and writing the pre-scan snapshot back would blank it.
    // Only the fields the merge actually computed are applied.
    // One read and one write for the batch: a scan can touch dozens of
    // contacts, and resolving each one separately meant a full read of the
    // tab per contact.
    // Filtered on contact_id for the same reason persistContactBackfill is:
    // the merge gates on `_rowIndex`, so a hand-entered row with a blank
    // column A reaches here, and one unaddressable row would otherwise throw
    // away every enrichment the scan just computed for all the others.
    await updateRowsById(CONFIG.SHEET_PARTNER_CONTACTS, 'contact_id', merge.toUpdate
      .filter(changed => changed.contact_id)
      .map(changed => ({
        id: changed.contact_id,
        values: (fresh) => partnerContactRowValues({ ...partnerContactFromRow(fresh), ...changed }),
      })));

    warnings.forEach(w => console.warn('[Partner Contacts]', w));
    const skipped = merge.skippedNew || [];
    if (skipped.length) {
      console.info('[Partner Contacts] found but not added — a new contact needs an email at the partner\'s domain:', skipped);
    }
    if (merge.added || merge.updated) {
      const bits = [];
      if (merge.added) bits.push(`${merge.added} added`);
      if (merge.updated) bits.push(`${merge.updated} updated`);
      if (skipped.length) bits.push(`${skipped.length} skipped (no partner email)`);
      showToast(`Contacts scan: ${bits.join(', ')}${warnings.length ? ` · ${warnings.length} warning(s) — see console` : ''}`, 'success');
      markPillSuccess(pill, bits.join(', '));
    } else if (warnings.length) {
      showToast(`Contacts scan finished with warnings: ${warnings[0]}`, 'error');
      markPillFailure(pill, `Finished with ${warnings.length} warning(s)`);
    } else if (skipped.length) {
      showToast(`Scan complete — ${skipped.length} ${skipped.length === 1 ? 'person' : 'people'} found but not added: new contacts need an email at the partner's domain`, 'info');
      markPillSuccess(pill, `${skipped.length} found · none added`);
    } else {
      showToast('Scan complete — no new contacts found in the sources', 'info');
      markPillSuccess(pill, 'No new contacts found');
    }

    collapsedContactSections.delete(partner.partner_id);
  } catch (err) {
    showToast(err.message || 'Contact scan failed', 'error');
    markPillFailure(pill, 'Scan failed');
  } finally {
    contactScanInFlight = null;
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    // A scan with attachments can run for minutes — only re-render if the user
    // is still looking at THIS partner's detail page (results are persisted
    // either way). Runs after the in-flight flag is cleared so the rebuilt
    // Scan button shows its idle state; the Randy pill has already settled.
    if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partner.partner_id) {
      reRender(partner.partner_id);
    }
  }
}

// ============================================
// LeadCheck — row-level individual contact analysis
// ============================================
// One click verifies ONE contact from public professional sources (web
// search) plus the contact's own CRM source material. The selected record
// is identified strictly by contact_id — never by row position or name —
// and results are written back to that id only, stored separately from the
// user-entered values (analysis_state / analysis_last_verified /
// analysis_json). See js/utils/partner-contact-leadcheck.js for the full
// accuracy contract enforced on every report.

// Duplicate-run control: contact record id → true while its analysis runs.
// Survives re-renders; other rows stay analyzable in parallel.
const leadCheckRuns = new Map();

function buildLeadCheckButton(partner, contact) {
  const hasLinkedSourceText = (contact.sources || [])
    .some(s => s.type === 'description' || s.type === 'meeting' || s.type === 'partner_document');
  const st = leadCheckButtonState(contact, {
    inFlight: leadCheckRuns.has(contact.contact_id),
    todayIso: todayISO(),
    hasLinkedSourceText,
  });
  const btn = el('button', {
    class: `events-page__action-link partner-lc__row-btn partner-lc__row-btn--${st.kind}`,
    title: st.tooltip,
    disabled: st.disabled || undefined,
    onClick: () => {
      if (st.kind === 'analyzing') return;
      if (st.kind === 'view' || st.kind === 'review') { openLeadCheckReportModal(partner, contact); return; }
      if (st.kind === 'add_info') { openLeadCheckAddInfoModal(partner, contact); return; }
      runLeadCheck(partner, contact, btn);
    },
  }, st.label);
  return btn;
}

/**
 * Persist an analysis result onto the selected record. The row is located
 * by contact_id on a FRESH read (rows may have shifted since render);
 * nothing is ever written to a different row, and the user-entered fields
 * are carried over untouched from that fresh row — with one narrow
 * exception: an EMPTY Role field is filled with the analysis's verified
 * title when the gates in verifiedRoleFromAnalysis pass. Checking the
 * FRESH row means a role someone typed while the analysis ran is never
 * overwritten, and the fingerprint check inside skips the fill when the
 * row's name/company/email changed mid-run.
 */
// This was the local prototype of updateRowById — read fresh, find the row by
// id, write it back — written here first because an analysis takes long enough
// that the page it started from is reliably out of date by the time it lands.
// It now uses the shared helper, with the partner_id check expressed as an
// `expect` so a contact reassigned to another partner mid-analysis is refused
// rather than overwritten.
async function saveContactAnalysis(partner, contactId, { state, lastVerified, record }) {
  let hydrated;
  let filledRole;
  await updateRowById(
    CONFIG.SHEET_PARTNER_CONTACTS, 'contact_id', contactId,
    (fresh) => {
      hydrated = partnerContactFromRow(fresh);
      hydrated.analysis_state = state;
      hydrated.analysis_last_verified = lastVerified;
      filledRole = applyAnalysisRoleToContact(hydrated, record, nowISO());
      hydrated.analysis_json = JSON.stringify(shrinkAnalysisRecordToFit(record));
      return partnerContactRowValues(hydrated);
    },
    { expect: { partner_id: partner.partner_id } },
  );
  return { contact: hydrated, filledRole };
}

function leadCheckReRender(partner) {
  if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partner.partner_id) {
    reRender(partner.partner_id);
  }
}

async function runLeadCheck(partner, contact, btn) {
  const contactId = String(contact.contact_id || '').trim();
  if (!contactId) { showToast('This contact has no record id — re-scan or re-add it first.', 'error'); return; }
  if (leadCheckRuns.has(contactId)) { showToast('This contact is already being analyzed.', 'info'); return; }
  leadCheckRuns.set(contactId, true);
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  // Global Randy pill = the always-visible progress indicator, so the user can
  // leave this partner page and still watch the contact's analysis run. Each
  // contact gets its OWN pill (rows analyze in parallel), so the stack shows
  // one labelled bar per contact in flight.
  //
  // The bar is driven by what the research actually does — each web search it
  // issues, each result set it reads, each chunk of the verdict it writes —
  // rather than by counting rounds. Rounds were the only fact a non-streaming
  // loop had, and they made a bar that was wrong in both directions: a healthy
  // one-round run never left its first sixth, and the pill's silence timer
  // fired mid-run because nothing had been heard for minutes. Now every real
  // step both moves the bar and proves the job is alive, so the give-up budget
  // can be a fifth of what it had to be (see LEADCHECK_STALL_MS).
  const pill = createPill('Analyzing…', {
    label: contact.name || 'Contact',
    hardTimeoutMs: LEADCHECK_STALL_MS,
    progress: { steps: 1, stepMs: 20_000 },
  });
  const progress = createResearchProgress({ startStage: 'Researching the contact…' });
  // The pill carries the words; the row button carries a percentage. Stage text
  // like `Searching: kris huff insight` belongs in the pill, not in a table
  // cell whose width every other row depends on.
  const paint = (next) => {
    if (!next) return;
    updatePillStage(pill, next.stage);
    setPillProgress(pill, next);
    if (btn.isConnected) btn.textContent = `Analyzing… ${next.percent}%`;
  };
  const setStage = (text) => {
    updatePillStage(pill, text);
    if (btn.isConnected) btn.textContent = text;
  };

  try {
    // Header extension also covers sheets created before the analysis
    // columns existed.
    setStage('Checking the contact record…');
    await ensureSheetWithHeaders(CONFIG.SHEET_PARTNER_CONTACTS, PARTNER_CONTACT_HEADERS);

    // Read-only snapshot of the selected record + its linked CRM sources.
    // Three sheet reads, and on a big workbook they are not instant — say so
    // rather than showing a bar that has not moved since the click.
    setStage('Collecting CRM sources…');
    const [transcripts, meetings, documentsRows] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_MEETING_INDEX).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_PARTNER_DOCUMENTS).catch(() => []),
    ]);
    const { snapshot, sourceMaterial, hasLinkedSourceText } = buildLeadCheckSnapshot({
      contact, transcripts, meetings, documents: documentsRows,
    });

    // Deterministic pre-analysis validation — never guess an identity.
    const gate = assessLeadCheckInput(contact, { hasLinkedSourceText });
    if (!gate.sufficient) {
      const record = buildAnalysisRecord({
        state: 'NEEDS_MORE_INFORMATION',
        missing: gate.missing,
        fingerprint: contactFingerprint(contact),
        analyzedAtIso: nowISO(),
      });
      await saveContactAnalysis(partner, contactId, { state: 'NEEDS_MORE_INFORMATION', lastVerified: '', record });
      showToast('Analysis paused: the selected contact does not contain enough professional identity information to distinguish the individual reliably.', 'info');
      markPillFailure(pill, 'Needs more info');
      return;
    }

    const nowIso = nowISO();
    const timezone = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
    })();
    const report = await requestLeadCheckAnalysis({
      contact, snapshot, sourceMaterial, nowIso, timezone,
      // Every observable step of the research — createResearchProgress turns
      // each into a stage line and a bar position that can never claim more
      // than actually happened. Between checkpoints the pill eases forward on
      // its own, and each checkpoint also restarts its silence clock.
      onEvent: (event) => paint(progress.apply(event)),
    });
    paint(progress.saving('Saving…'));

    const record = buildAnalysisRecord({
      state: report.state,
      report,
      missing: report.state === 'NEEDS_MORE_INFORMATION' ? report.missing_information : [],
      fingerprint: contactFingerprint(contact),
      analyzedAtIso: nowIso,
    });
    const lastVerified = report.state === 'NEEDS_MORE_INFORMATION' ? '' : (report.loop_check?.checked_at || nowIso);
    const { filledRole } = await saveContactAnalysis(partner, contactId, { state: report.state, lastVerified, record });

    const toastByState = {
      COMPLETE: ['Analysis complete — identity and role verified.', 'success'],
      COMPLETE_WITH_GAPS: ['Analysis complete with gaps — some items could not be publicly verified.', 'success'],
      NEEDS_REVIEW: ['Analysis needs review — identity could not be established firmly.', 'info'],
      CONFLICT_FOUND: ['Analysis found conflicting public information — open Review to compare.', 'info'],
      NEEDS_MORE_INFORMATION: ['Analysis paused: more identity information is needed.', 'info'],
    };
    const [msg, kind] = toastByState[report.state] || ['Analysis finished.', 'success'];
    showToast(filledRole ? `${msg} Verified role "${filledRole}" filled the empty Role field.` : msg, kind);

    // Settle the pill to match the verdict — green tick for a clean verify,
    // amber for outcomes that still want the user's eyes.
    const pillByState = {
      COMPLETE:               { text: 'Identity & role verified', ok: true },
      COMPLETE_WITH_GAPS:     { text: 'Verified with gaps',       ok: true },
      NEEDS_REVIEW:           { text: 'Needs review',             ok: false },
      CONFLICT_FOUND:         { text: 'Conflicts found',          ok: false },
      NEEDS_MORE_INFORMATION: { text: 'Needs more info',          ok: false },
    };
    const outcome = pillByState[report.state] || { text: 'Analysis finished', ok: true };
    if (outcome.ok) markPillSuccess(pill, outcome.text);
    else markPillFailure(pill, outcome.text);
  } catch (err) {
    console.error('[LeadCheck]', err);
    // Persist the failure so the row shows a retryable state — but never
    // let the failure-write mask the original error.
    try {
      const record = buildAnalysisRecord({
        state: 'FAILED', error: err.message || 'Analysis failed',
        fingerprint: contactFingerprint(contact), analyzedAtIso: nowISO(),
      });
      await saveContactAnalysis(partner, contactId, { state: 'FAILED', lastVerified: '', record });
    } catch { /* ignore secondary failures */ }
    showToast(err.message || 'Contact analysis failed', 'error');
    // Name the reason on the pill too. The toast is gone in seconds and the
    // pill is what the user is actually watching — "Analysis failed" for a
    // rate limit sends them to re-check the record instead of just retrying.
    markPillFailure(pill, researchFailureText(err));
  } finally {
    leadCheckRuns.delete(contactId);
    btn.disabled = false;
    btn.textContent = originalLabel;
    // Re-render after the in-flight flag clears so the rebuilt row button
    // reflects the settled state instead of a stuck "Analyzing…". Guarded to
    // this partner's page; the result is persisted regardless of where the
    // user navigated.
    leadCheckReRender(partner);
  }
}

// ── Add Info modal (NEEDS MORE INFORMATION) ──────────────────────────
function openLeadCheckAddInfoModal(partner, contact) {
  const record = parseAnalysisRecord(contact.analysis_json);
  const missing = (record?.missing || []).length
    ? record.missing
    : assessLeadCheckInput(contact).missing;

  openModal({
    title: 'More Information Needed',
    content: el('div', { class: 'partner-lc' },
      el('p', { class: 'partner-lc__paragraph' },
        'Analysis paused: the selected contact does not contain enough professional identity information to distinguish the individual reliably.'),
      el('p', { class: 'partner-lc__paragraph' }, 'Add at least one of the following, then run Analyze again:'),
      el('ul', { class: 'partner-lc__missing-list' },
        ...missing.map(m => el('li', {}, m)),
      ),
    ),
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Close'),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => {
          closeModal();
          openContactModal(partner, contact, () => reRender(partner.partner_id));
        },
      }, 'Edit Contact'),
    ],
  });
}

// ── Report modal (VIEW ANALYSIS / REVIEW) ────────────────────────────
const LC_BADGE_TONES = {
  ok: ['CONFIRMED', 'PUBLICLY_CONFIRMED', 'COMPLETE', 'PASS', 'HIGH', 'SUPPORTED', 'CONFIRMED_PEER', 'CONFIRMED_TEAM_RELATIONSHIP', 'CURRENT'],
  soft: ['CORROBORATED', 'PROBABLE', 'COMPLETE_WITH_GAPS', 'MEDIUM', 'RECENT', 'LIKELY_PEER', 'LIKELY_COLLABORATOR', 'PATTERN_CONSISTENT', 'PARTIAL', 'FUNCTIONAL_OWNER'],
  warn: ['SINGLE_SOURCE', 'TENTATIVE', 'NEEDS_REVIEW', 'NEEDS_MORE_INFORMATION', 'AMBIGUOUS', 'LOW', 'HISTORICAL', 'ENGAGEMENT_ONLY', 'GENERIC_INFERENCE'],
  danger: ['CONFLICTING', 'CONFLICT_FOUND', 'FAILED', 'FLAGGED', 'FAIL', 'NOT_VERIFIED'],
};

function lcBadgeTone(value) {
  for (const [tone, values] of Object.entries(LC_BADGE_TONES)) {
    if (values.includes(value)) return tone;
  }
  return 'muted';
}

function lcBadge(value) {
  const v = String(value || '').trim();
  if (!v) return el('span', { class: 'partner-contacts__muted' }, '—');
  return el('span', { class: `partner-lc__badge partner-lc__badge--${lcBadgeTone(v)}` }, v.replace(/_/g, ' '));
}

function lcLink(url, label) {
  if (!url) return el('span', { class: 'partner-contacts__muted' }, '—');
  return el('a', { class: 'partner-lc__link', href: url, target: '_blank', rel: 'noopener noreferrer' }, label || url);
}

function lcKV(label, value) {
  return el('div', { class: 'partner-lc__kv' },
    el('div', { class: 'partner-lc__kv-label' }, label),
    el('div', { class: 'partner-lc__kv-value' },
      value == null || value === '' ? el('span', { class: 'partner-contacts__muted' }, '—')
        : (typeof value === 'string' ? value : value)),
  );
}

function lcSection(title, ...children) {
  const kids = children.filter(Boolean);
  if (!kids.length) return null;
  return el('div', { class: 'partner-lc__section' },
    el('div', { class: 'partner-lc__section-title' }, title),
    ...kids,
  );
}

function lcPerson(p, extraBadge) {
  if (!p || (!p.name && !p.title && !p.label)) return null;
  return el('div', { class: 'partner-lc__person' },
    el('div', { class: 'partner-lc__person-main' },
      el('span', { class: 'partner-lc__person-name' }, p.name || '(no named individual)'),
      p.title ? el('span', { class: 'partner-lc__person-title' }, p.title) : null,
      lcBadge(extraBadge || p.label || p.relationship),
      p.confidence ? lcBadge(p.confidence) : null,
    ),
    el('div', { class: 'partner-lc__person-links' },
      p.linkedin_url ? lcLink(p.linkedin_url, 'LinkedIn') : null,
      p.evidence_url ? lcLink(p.evidence_url, 'Evidence') : null,
      p.note ? el('span', { class: 'partner-lc__note' }, p.note) : null,
    ),
  );
}

// Original row values vs verified findings — the row itself is never
// changed by an analysis, so this comparison is the write-back surface.
function lcOriginalVsVerified(contact, report) {
  const rows = [
    ['Name', contact.name, report.profile?.full_name],
    ['Role', contact.role, report.profile?.current_title],
    ['Company', contact.company, report.profile?.current_employer],
    ['Email', contact.email, report.email_evaluation?.email],
  ].filter(([, a, b]) => (a || b));
  if (!rows.length) return null;
  return el('div', { class: 'partner-lc__compare' },
    el('div', { class: 'partner-lc__compare-head' },
      el('span', {}, 'Field'), el('span', {}, 'On file'), el('span', {}, 'Verified'),
    ),
    ...rows.map(([label, orig, verified]) => {
      const differs = orig && verified && orig.trim().toLowerCase() !== verified.trim().toLowerCase();
      return el('div', { class: `partner-lc__compare-row${differs ? ' partner-lc__compare-row--differs' : ''}` },
        el('span', { class: 'partner-lc__compare-label' }, label),
        el('span', {}, orig || el('span', { class: 'partner-contacts__muted' }, '—')),
        el('span', {}, verified || el('span', { class: 'partner-contacts__muted' }, '—')),
      );
    }),
  );
}

function openLeadCheckReportModal(partner, contact) {
  const record = parseAnalysisRecord(contact.analysis_json);
  const report = record?.report;

  if (!report) {
    // FAILED or corrupted record — offer a re-run.
    openModal({
      title: 'Contact Analysis',
      content: el('div', { class: 'partner-lc' },
        el('p', { class: 'partner-lc__paragraph' },
          record?.error ? `The last analysis failed: ${record.error}` : 'No analysis is stored for this contact yet.'),
      ),
      footer: [
        el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Close'),
        el('button', {
          class: 'btn btn--primary',
          onClick: () => { closeModal(); triggerReAnalyze(partner, contact); },
        }, 'Analyze'),
      ],
    });
    return;
  }

  const banners = [];
  if (record.fingerprint && record.fingerprint !== contactFingerprint(contact)) {
    banners.push('The contact\'s name, role, company, or email changed after this analysis — re-analyze to refresh it.');
  }
  const lastVerified = contact.analysis_last_verified || record.analyzed_at || '';
  if (lastVerified) {
    const ageMs = Date.now() - Date.parse(lastVerified);
    if (Number.isFinite(ageMs) && ageMs / 86_400_000 > LEADCHECK_FRESH_DAYS) {
      banners.push(`This analysis is older than ${LEADCHECK_FRESH_DAYS} days — consider re-analyzing.`);
    }
  }

  const conf = report.confidence || {};
  const content = el('div', { class: 'partner-lc' },
    el('div', { class: 'partner-lc__header' },
      el('div', { class: 'partner-lc__header-badges' },
        lcBadge(report.state),
        lcBadge(report.identity?.match),
        lcBadge(conf.label),
      ),
      el('div', { class: 'partner-lc__header-meta' },
        `Coverage ${conf.coverage_pct ?? '—'}% · Confidence ${conf.overall_score ?? '—'}/10`
        + (lastVerified ? ` · Last verified ${String(lastVerified).slice(0, 10)}` : ''),
      ),
    ),
    ...banners.map(b => el('div', { class: 'partner-lc__banner' }, b)),

    lcOriginalVsVerified(contact, report),

    lcSection('Individual Profile',
      lcKV('Full name', report.profile?.full_name),
      lcKV('Current employer', report.profile?.current_employer),
      el('div', { class: 'partner-lc__kv' },
        el('div', { class: 'partner-lc__kv-label' }, 'Current title'),
        el('div', { class: 'partner-lc__kv-value' },
          report.profile?.current_title || el('span', { class: 'partner-contacts__muted' }, '—'),
          ' ', lcBadge(report.profile?.title_status)),
      ),
      lcKV('LinkedIn', report.profile?.linkedin_url ? lcLink(report.profile.linkedin_url) : ''),
      lcKV('Official bio', report.profile?.official_bio_url ? lcLink(report.profile.official_bio_url) : ''),
      lcKV('Location', report.profile?.location),
      lcKV('Role start', [report.profile?.role_start_date, report.profile?.tenure].filter(Boolean).join(' · ')),
      lcKV('Prior role', report.profile?.prior_role),
      lcKV('Useful info', report.profile?.useful_info),
      report.identity?.notes ? lcKV('Identity notes', report.identity.notes) : null,
      (report.identity?.sources || []).length
        ? el('div', { class: 'partner-lc__links-row' },
            ...(report.identity.sources || []).map(s => lcLink(s.url, s.title || 'Source')))
        : null,
    ),

    lcSection('Email Evaluation',
      el('div', { class: 'partner-lc__kv' },
        el('div', { class: 'partner-lc__kv-label' }, 'Address'),
        el('div', { class: 'partner-lc__kv-value' },
          report.email_evaluation?.email || el('span', { class: 'partner-contacts__muted' }, '—'),
          ' ', lcBadge(report.email_evaluation?.status)),
      ),
      lcKV('Dominant format', report.email_evaluation?.dominant_format),
      lcKV('Rationale', report.email_evaluation?.rationale),
      lcKV('Limitation', report.email_evaluation?.limitation),
    ),

    lcSection('Reporting Structure',
      el('div', { class: 'partner-lc__sub-label' }, 'Reports to'),
      lcPerson(report.reporting?.reports_to),
      el('div', { class: 'partner-lc__sub-label' }, 'Functional owner'),
      lcPerson(report.reporting?.functional_owner),
      report.reporting?.one_level_up?.generic_role
        ? el('div', { class: 'partner-lc__kv' },
            el('div', { class: 'partner-lc__kv-label' }, 'One level up (generic)'),
            el('div', { class: 'partner-lc__kv-value' },
              report.reporting.one_level_up.generic_role, ' ', lcBadge(report.reporting.one_level_up.status)),
          )
        : null,
    ),

    (report.peers || []).length
      ? lcSection('Peers & Collaborators', ...(report.peers || []).map(p => lcPerson(p)))
      : null,

    lcSection('Direct Reports',
      ...((report.direct_reports?.people || []).length
        ? (report.direct_reports.people).map(p => lcPerson(p))
        : [el('div', { class: 'partner-lc__note' }, report.direct_reports?.note || NO_DIRECT_REPORTS_NOTE)]),
    ),

    (report.upward_mapping || []).length
      ? lcSection('Upward Mapping', ...(report.upward_mapping || []).map(u => lcPerson({
          name: u.person_or_role, title: u.title, label: u.relationship_type,
          linkedin_url: u.linkedin_url, evidence_url: u.evidence_url, confidence: u.confidence,
        })))
      : null,

    lcSection('Role in the B2B Buying Process',
      el('div', { class: 'partner-lc__kv' },
        el('div', { class: 'partner-lc__kv-label' }, 'Classification'),
        el('div', { class: 'partner-lc__kv-value' },
          lcBadge(report.buying_role?.classification), ' ', lcBadge(report.buying_role?.confidence)),
      ),
      lcKV('Rationale', report.buying_role?.rationale),
      (report.buying_role?.purchase_relevance || []).length
        ? lcKV('Potential purchase relevance', (report.buying_role.purchase_relevance || []).join(' · '))
        : null,
      lcKV('Limitation', report.buying_role?.limitation),
    ),

    lcSection('Function & Responsibilities',
      lcKV('Primary function', report.function_profile?.primary_function),
      (report.function_profile?.verified_responsibilities || []).length
        ? lcKV('Verified', (report.function_profile.verified_responsibilities || []).join(' · '))
        : null,
      (report.function_profile?.interpreted_responsibilities || []).length
        ? lcKV('Interpreted (cautious)', (report.function_profile.interpreted_responsibilities || []).join(' · '))
        : null,
    ),

    (report.content_footprint || []).length
      ? lcSection('Content Footprint',
          ...(report.content_footprint || []).map(c => el('div', { class: 'partner-lc__item' },
            el('div', { class: 'partner-lc__item-main' },
              lcLink(c.url, c.title), ' ', lcBadge(c.recency),
            ),
            el('div', { class: 'partner-lc__item-sub' },
              [c.type, c.publication, c.date, c.role].filter(Boolean).join(' · ')),
            c.relevance ? el('div', { class: 'partner-lc__item-sub' }, c.relevance) : null,
          )))
      : null,

    (report.themes || []).length
      ? lcSection('Recurring Professional Themes',
          ...(report.themes || []).map(t => el('div', { class: 'partner-lc__item' },
            el('div', { class: 'partner-lc__item-main' }, t.name, ' ', lcBadge(t.confidence)),
            t.explanation ? el('div', { class: 'partner-lc__item-sub' }, t.explanation) : null,
            el('div', { class: 'partner-lc__links-row' }, ...(t.urls || []).map(u => lcLink(u, 'Source'))),
          )))
      : null,

    report.post_insights && (report.post_insights.posts_reviewed > 0 || (report.post_insights.colleagues || []).length)
      ? lcSection('Public Post & Comment Insights',
          lcKV('Posts reviewed', String(report.post_insights.posts_reviewed || 0)
            + (report.post_insights.date_range ? ` (${report.post_insights.date_range})` : '')),
          (report.post_insights.topics || []).length ? lcKV('Main topics', report.post_insights.topics.join(' · ')) : null,
          ...(report.post_insights.colleagues || []).map(c2 => lcPerson({
            name: c2.name, title: c2.title, relationship: c2.relationship, evidence_url: c2.evidence_url,
          })),
          lcKV('Limitation', report.post_insights.limitation),
        )
      : null,

    (report.timing_signals || []).length
      ? lcSection('Individual Timing Signals',
          ...(report.timing_signals || []).map(t => el('div', { class: 'partner-lc__item' },
            el('div', { class: 'partner-lc__item-main' }, lcLink(t.url, t.event)),
            el('div', { class: 'partner-lc__item-sub' }, [t.date, t.relevance].filter(Boolean).join(' · ')),
          )))
      : null,

    report.checklist
      ? lcSection('Verification Checklist',
          el('div', { class: 'partner-lc__checklist' },
            ...(report.checklist || []).map(c => el('div', { class: 'partner-lc__check' },
              el('span', { class: 'partner-lc__check-label' }, checklistItemLabel(c)),
              lcBadge(c.result),
            ))),
        )
      : null,

    lcSection('Confidence Summary',
      lcKV('Verification coverage', conf.coverage_calc),
      lcKV('Overall confidence', `${conf.overall_score}/10 (${conf.label})`),
      lcKV('Rationale', conf.rationale),
      lcKV('Sources summary', conf.sources_summary),
      (conf.gaps || []).length ? lcKV('Gaps', conf.gaps.join(' · ')) : null,
      (conf.flagged || []).length
        ? el('div', { class: 'partner-lc__banner partner-lc__banner--danger' }, conf.flagged.join(' '))
        : null,
    ),

    report.loop_check
      ? lcSection('Final Loop Check',
          lcKV('Result', report.loop_check.result),
          lcKV('Checked at', report.loop_check.checked_at),
        )
      : null,

    el('div', { class: 'partner-lc__compliance' }, report.compliance_note || ''),
  );

  openModal({
    title: `Contact Analysis — ${contact.name || contact.email || 'Contact'}`,
    content,
    className: 'modal--wide',
    footer: [
      el('button', {
        class: 'btn btn--ghost',
        onClick: () => {
          const text = leadCheckReportToPlainText(report, contact);
          navigator.clipboard.writeText(text).then(
            () => showToast('Report copied to clipboard', 'success'),
            () => showToast('Failed to copy', 'error'),
          );
        },
      }, 'Copy Report'),
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Close'),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => { closeModal(); triggerReAnalyze(partner, contact); },
      }, 'Re-analyze'),
    ],
  });
}

// Re-run from the modal: the table button for this row (if rendered) shows
// the in-flight state; a detached placeholder button is used otherwise so
// runLeadCheck always has a label target.
function triggerReAnalyze(partner, contact) {
  const placeholder = el('button', {}, 'Analyze');
  runLeadCheck(partner, contact, placeholder);
  reRender(partner.partner_id);
}

// ============================================
// Transcript Components
// ============================================

function transcriptCard(transcript, partner) {
  const dateStr = formatDate(transcript.conversation_date) || formatDate(transcript.created_at);
  const plainText = stripHtml(transcript.transcript_text || '');
  const preview = plainText.slice(0, 120) + (plainText.length > 120 ? '...' : '');

  const toggleIcon = el('span', {
    class: 'transcript-card__toggle',
    html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });

  const body = el('div', { class: 'transcript-card__body' },
    el('div', { class: 'transcript-card__text', html: ensureHtml(transcript.transcript_text || '') }),
    el('div', { class: 'transcript-card__actions' },
      iconButton({
        icon: ICONS.copy,
        label: 'Copy',
        title: 'Copy this description as text',
        onClick: (e) => { e.stopPropagation(); copyTranscriptText(transcript); },
      }),
      iconButton({
        icon: ICONS.download,
        label: 'PDF',
        title: 'Download this description as a PDF',
        onClick: (e) => { e.stopPropagation(); downloadTranscriptPDF(transcript); },
      }),
      iconButton({
        icon: ICONS.edit,
        label: 'Edit',
        title: 'Edit this description',
        onClick: (e) => {
          e.stopPropagation();
          openTranscriptModal(partner, transcript, [], () => reRender(partner.partner_id));
        },
      }),
      iconButton({
        icon: ICONS.trash,
        label: 'Delete',
        title: 'Delete this description',
        danger: true,
        onClick: (e) => { e.stopPropagation(); handleDeleteTranscript(transcript, partner); },
      }),
    )
  );

  const header = el('div', { class: 'transcript-card__header', onClick: () => {
    const isOpen = body.classList.toggle('transcript-card__body--open');
    toggleIcon.classList.toggle('transcript-card__toggle--open', isOpen);
  }},
    el('span', { class: 'transcript-card__date' }, dateStr),
    el('span', { class: 'transcript-card__preview' }, preview),
    toggleIcon
  );

  return el('div', { class: 'transcript-card' }, header, body);
}

function openTranscriptModal(partner, existingTranscript, previousTranscripts, onSaved) {
  const isEdit = !!existingTranscript;

  const dateInput = el('input', {
    class: 'form-input',
    type: 'date',
    id: 'transcript-date',
  });
  // Set value as a DOM property (not setAttribute) so the date picker
  // reliably reflects user changes when read back via dateInput.value
  dateInput.value = isEdit ? (existingTranscript.conversation_date || '') : todayISO();

  const editor = initQuillEditor({
    placeholder: 'Paste or type the call transcript here...',
    initialHtml: isEdit ? existingTranscript.transcript_text : '',
    title: 'Edit Transcript',
  });

  const formContent = el('div', {},
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Partner'),
      el('input', {
        class: 'form-input',
        type: 'text',
        value: partner.display_name,
        readOnly: true,
        style: { background: 'var(--color-bg)', cursor: 'default' },
      })
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Conversation Date'),
      dateInput
    ),
    el('div', { class: 'form-group' },
      el('label', { class: 'form-label' }, 'Transcript'),
      editor.wrapper
    ),
  );

  // Show previous transcripts for reference (only in add mode)
  if (!isEdit && previousTranscripts && previousTranscripts.length > 0) {
    const historySection = el('div', { class: 'transcript-form__history' },
      el('div', { class: 'transcript-form__history-title' }, `Previous Transcripts (${previousTranscripts.length})`),
      ...previousTranscripts.slice(0, 5).map(t =>
        el('div', { class: 'transcript-form__history-item' },
          el('div', { class: 'transcript-form__history-date' }, formatDate(t.conversation_date) || formatDate(t.created_at)),
          el('div', { class: 'transcript-form__history-preview' },
            (() => { const p = stripHtml(t.transcript_text || ''); return p.slice(0, 200) + (p.length > 200 ? '...' : ''); })()
          )
        )
      )
    );
    formContent.appendChild(historySection);
  }

  const saveBtn = el('button', {
    class: 'btn btn--primary',
    onClick: async () => {
      const date = dateInput.value;
      const text = editor.getHtml();
      const editorEmpty = editor.isEmpty();

      if (!date) { showToast('Please enter a date', 'error'); return; }
      if (editorEmpty) { showToast('Please enter the transcript text', 'error'); return; }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';

      try {
        if (isEdit) {
          await updateRowById(
            CONFIG.SHEET_TRANSCRIPTS, 'transcript_id', existingTranscript.transcript_id,
            (fresh) => [
              existingTranscript.transcript_id,
              partner.partner_id,
              partner.display_name,
              date,
              text,
              fresh.created_at || existingTranscript.created_at,
            ],
          );
          showToast('Transcript updated', 'success');
        } else {
          const values = [
            uuid('trn'),
            partner.partner_id,
            partner.display_name,
            date,
            text,
            nowISO(),
          ];
          if (isConfigured()) {
            await appendRow(CONFIG.SHEET_TRANSCRIPTS, values);
          } else {
            addDemoRow(CONFIG.SHEET_TRANSCRIPTS, values);
          }
          showToast('Transcript saved', 'success');
        }
        closeModal();
        if (onSaved) onSaved();
      } catch (err) {
        showToast(err.message || 'Failed to save transcript', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? 'Save Changes' : 'Save Transcript';
      }
    },
  }, isEdit ? 'Save Changes' : 'Save Transcript');

  openModal({
    title: isEdit ? 'Edit Transcript' : 'Add Call Transcript',
    content: formContent,
    className: 'modal--wide',
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      saveBtn,
    ],
  });

  // Initialize Quill after modal is in the DOM
  editor.mount();
}

async function handleDeleteTranscript(transcript, partner) {
  const confirmed = await confirmDialog(
    'Delete Transcript',
    `Are you sure you want to delete this transcript from ${formatDate(transcript.conversation_date)}? This cannot be undone.`
  );
  if (!confirmed) return;

  try {
    await deleteRowById(CONFIG.SHEET_TRANSCRIPTS, 'transcript_id', transcript.transcript_id);
    showToast('Transcript deleted', 'success');
    reRender(partner.partner_id);
  } catch (err) {
    showToast(err.message || 'Failed to delete', 'error');
  }
}

// ============================================
// Copy & PDF Export
// ============================================

function copyTranscriptText(transcript) {
  const body = stripHtml(transcript.transcript_text || '');
  const text = `Partner: ${transcript.partner_name}\nDate: ${transcript.conversation_date}\n\n${body}`;
  navigator.clipboard.writeText(text).then(
    () => showToast('Transcript copied to clipboard', 'success'),
    () => showToast('Failed to copy', 'error')
  );
}

function downloadTranscriptPDF(transcript) {
  if (!window.jspdf) {
    showToast('PDF library loading, try again in a moment', 'error');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(18);
  doc.text(transcript.partner_name || 'Partner', 20, 20);

  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Date: ${formatDate(transcript.conversation_date)}`, 20, 30);

  doc.setDrawColor(200);
  doc.line(20, 34, 190, 34);

  doc.setFontSize(10);
  doc.setTextColor(40);
  const lines = doc.splitTextToSize(stripHtml(transcript.transcript_text || ''), 170);
  doc.text(lines, 20, 42);

  const fileName = `${(transcript.partner_name || 'transcript').replace(/\s+/g, '_')}_${transcript.conversation_date || 'undated'}.pdf`;
  doc.save(fileName);
  showToast('PDF downloaded', 'success');
}

function copyAllTranscripts(partner, transcripts) {
  const divider = '\n\n' + '='.repeat(60) + '\n\n';
  const text = transcripts.map(t => {
    const date = formatDate(t.conversation_date) || formatDate(t.created_at) || 'Undated';
    const body = stripHtml(t.transcript_text || '').trim();
    return `${date}\n${'-'.repeat(60)}\n\n${body}`;
  }).join(divider);

  const fallback = () => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '50%';
    textarea.style.left = '50%';
    textarea.style.transform = 'translate(-50%, -50%)';
    textarea.style.width = '80vw';
    textarea.style.height = '60vh';
    textarea.style.zIndex = '99999';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    showToast('Press Ctrl+C to copy, then click away', 'info');
    textarea.addEventListener('blur', () => {
      if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
    });
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Transcripts copied to clipboard', 'success'),
      () => fallback()
    );
  } else {
    fallback();
  }
}

// ============================================
// Call Transcripts Panel
// ============================================

function buildTranscriptsPanel(partner, transcripts) {
  const actions = el('div', { class: 'partner-detail-page__section-actions' },
    transcripts.length > 0
      ? el('button', {
          type: 'button',
          class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary partner-detail-page__section-cta--icon',
          title: 'Copy all descriptions to the clipboard',
          'aria-label': 'Copy all descriptions',
          'data-label': 'Copy All',
          onClick: () => copyAllTranscripts(partner, transcripts),
        }, el('span', { class: 'cta-glyph', html: ICONS.copy }))
      : null,
    el('button', {
      class: 'partner-detail-page__section-cta',
      onClick: () => openTranscriptModal(partner, null, transcripts, () => reRender(partner.partner_id)),
    },
      el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
      'Add Description',
    ),
  );

  const body = transcripts.length > 0
    ? el('div', { class: 'transcript-list' },
        ...transcripts.map(t => transcriptCard(t, partner))
      )
    : el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-2)' } },
        el('div', { class: 'empty-state__title' }, 'No descriptions yet'),
        el('div', { class: 'empty-state__description' }, 'Click "Add Description" to log a call with this partner.')
      );

  return el('div', {},
    el('div', { class: 'partner-detail-page__section-header' },
      el('div', { class: 'partner-detail-page__section-title' },
        sectionIcon('note', 'teal', { size: 'sm' }),
        'Descriptions',
        el('span', { class: 'partner-detail-page__section-count' }, String(transcripts.length)),
      ),
      actions,
    ),
    body,
  );
}

// ============================================
// Upcoming Events — Compact Consolidated View
// ============================================

const EVENT_TYPE_COLORS = {
  'Webinar': '#0000CC', 'Workshop': '#2222DD',
  'Conference': '#1A1A2E', 'Campaign': '#CC8800', 'Other': '#4A4A5A',
};

// ============================================
// Revenue by Event Chart (Partner-scoped)
// ============================================

// Single brand-cyan fill for chart bars per the Recast brief — replaces
// the previous near-black/per-event-type rainbow that read as "off-brand"
// in the screenshot review.
const PARTNER_CHART_BAR_COLOR = '#0000CC';

function buildPartnerRevenueByEvent(partnerEvents, opportunities) {
  const eventRevenue = {};
  for (const opp of opportunities) {
    const src = opp.lead_source;
    if (!src || src === 'salesperson') continue;
    const val = parseFloat(opp.deal_value) || 0;
    if (!eventRevenue[src]) eventRevenue[src] = { total: 0 };
    eventRevenue[src].total += val;
  }

  const data = [];
  for (const [eventId, rev] of Object.entries(eventRevenue)) {
    const evt = partnerEvents.find(e => e.event_id === eventId);
    const title = evt ? evt.title : eventId;
    data.push({ title, total: rev.total });
  }
  data.sort((a, b) => b.total - a.total);

  if (data.length === 0) {
    return el('div', { class: 'partner-detail-page__chart-card' },
      el('div', { class: 'partner-detail-page__chart-title' }, sectionIcon('chart', 'orange', { size: 'sm' }), 'Revenue by Event'),
      el('div', { class: 'partner-detail-page__chart-empty' }, 'No event-sourced revenue yet'),
    );
  }

  const maxVal = Math.max(...data.map(d => d.total));

  const rows = data.map(d => {
    const pct = maxVal > 0 ? (d.total / maxVal) * 100 : 0;

    return el('div', { class: 'partner-detail-page__bar-row' },
      el('div', { class: 'partner-detail-page__bar-row__label', title: d.title }, d.title),
      el('div', { class: 'partner-detail-page__bar-row__bar' },
        pct > 0 ? el('div', {
          class: 'partner-detail-page__bar-row__segment',
          style: { width: pct + '%', background: PARTNER_CHART_BAR_COLOR },
          title: formatCurrency(d.total),
        }) : null,
      ),
      el('div', { class: 'partner-detail-page__bar-row__value' }, formatCurrency(d.total)),
    );
  });

  return el('div', { class: 'partner-detail-page__chart-card' },
    el('div', { class: 'partner-detail-page__chart-title' }, sectionIcon('chart', 'orange', { size: 'sm' }), 'Revenue by Event'),
    el('div', { class: 'partner-detail-page__chart-subtitle' }, 'Pipeline from demand gen events'),
    el('div', { class: 'partner-detail-page__bar-list' }, ...rows),
  );
}

function buildUpcomingEventsSection(allEvents, partner, container) {
  const upcomingEvents = allEvents
    .filter(e => e.status === 'Upcoming' || e.status === 'In Progress')
    .sort((a, b) => new Date(a.event_date) - new Date(b.event_date));

  const completedCount = allEvents.filter(e => e.status === 'Completed').length;

  return el('div', { class: 'partner-detail-page__section' },
    el('div', { class: 'partner-detail-page__section-header' },
      el('div', { class: 'partner-detail-page__section-title' },
        sectionIcon('calendar', 'red', { size: 'sm' }),
        'Upcoming Joint Events',
        el('span', { class: 'partner-detail-page__section-subtitle' },
          `${upcomingEvents.length} upcoming \u00B7 ${completedCount} completed \u00B7 ${allEvents.length} total`,
        ),
      ),
      el('div', { class: 'partner-detail-page__section-actions' },
        el('button', {
          type: 'button',
          class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary',
          title: 'Open the Events page',
          onClick: () => navigate('/admin/events'),
        },
          el('span', { class: 'cta-glyph', html: ICONS.calendar }),
          'All Events',
        ),
        el('button', {
          class: 'partner-detail-page__section-cta',
          onClick: () => {
            openEventModal(null, container, () => reRender(partner.partner_id));
            setTimeout(() => {
              const sel = document.querySelector('#field-partner_id');
              if (sel) sel.value = partner.partner_id;
            }, 50);
          },
        },
          el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
          'New Event',
        ),
      ),
    ),
    upcomingEvents.length > 0
      ? el('div', { class: 'upcoming-events-list' },
          ...upcomingEvents.map(evt => upcomingEventRow(evt, container))
        )
      : el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-4)' } },
          el('div', { class: 'empty-state__title' }, 'No upcoming events'),
          el('div', { class: 'empty-state__description' }, 'All clear! Create a new event or check the Events tab for past events.')
        )
  );
}

function upcomingEventRow(evt, container) {
  const typeColor = EVENT_TYPE_COLORS[evt.event_type] || '#9B9A9B';
  const startDate = new Date(evt.event_date);
  const month = startDate.toLocaleDateString('en-US', { month: 'short' });
  const day = startDate.getDate();

  const dateRange = formatDate(evt.event_date) +
    (evt.end_date && evt.end_date !== evt.event_date ? ` — ${formatDate(evt.end_date)}` : '');

  return el('div', {
    class: 'upcoming-event-row',
    onClick: () => openEventModal(evt, container),
  },
    // Date badge
    el('div', { class: 'upcoming-event-row__date' },
      el('div', { class: 'upcoming-event-row__month' }, month),
      el('div', { class: 'upcoming-event-row__day' }, String(day))
    ),
    // Type indicator
    el('div', { class: 'upcoming-event-row__type-bar', style: { background: typeColor } }),
    // Content
    el('div', { class: 'upcoming-event-row__content' },
      el('div', { class: 'upcoming-event-row__title' }, evt.title),
      el('div', { class: 'upcoming-event-row__meta' },
        el('span', {
          class: 'upcoming-event-row__type-badge',
          style: { color: typeColor },
        }, evt.event_type),
        el('span', { class: 'upcoming-event-row__date-text' }, dateRange),
        evt.location ? el('span', { class: 'upcoming-event-row__location' }, evt.location) : null,
      )
    ),
    // Status
    el('div', { class: 'upcoming-event-row__status' },
      el('span', {
        class: `badge badge--xs badge--${evt.status === 'In Progress' ? 'in-progress' : 'registered'}`,
      }, evt.status || 'Upcoming')
    )
  );
}

// Escape user/AI-supplied text before interpolating it into the analyzed
// document's HTML header (the file name). Mirrors the helper the Opportunities
// and Events views use for the same purpose.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function cleanup() {}

// Test hook — the Contacts table's column contract and its Analyzer-PDF cell,
// exposed so both can be asserted without a browser. Same pattern as
// __inlineRowActionsInternals in admin-opportunities.js. Not used at runtime.
export const __partnerContactsTableInternals = {
  contactAnalyzerPdfCell,
  buildContactsTable,
  buildPartnerContactsSection,
};

// Test hook — the Contacts header's "Copy Emails" picker: which addresses a
// selection yields and exactly what string reaches the clipboard. Same
// pattern as above. Not used at runtime.
export const __partnerContactEmailCopyInternals = {
  contactEmailAddress,
  contactEmailList,
  contactEmailListText,
  buildContactEmailPicker,
};
