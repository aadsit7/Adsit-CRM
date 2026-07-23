// ============================================
// Admin Partner Detail View
// ============================================

import { readSheetAsObjects, appendRow, appendRows, updateRow, deleteRow, isConfigured, addDemoRow, updateDemoRow, deleteDemoRow, ensureSheetWithHeaders } from '../sheets.js';
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
} from '../utils/partner-contacts.js';
import { requestPartnerContactsExtraction } from '../utils/partner-contacts-client.js';

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
    const [partners, opportunities, events, transcripts, contactRows] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_PARTNERS),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
      readSheetAsObjects(CONFIG.SHEET_EVENTS),
      readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS),
      readSheetAsObjects(CONFIG.SHEET_PARTNER_CONTACTS).catch(() => []),
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

    renderDetail(container, partner, partnerOpps, partnerEvents, partnerTranscripts, partnerContacts);
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

function renderDetail(container, partner, opportunities, partnerEvents, transcripts, partnerContacts = []) {
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
    buildPartnerContactsSection(partner, partnerContacts),

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
    entityId: partner.partner_id,
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
      // document shows as analyzed — the same full re-render every other
      // mutation in this view uses.
      reRender(partner.partner_id);
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
// contract) or entered manually. The section is collapsed by default —
// clicking the header reveals the table matrix.

// Which partners' contact tables are expanded, surviving the full-page
// re-renders every mutation in this view performs.
const expandedContactSections = new Set();

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

function buildContactsTable(partner, contacts) {
  return el('div', { class: 'events-page__table-wrapper partner-contacts__table-wrapper' },
    el('table', { class: 'events-page__table events-page__table--compact partner-contacts__table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Name'),
          el('th', {}, 'Role'),
          el('th', {}, 'Company'),
          el('th', {}, 'Email'),
          el('th', {}, 'Phone'),
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
          el('td', {}, contactCell(c.phone)),
          el('td', {}, contactSourceChips(c)),
          el('td', { class: 'events-page__td--actions' },
            el('div', { class: 'partner-contacts__actions' },
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

function buildPartnerContactsSection(partner, contacts) {
  const isOpen = expandedContactSections.has(partner.partner_id);

  const chevron = el('span', {
    class: `partner-contacts__chevron${isOpen ? ' partner-contacts__chevron--open' : ''}`,
    html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });

  const body = el('div', {
    class: `partner-contacts__body${isOpen ? '' : ' partner-contacts__body--collapsed'}`,
  },
    contacts.length > 0
      ? buildContactsTable(partner, contacts)
      : el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-4)' } },
          el('div', { class: 'empty-state__title' }, 'No contacts yet'),
          el('div', { class: 'empty-state__description' },
            'Click "Scan Sources" to extract the people named in this partner\'s descriptions and attachments.'),
        )
  );

  const scanBtn = el('button', {
    class: 'partner-detail-page__section-cta',
    onClick: (e) => {
      e.stopPropagation();
      handleScanContacts(partner, scanBtn);
    },
  },
    el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="3.5" stroke="currentColor" stroke-width="1.6"/><path d="M8.8 8.8L12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
    'Scan Sources',
  );

  const header = el('div', {
    class: 'partner-detail-page__section-header partner-contacts__header',
    onClick: () => {
      const nowOpen = body.classList.toggle('partner-contacts__body--collapsed') === false;
      chevron.classList.toggle('partner-contacts__chevron--open', nowOpen);
      if (nowOpen) expandedContactSections.add(partner.partner_id);
      else expandedContactSections.delete(partner.partner_id);
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
            expandedContactSections.add(partner.partner_id);
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

  const name = field('Name *', 'contact-name', isEdit ? existingContact.name : '');
  const role = field('Role / Title', 'contact-role', isEdit ? existingContact.role : '');
  const company = field('Company', 'contact-company', isEdit ? existingContact.company : '');
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
        if (isEdit) {
          const updated = {
            ...existingContact,
            name: nameVal,
            role: role.input.value.trim(),
            company: company.input.value.trim(),
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
            company: company.input.value.trim(),
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
    content: formContent,
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      saveBtn,
    ],
  });
}

async function handleDeleteContact(contact, partner) {
  const label = contact.name || contact.email || 'this contact';
  const confirmed = await confirmDialog(
    'Delete Contact',
    `Remove "${label}" from ${partner.display_name}'s contacts? A future scan may re-add it if it still appears in the sources.`
  );
  if (!confirmed) return;

  try {
    await deleteRow(CONFIG.SHEET_PARTNER_CONTACTS, contact._rowIndex);
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
let contactScanInFlight = false;

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
  contactScanInFlight = true;
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  const setLabel = (text) => { btn.textContent = text; };
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
      files = await listEntityDocuments(partner.partner_id, { signal: scanTimeoutSignal(SCAN_LIST_FILES_TIMEOUT_MS) });
    } catch (err) {
      warnings.push(`Could not list attachments: ${err.message}`);
    }
    const pendingFiles = files.filter(f => String(f.analyzed || '').toUpperCase() !== 'TRUE');
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
          extracted.push(...attendeeContactsToExtracted(data.contacts, {
            docId: file.doc_id, fileName, date: dateISO,
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
    if (merge.added || merge.updated) {
      const bits = [];
      if (merge.added) bits.push(`${merge.added} added`);
      if (merge.updated) bits.push(`${merge.updated} updated`);
      showToast(`Contacts scan: ${bits.join(', ')}${warnings.length ? ` · ${warnings.length} warning(s) — see console` : ''}`, 'success');
    } else if (warnings.length) {
      showToast(`Contacts scan finished with warnings: ${warnings[0]}`, 'error');
    } else {
      showToast('Scan complete — no new contacts found in the sources', 'info');
    }

    expandedContactSections.add(partner.partner_id);
    // A scan with attachments can run for minutes — only re-render if the
    // user is still looking at THIS partner's detail page. The results are
    // already persisted either way.
    if (getCurrentPath() === '/admin/partner-detail' && getQueryParams().id === partner.partner_id) {
      reRender(partner.partner_id);
    }
  } catch (err) {
    showToast(err.message || 'Contact scan failed', 'error');
  } finally {
    contactScanInFlight = false;
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
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
    if (isConfigured()) {
      await deleteRow(CONFIG.SHEET_TRANSCRIPTS, transcript._rowIndex);
    } else {
      deleteDemoRow(CONFIG.SHEET_TRANSCRIPTS, transcript._rowIndex);
    }
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
