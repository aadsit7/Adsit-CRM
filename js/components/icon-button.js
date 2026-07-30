// ============================================
// Icon Button — the shared compact icon action
// ============================================
// One vocabulary for the small repeat-actions (edit, delete, copy, view,
// download) that used to be rendered as text links and text buttons in
// tables, cards and section headers. Every button built here is icon-only
// by design, so it always carries all three of:
//   • title       — the hover tooltip (desktop)
//   • aria-label  — the accessible name (screen readers)
//   • data-label  — mobile.css re-attaches this as visible text on phones,
//                   where there is no hover to reveal a tooltip.
// The glyphs share one visual grammar with the SVGs already inline in the
// views: 14×14 viewBox, 1.4 stroke, round caps, currentColor.

import { el } from '../utils/dom.js';

export const ICONS = {
  edit: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M10.5 1.5l2 2-8 8H2.5v-2l8-8z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 4h10M5 4V2.5h4V4M5.5 6.5v3.5M8.5 6.5v3.5M3 4l.5 8h7l.5-8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="4.75" y="4.75" width="7.5" height="7.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.25 2.75v-1H1.75v7.5h1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  view: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1.5 7S3.6 3.25 7 3.25 12.5 7 12.5 7 10.4 10.75 7 10.75 1.5 7 1.5 7z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="7" cy="7" r="1.6" stroke="currentColor" stroke-width="1.4"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.75v6.5M4.25 5.75L7 8.5l2.75-2.75M2 11.75h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  calendar: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1.75" y="2.75" width="10.5" height="9.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M1.75 5.75h10.5M4.5 1.25v2.5M9.5 1.25v2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  sparkle: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5.6 1.6l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1 1-2.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10.6 7.9l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4z" fill="currentColor"/></svg>',
  spinner: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5.2" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.6"/><path d="M12.2 7A5.2 5.2 0 0 0 7 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

/**
 * A 28px flat square icon button for table rows and card footers — the
 * icon-only sibling of the text `events-page__action-link` / ghost buttons
 * it replaces. Same handler, same semantics, a third of the width.
 *
 * @param {Object} opts
 * @param {string} opts.icon     One of ICONS.* (an inline SVG string).
 * @param {string} opts.label    Short action name ("Edit") — becomes the
 *                               aria-label, the data-label (visible on
 *                               phones) and, unless `title` is given, the
 *                               tooltip.
 * @param {Function} opts.onClick
 * @param {string} [opts.title]  Longer tooltip when the label alone is thin.
 * @param {boolean} [opts.danger] Red hover treatment for destructive actions.
 * @param {string} [opts.className] Extra classes.
 */
export function iconButton({ icon, label, onClick, title = '', danger = false, className = '' }) {
  return el('button', {
    type: 'button',
    class: `row-icon-btn${danger ? ' row-icon-btn--danger' : ''}${className ? ` ${className}` : ''}`,
    title: title || label,
    'aria-label': label,
    'data-label': label,
    onClick,
  },
    el('span', { class: 'row-icon-btn__glyph', html: icon }),
  );
}
