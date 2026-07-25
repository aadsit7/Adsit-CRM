// ============================================
// Admin Partner Detail View
// ============================================

import { readSheetAsObjects, appendRow, appendRows, updateRow, deleteRowById, isConfigured, addDemoRow, updateDemoRow, ensureSheetWithHeaders } from '../sheets.js';
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
import { requestLeadCheckAnalysis } from '../utils/partner-contact-leadcheck-client.js';
import { createPill, updatePillStage, markPillSuccess, markPillFailure } from '../components/map-pdf-pill.js';

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
    const [partners, opportunities, events, transcripts, contactRows, documentRows] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_PARTNERS),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
      readSheetAsObjects(CONFIG.SHEET_EVENTS),
      readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS),
      readSheetAsObjects(CONFIG.SHEET_PARTNER_CONTACTS).catch(() => []),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITY_DOCUMENTS).catch(() => []),
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

    renderDetail(container, partner, partnerOpps, partnerEvents, partnerTranscripts, partnerContacts, contactPdfIndex);
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

function renderDetail(container, partner, opportunities, partnerEvents, transcripts, partnerContacts = [], contactPdfIndex = null) {
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

    // Section 1: Upcoming Joint Events
    buildUpcomingEventsSection(sortedEvents, partner, container),

    // Section 2: Opportunities — eyebrow header + 4-cell stat strip + deal cards
    el('div', { class: 'partner-detail-page__section' },
      el('div', { class: 'partner-detail-page__section-header' },
        el('div', { class: 'partner-detail-page__section-title' },
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
  for (const c of contacts) {
    if (!c._rowIndex) continue;
    try {
      await updateRow(CONFIG.SHEET_PARTNER_CONTACTS, c._rowIndex, partnerContactRowValues(c));
    } catch (err) {
      console.warn('[Partner Contacts] contact backfill not saved:', err.message);
      return; // the remaining rows would almost certainly fail the same way
    }
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
              el('button', {
                class: 'events-page__action-link',
                onClick: () => openContactModal(partner, c, () => reRender(partner.partner_id)),
              }, 'Edit'),
              el('button', {
                class: 'events-page__action-link events-page__action-link--danger',
                onClick: () => handleDeleteContact(c, partner),
              }, 'Delete'),
            )
          ),
        ))
      )
    )
  );
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
      'Contacts',
      el('span', { class: 'partner-detail-page__section-count' }, String(contacts.length)),
      el('span', { class: 'partner-detail-page__section-subtitle' }, 'from descriptions & attachments'),
      chevron,
    ),
    el('div', { class: 'partner-detail-page__section-actions' },
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
          const updated = {
            ...existingContact,
            name: nameVal,
            role: role.input.value.trim(),
            company: companyVal,
            email: emailVal,
            phone: phone.input.value.trim(),
            updated_at: now,
          };
          await updateRow(CONFIG.SHEET_PARTNER_CONTACTS, existingContact._rowIndex, partnerContactRowValues(updated));
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
  const pill = createPill('Preparing…', { label: partner.display_name || 'Partner' });
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
    for (let i = 0; i < pendingFiles.length; i++) {
      const file = pendingFiles[i];
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
    for (const changed of merge.toUpdate) {
      await updateRow(CONFIG.SHEET_PARTNER_CONTACTS, changed._rowIndex, partnerContactRowValues(changed));
    }

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
async function saveContactAnalysis(partner, contactId, { state, lastVerified, record }) {
  const rows = await readSheetAsObjects(CONFIG.SHEET_PARTNER_CONTACTS, { forceRefresh: true });
  const row = rows.find(r =>
    String(r.contact_id || '').trim() === contactId &&
    String(r.partner_id || '').trim() === partner.partner_id);
  if (!row) throw new Error('This contact no longer exists — the analysis result was not saved.');
  const hydrated = partnerContactFromRow(row);
  hydrated.analysis_state = state;
  hydrated.analysis_last_verified = lastVerified;
  const filledRole = applyAnalysisRoleToContact(hydrated, record, nowISO());
  hydrated.analysis_json = JSON.stringify(shrinkAnalysisRecordToFit(record));
  await updateRow(CONFIG.SHEET_PARTNER_CONTACTS, row._rowIndex, partnerContactRowValues(hydrated));
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
  // leave this partner page and still watch the contact's analysis run.
  const pill = createPill('Analyzing…', { label: contact.name || 'Contact' });
  const setStage = (text) => {
    updatePillStage(pill, text);
    if (btn.isConnected) btn.textContent = text;
  };

  try {
    // Header extension also covers sheets created before the analysis
    // columns existed.
    await ensureSheetWithHeaders(CONFIG.SHEET_PARTNER_CONTACTS, PARTNER_CONTACT_HEADERS);

    // Read-only snapshot of the selected record + its linked CRM sources.
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
      onProgress: (round) => setStage(round > 1 ? `Verifying… (round ${round})` : 'Analyzing…'),
    });

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
    markPillFailure(pill, 'Analysis failed');
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
      el('button', {
        class: 'btn btn--ghost btn--sm',
        onClick: (e) => { e.stopPropagation(); copyTranscriptText(transcript); },
      }, 'Copy Text'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        onClick: (e) => { e.stopPropagation(); downloadTranscriptPDF(transcript); },
      }, 'Download PDF'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        onClick: (e) => {
          e.stopPropagation();
          openTranscriptModal(partner, transcript, [], () => reRender(partner.partner_id));
        },
      }, 'Edit'),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        style: { color: 'var(--color-danger)' },
        onClick: (e) => { e.stopPropagation(); handleDeleteTranscript(transcript, partner); },
      }, 'Delete'),
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
          const values = [
            existingTranscript.transcript_id,
            partner.partner_id,
            partner.display_name,
            date,
            text,
            existingTranscript.created_at,
          ];
          if (isConfigured()) {
            await updateRow(CONFIG.SHEET_TRANSCRIPTS, existingTranscript._rowIndex, values);
          } else {
            updateDemoRow(CONFIG.SHEET_TRANSCRIPTS, existingTranscript._rowIndex, values);
          }
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
          class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary',
          onClick: () => copyAllTranscripts(partner, transcripts),
        }, 'Copy All')
      : null,
    el('button', {
      class: 'partner-detail-page__section-cta',
      onClick: () => openTranscriptModal(partner, null, transcripts, () => reRender(partner.partner_id)),
    },
      el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
      'Add Transcript',
    ),
  );

  const body = transcripts.length > 0
    ? el('div', { class: 'transcript-list' },
        ...transcripts.map(t => transcriptCard(t, partner))
      )
    : el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-2)' } },
        el('div', { class: 'empty-state__title' }, 'No transcripts yet'),
        el('div', { class: 'empty-state__description' }, 'Click "Add Transcript" to log a call with this partner.')
      );

  return el('div', {},
    el('div', { class: 'partner-detail-page__section-header' },
      el('div', { class: 'partner-detail-page__section-title' },
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
  'Webinar': '#2F6BFF', 'Workshop': '#2F6BFF',
  'Conference': '#171D2B', 'Campaign': '#B97A1A', 'Other': '#4A5468',
};

// ============================================
// Revenue by Event Chart (Partner-scoped)
// ============================================

// Single brand-cyan fill for chart bars per the Recast brief — replaces
// the previous near-black/per-event-type rainbow that read as "off-brand"
// in the screenshot review.
const PARTNER_CHART_BAR_COLOR = '#2F6BFF';

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
      el('div', { class: 'partner-detail-page__chart-title' }, 'Revenue by Event'),
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
    el('div', { class: 'partner-detail-page__chart-title' }, 'Revenue by Event'),
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
        'Upcoming Joint Events',
        el('span', { class: 'partner-detail-page__section-subtitle' },
          `${upcomingEvents.length} upcoming \u00B7 ${completedCount} completed \u00B7 ${allEvents.length} total`,
        ),
      ),
      el('div', { class: 'partner-detail-page__section-actions' },
        el('button', {
          class: 'partner-detail-page__section-cta partner-detail-page__section-cta--secondary',
          onClick: () => navigate('/admin/events'),
        }, 'View All Events'),
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
};
