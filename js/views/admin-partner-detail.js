// ============================================
// Admin Partner Detail View
// ============================================

import { readSheetAsObjects, appendRow, updateRow, deleteRow, isConfigured, addDemoRow, updateDemoRow, deleteDemoRow } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, formatCurrency, uuid } from '../utils/dom.js';
import { formatDate, todayISO, nowISO } from '../utils/date.js';
import { navigate } from '../router.js';
import { tierSlug } from '../utils/tiers.js';
import { dealCard } from '../components/card.js';
import { openModal, closeModal, confirmDialog } from '../components/modal.js';
import { openEventModal } from './admin-events.js';
import { openOppModal } from './admin-opportunities.js';
import { setTopbar, setTopbarTitle } from '../components/sidebar.js';
import { showToast } from '../components/toast.js';
import { filterOpportunities, filterEvents } from '../utils/filters.js';
import { stripHtml, ensureHtml, initQuillEditor } from '../components/quill-editor.js';

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
    const [partners, opportunities, events, transcripts] = await Promise.all([
      readSheetAsObjects(CONFIG.SHEET_PARTNERS),
      readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES),
      readSheetAsObjects(CONFIG.SHEET_EVENTS),
      readSheetAsObjects(CONFIG.SHEET_TRANSCRIPTS),
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

    renderDetail(container, partner, partnerOpps, partnerEvents, partnerTranscripts);
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

function renderDetail(container, partner, opportunities, partnerEvents, transcripts) {
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

    // Section 3: Call Transcripts
    el('div', { class: 'partner-detail-page__section' },
      buildTranscriptsPanel(partner, transcripts),
    ),
  );

  mount(container, content);
}

function buildPartnerStatCell(label, value) {
  return el('div', { class: 'partner-detail-page__stat-cell' },
    el('div', { class: 'partner-detail-page__stat-label' }, label),
    el('div', { class: 'partner-detail-page__stat-value' }, value),
  );
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
        'Call Transcripts',
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

export function cleanup() {}
