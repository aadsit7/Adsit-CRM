// ============================================
// Partner Dashboard View
// ============================================

import { getCurrentUser } from '../auth.js';
import { readSheetAsObjects, appendRow, isConfigured, addDemoRow } from '../sheets.js';
import { CONFIG } from '../config.js';
import { el, mount, formatCurrency, uuid } from '../utils/dom.js';
import { nowISO, todayISO } from '../utils/date.js';
import { dealCard, statCard } from '../components/card.js';
import { openModal, closeModal } from '../components/modal.js';
import { buildForm } from '../components/form.js';
import { showToast } from '../components/toast.js';
import { setTopbarTitle } from '../components/sidebar.js';
import { filterOpportunities } from '../utils/filters.js';
import { initQuillEditor } from '../components/quill-editor.js';

export const title = 'Opportunities';

export async function render(container) {
  setTopbarTitle('Opportunities');

  const user = getCurrentUser();
  mount(container, el('div', { class: 'loading-overlay' }, el('div', { class: 'spinner' })));

  try {
    const opportunities = await loadOpportunities(user.partner_id);
    renderDashboard(container, opportunities, user);
  } catch (err) {
    mount(container, el('div', { class: 'empty-state' },
      el('div', { class: 'empty-state__title' }, 'Error loading data'),
      el('div', { class: 'empty-state__description' }, err.message)
    ));
  }
}

async function loadOpportunities(partnerId) {
  const all = await readSheetAsObjects(CONFIG.SHEET_OPPORTUNITIES);
  return filterOpportunities(all).filter(o => o.partner_id === partnerId);
}

function renderDashboard(container, opportunities, user) {
  const totalValue = opportunities.reduce((sum, o) => sum + (parseFloat(o.deal_value) || 0), 0);
  const wonDeals = opportunities.filter(o => o.status === 'Won');
  const activeDeals = opportunities.filter(o => o.status !== 'Won' && o.status !== 'Lost');
  const wonValue = wonDeals.reduce((sum, o) => sum + (parseFloat(o.deal_value) || 0), 0);

  const content = el('div', {},
    // Welcome
    el('div', { class: 'section-header' },
      el('div', {},
        el('h2', { class: 'section-header__title' }, `Welcome back, ${user.display_name || user.username}`),
        el('p', { class: 'section-header__subtitle' }, 'Here\'s an overview of your deal registrations')
      ),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => openNewDealModal(user, container)
      },
        el('span', { html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
        'Register Deal'
      )
    ),

    // Stats
    el('div', { class: 'stats-grid stagger' },
      statCard('Total Deals', opportunities.length, {
        icon: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="4" y="3" width="12" height="15" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M7 7h6M7 10h6M7 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        accentColor: 'var(--color-primary)',
      }),
      statCard('Active Pipeline', formatCurrency(totalValue), {
        icon: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 14l4-5 3 3 3.5-5L17 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 5h3v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        accentColor: 'var(--color-primary-lighter)',
      }),
      statCard('Deals Won', wonDeals.length, {
        icon: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 10.5l2.5 2.5 4-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5"/></svg>',
        accentColor: 'var(--color-status-won)',
      }),
      statCard('Revenue Won', formatCurrency(wonValue), {
        icon: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 2l2.2 4.4 4.9.72-3.55 3.46.84 4.88L10 13.27l-4.4 2.23.84-4.88L2.9 7.12l4.9-.72L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
        accentColor: 'var(--color-status-won)',
      }),
    ),

    // Deal cards
    opportunities.length > 0
      ? el('div', {},
          el('h3', {
            style: {
              fontSize: 'var(--text-lg)',
              fontWeight: 'var(--font-semibold)',
              marginBottom: 'var(--space-4)',
            }
          }, 'Your Opportunities'),
          el('div', { class: 'card-grid stagger' },
            ...opportunities.map(opp => dealCard(opp))
          )
        )
      : el('div', { class: 'empty-state' },
          el('div', { class: 'empty-state__icon', html: '<svg width="64" height="64" viewBox="0 0 64 64" fill="none"><rect x="8" y="12" width="48" height="40" rx="4" stroke="currentColor" stroke-width="2"/><path d="M8 24h48" stroke="currentColor" stroke-width="2"/><circle cx="20" cy="36" r="4" stroke="currentColor" stroke-width="2"/><path d="M28 34h16M28 40h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' }),
          el('div', { class: 'empty-state__title' }, 'No deals registered yet'),
          el('div', { class: 'empty-state__description' }, 'Register your first deal to start tracking your pipeline and opportunities.'),
          el('button', {
            class: 'btn btn--primary',
            onClick: () => openNewDealModal(user, container)
          }, 'Register Your First Deal')
        )
  );

  mount(container, content);
}

function openNewDealModal(user, container) {
  const fields = [
    { name: 'deal_name', label: 'Deal Name', required: true, placeholder: 'e.g., Enterprise Cloud Migration' },
    { name: 'customer_name', label: 'Customer Name', required: true, placeholder: 'e.g., Acme Corp' },
    { type: 'row-start' },
    { name: 'deal_value', label: 'Deal Value ($)', type: 'number', required: true, placeholder: '0', min: 0 },
    { name: 'expected_close', label: 'Expected Close', type: 'date', required: true },
    { type: 'row-end' },
    { type: 'row-start' },
    {
      name: 'stage', label: 'Stage', type: 'select', required: true,
      placeholder: 'Select stage...',
      options: ['Prospect', 'Qualified', 'Develop', 'Proposal', 'Negotiation'],
    },
    {
      name: 'status', label: 'Status', type: 'select',
      default: 'Registered',
      options: ['Registered', 'In Progress'],
    },
    { type: 'row-end' },
    { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Brief description of the opportunity...' },
  ];

  const form = buildForm(fields, async (data) => {
    const submitBtn = form.querySelector('.btn--primary') || modal.element.querySelector('.btn--primary');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Registering...';
    }

    try {
      const values = [
        uuid('opp'),
        user.partner_id,
        data.deal_name,
        data.customer_name,
        data.deal_value,
        data.status || 'Registered',
        data.stage,
        data.expected_close,
        data.description,
        nowISO(),
        nowISO(),
        '[]',
        'salesperson',
      ];

      if (isConfigured()) {
        await appendRow(CONFIG.SHEET_OPPORTUNITIES, values);
      } else {
        addDemoRow(CONFIG.SHEET_OPPORTUNITIES, values);
      }

      closeModal();
      showToast('Deal registered successfully!', 'success');

      // Re-render dashboard
      await render(container);
    } catch (err) {
      showToast(err.message || 'Failed to register deal', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Register Deal';
      }
    }
  });

  const modal = openModal({
    title: 'Register New Deal',
    content: form,
    footer: [
      el('button', { class: 'btn btn--secondary', onClick: closeModal }, 'Cancel'),
      el('button', {
        class: 'btn btn--primary',
        onClick: () => form.dispatchEvent(new Event('submit', { cancelable: true })),
      }, 'Register Deal'),
    ],
  });

  // Replace description textarea with Quill rich text editor
  const descTextarea = form.querySelector('[name="description"]');
  if (descTextarea) {
    const descEditor = initQuillEditor({
      placeholder: 'Brief description of the opportunity...',
      title: 'Edit Description',
      onTextChange: () => { descTextarea.value = descEditor.getHtml(); },
    });
    descTextarea.style.display = 'none';
    descTextarea.parentNode.appendChild(descEditor.wrapper);
    descEditor.mount();
  }
}

export function cleanup() {}
