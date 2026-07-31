// ============================================
// Section Icon — iOS Settings-style icon tile
// ============================================
// The small colored rounded-square ("tile") that leads a section header
// or disclosure row, exactly like the leading icons in the iPhone
// Settings app: solid accent tile, white line glyph, 24% corner radius
// (--radius-tile in tokens.css). Purely decorative — every tile sits
// next to the text label it illustrates, so it is aria-hidden and adds
// no click behavior of its own.
//
// Glyphs share the sidebar's visual grammar: 20×20 viewBox, 1.6 stroke,
// round caps/joins, currentColor (the tile paints them white). Colors
// are the Apple accent set already declared in css/tokens.css.
//
// Usage:
//   import { sectionIcon } from '../components/section-icon.js';
//   el('h2', { class: 'detail-section__title' },
//     sectionIcon('folder', 'blue'), 'Documents')

import { el } from '../utils/dom.js';

// iOS system accent names — must match the .section-icon--<color>
// modifiers in css/section-icons.css (same hexes as tokens.css).
const COLOR_NAMES = ['blue', 'green', 'orange', 'purple', 'indigo', 'teal', 'pink', 'gray', 'red', 'yellow'];

export const SECTION_GLYPHS = {
  // "i" in a circle — general information sections
  info: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 9.2v4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="6.4" r="1" fill="currentColor"/></svg>',
  // single person — customer / contact
  person: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="6.6" r="3.1" stroke="currentColor" stroke-width="1.6"/><path d="M4 16.6c.5-3 2.9-4.8 6-4.8s5.5 1.8 6 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // two people — contacts / attendees / partners
  people: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="7.5" cy="6.5" r="2.6" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 16.4c.4-2.7 2.4-4.3 5-4.3s4.6 1.6 5 4.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="14" cy="7" r="2.1" stroke="currentColor" stroke-width="1.6"/><path d="M14.6 12.3c1.7.4 2.9 1.7 3.2 3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // dollar sign — value / financials / comp
  dollar: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v14M13.4 6.6h-5a2 2 0 100 4h3.2a2 2 0 110 4H6.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // rising bars — stage / pipeline / performance
  chart: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 16.5h13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6 16.5v-5M10 16.5V6.5M14 16.5v-7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // calendar — dates / events
  calendar: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3 8.5h14" stroke="currentColor" stroke-width="1.6"/><path d="M7 2.2v3.4M13 2.2v3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // clock — activity / history / timeline
  clock: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4l2.8 1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // page with text lines — notes / descriptions / bio
  note: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4.5" y="3" width="11" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 7.6h5M7.5 10.6h5M7.5 13.6h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // folder — documents / files
  folder: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 6.3a1.8 1.8 0 011.8-1.8h3l1.8 2h5.6A1.8 1.8 0 0117 8.3v6a1.8 1.8 0 01-1.8 1.8H4.8A1.8 1.8 0 013 14.3v-8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  // check rows — next steps / tasks / to-dos
  checklist: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.6 6.7l1.5 1.5 2.6-2.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.6 6.8h5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3.6 12.9l1.5 1.5 2.6-2.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.6 13h5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // flag — status / milestones
  flag: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5.5 17.5V3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5.5 4h8.9l-2.1 3 2.1 3H5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // megaphone — marketing / campaigns
  megaphone: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M13.5 4.5v9L7.8 11H5.2A1.7 1.7 0 013.5 9.3v-.6A1.7 1.7 0 015.2 7h2.6l5.7-2.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8.2 11.4l.9 3.6a1.2 1.2 0 001.2.9h.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16 7.2a3.2 3.2 0 010 3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // map pin — location / venue
  pin: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 17.3s-5.4-4.5-5.4-8.1A5.4 5.4 0 0110 3.6a5.4 5.4 0 015.4 5.6c0 3.6-5.4 8.1-5.4 8.1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="9" r="1.8" stroke="currentColor" stroke-width="1.6"/></svg>',
  // chain link — linked records / URLs
  link: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8.6 5.9l1.1-1.1a3.3 3.3 0 014.7 4.7l-1.1 1.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11.4 14.1l-1.1 1.1a3.3 3.3 0 01-4.7-4.7l1.1-1.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8.3 11.7l3.4-3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  // sparkles — AI / analysis / insights
  sparkles: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5l1.55 3.15L15 7.55l-2.3 2.25.55 3.2L10 11.5l-3.25 1.5.55-3.2L5 7.55l3.45-.9L10 3.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><path d="M15.5 13.5l.8 1.6 1.7.4-1.25 1.2.3 1.75-1.55-.85-1.55.85.3-1.75L13 15.5l1.7-.4.8-1.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  // building — company / account
  building: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="5" y="3.5" width="10" height="13" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 7h1.3M10.9 7h1.3M8 10h1.3M10.9 10h1.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M9.1 16.5v-2.8h1.8v2.8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  // briefcase — deal / opportunity
  briefcase: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="6.5" width="14" height="9.5" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7.4 6.3V5.2a1.8 1.8 0 011.8-1.8h1.6a1.8 1.8 0 011.8 1.8v1.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3 10.4h14" stroke="currentColor" stroke-width="1.6"/></svg>',
  // star — featured / opportunity
  star: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.8l2.2 4.4 4.9.72-3.55 3.46.84 4.88L10 13.9l-4.4 2.23.84-4.88L2.9 7.92l4.9-.72L10 2.8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  // envelope — email
  envelope: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4.8" width="14" height="10.5" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3.6 6.4L10 10.9l6.4-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // handset — phone
  phone: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6.9 3.6l1.9 3.1-1.6 1.6a12.3 12.3 0 004.5 4.5l1.6-1.6 3.1 1.9-.8 2.3a1.6 1.6 0 01-1.9 1C9.2 15.6 4.4 10.8 3.6 6.3a1.6 1.6 0 011-1.9l2.3-.8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  // concentric rings — goals / forecast / targets
  target: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="3.4" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="0.9" fill="currentColor"/></svg>',
  // tag — type / category
  tag: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 9.9V4.1c0-.33.27-.6.6-.6h5.8l6.6 6.6a1 1 0 010 1.4l-4.6 4.6a1 1 0 01-1.4 0L3.5 9.9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7.1" cy="7.1" r="1.1" fill="currentColor"/></svg>',
  // sliders — setup / configuration
  sliders: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 6h3.2m3.6 0H17M3 13h8.2m3.6 0H17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="6" r="1.8" stroke="currentColor" stroke-width="1.6"/><circle cx="13" cy="13" r="1.8" stroke="currentColor" stroke-width="1.6"/></svg>',
  // globe — region / territory / web
  globe: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h14M10 3c1.9 1.9 2.9 4.3 2.9 7S11.9 15.1 10 17c-1.9-1.9-2.9-4.3-2.9-7S8.1 4.9 10 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

/**
 * Build one iOS-style icon tile.
 *
 * @param {string} glyph One of SECTION_GLYPHS (falls back to 'info').
 * @param {string} color One of the Apple accents: blue | green | orange |
 *                       purple | indigo | teal | pink | gray | red | yellow
 *                       (falls back to 'blue').
 * @param {Object} [opts]
 * @param {'sm'|'lg'} [opts.size] 22px / 32px variants; default 26px.
 * @returns {HTMLElement}
 */
export function sectionIcon(glyph, color = 'blue', { size } = {}) {
  const safeColor = COLOR_NAMES.includes(color) ? color : 'blue';
  const classes = ['section-icon', `section-icon--${safeColor}`];
  if (size === 'sm') classes.push('section-icon--sm');
  if (size === 'lg') classes.push('section-icon--lg');
  return el('span', {
    class: classes.join(' '),
    'aria-hidden': 'true',
    html: SECTION_GLYPHS[glyph] || SECTION_GLYPHS.info,
  });
}
