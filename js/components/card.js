// ============================================
// Card Component Factory
// ============================================

import { el } from '../utils/dom.js';
import { tierSlug } from '../utils/tiers.js';
import { formatCurrency } from '../utils/dom.js';
import { formatDate } from '../utils/date.js';
import { ICONS, iconButton } from './icon-button.js';

/**
 * Create a deal/opportunity card.
 */
export function dealCard(opp, { onEdit, onView } = {}) {
  const statusClass = opp.status?.toLowerCase().replace(/\s+/g, '-') || 'registered';
  const stagePercent = getStagePercent(opp.stage);

  const card = el('div', { class: 'card', onClick: onView },
    el('div', { class: 'card__header' },
      el('div', {},
        el('div', { class: 'card__title' }, opp.deal_name),
        el('div', { class: 'card__subtitle' }, opp.customer_name)
      ),
      el('span', { class: `badge badge--${statusClass}` }, opp.status)
    ),
    el('div', { class: 'card__body' },
      el('div', { class: 'card__meta', style: { marginBottom: 'var(--space-4)' } },
        el('span', { class: 'card__meta-item' },
          el('strong', {}, formatCurrency(opp.deal_value))
        ),
        el('span', { class: 'card__meta-item' }, opp.stage)
      ),
      el('div', { class: 'pipeline-bar' },
        el('div', {
          class: `pipeline-bar__segment pipeline-bar__segment--${statusClass}`,
          style: { width: `${stagePercent}%` }
        })
      )
    ),
    el('div', { class: 'card__footer' },
      el('div', { class: 'card__meta' },
        el('span', { class: 'card__meta-item' },
          svgIcon('calendar-small'),
          formatDate(opp.expected_close)
        )
      ),
      onEdit ? iconButton({
        icon: ICONS.edit,
        label: 'Edit',
        title: 'Edit this deal',
        onClick: (e) => { e.stopPropagation(); onEdit(opp); },
      }) : null
    )
  );

  return card;
}

/**
 * Create a partner summary card (for admin view).
 */
export function partnerCard(partner, stats, { onClick } = {}) {
  const tierClass = tierSlug(partner.tier);

  return el('div', {
    class: `card${onClick ? ' card--clickable' : ''}`,
    onClick: onClick ? () => onClick(partner) : undefined,
  },
    el('div', { class: 'card__header' },
      el('div', {},
        el('div', { class: 'card__title' }, partner.display_name),
        el('div', { class: 'card__subtitle' }, partner.partner_type || '—')
      ),
      el('span', { class: `badge badge--${tierClass}` }, partner.tier)
    ),
    el('div', { class: 'card__body' },
      el('div', { class: 'card__meta' },
        el('span', { class: 'card__meta-item' },
          el('strong', {}, String(stats.totalDeals)),
          ' deals'
        ),
        el('span', { class: 'card__meta-item' },
          el('strong', {}, formatCurrency(stats.totalValue)),
          ' pipeline'
        )
      ),
      stats.totalDeals > 0
        ? el('div', { style: { marginTop: 'var(--space-3)' } },
            el('div', { class: 'pipeline-bar' },
              stats.wonPercent > 0 ? el('div', { class: 'pipeline-bar__segment pipeline-bar__segment--won', style: { width: `${stats.wonPercent}%` } }) : null,
              stats.progressPercent > 0 ? el('div', { class: 'pipeline-bar__segment pipeline-bar__segment--in-progress', style: { width: `${stats.progressPercent}%` } }) : null,
              stats.registeredPercent > 0 ? el('div', { class: 'pipeline-bar__segment pipeline-bar__segment--registered', style: { width: `${stats.registeredPercent}%` } }) : null,
              stats.lostPercent > 0 ? el('div', { class: 'pipeline-bar__segment pipeline-bar__segment--lost', style: { width: `${stats.lostPercent}%` } }) : null
            )
          )
        : null
    ),
    el('div', { class: 'card__footer' },
      el('div', { class: 'card__meta' },
        el('span', { class: 'card__meta-item' }, partner.region)
      ),
      el('span', { class: `badge badge--${partner.status?.toLowerCase() || 'active'}` }, partner.status)
    )
  );
}

/**
 * Create a stat card. Supports interactive mode with accent colors and click filtering.
 * @param {string} label
 * @param {string|number} value
 * @param {string|Object} [options] - String for backward compat (change text), or options object
 * @param {string} [options.change] - Change indicator text
 * @param {string} [options.accentColor] - CSS color for top border accent
 * @param {Function} [options.onClick] - Click handler for interactive filtering
 * @param {boolean} [options.active] - Whether this card is the active filter
 */
export function statCard(label, value, options) {
  if (typeof options === 'string') options = { change: options };
  const { change, accentColor, onClick, active, icon } = options || {};

  const classes = ['stat-card'];
  if (onClick) classes.push('stat-card--clickable');
  if (active) classes.push('stat-card--active');

  const style = {};
  if (accentColor) {
    style.borderLeft = `3px solid ${accentColor}`;
  }

  return el('div', {
    class: classes.join(' '),
    style: Object.keys(style).length ? style : undefined,
    onClick: onClick || undefined,
  },
    icon ? el('div', {
      class: 'stat-card__icon-wrap',
      style: accentColor ? { color: accentColor } : undefined,
      html: icon,
    }) : null,
    el('div', { class: 'stat-card__label' }, label),
    el('div', { class: 'stat-card__value' }, String(value)),
    change ? el('div', { class: 'stat-card__change' }, change) : null
  );
}

function getStagePercent(stage) {
  // Develop sits between Qualified and Proposal (see OPP_STAGES); without
  // it the fallback 10% drew a Develop deal's progress bar below Prospect.
  const stages = { Prospect: 15, Qualified: 35, Develop: 45, Proposal: 55, Negotiation: 75, Closed: 100 };
  return stages[stage] || 10;
}

function svgIcon(name) {
  const icons = {
    'calendar-small': '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 5.5h12" stroke="currentColor" stroke-width="1.2"/><path d="M4 .5v3M10 .5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  };
  return el('span', { html: icons[name] || '', style: { display: 'inline-flex', alignItems: 'center' } });
}
