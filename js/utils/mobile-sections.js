// ============================================
// Mobile Section Accordions
// ============================================
//
// The partner-detail page stacks eight full sections — bio, next steps,
// joint events, opportunities, contacts, descriptions, documents — into one
// column. On a desktop that reads as a dense dossier. On a 390px iPhone it
// is a ~3,000px scroll where every section costs most of a screen (an EMPTY
// one still costs ~500px of headline + empty-state prose), so finding the
// one you came for means thumbing past all the others.
//
// On phones each section collapses to its header, turning the page into a
// short index you scan and tap into — the iOS Settings pattern. Partner Bio
// and Next Steps already ship their own collapse, so they are left alone;
// this module simply matches their chevron language so the whole page reads
// as one list.
//
// Implementation note: nothing is re-parented. The JS only tags the header
// (`pd-collapse__header`), the header's parent (`pd-collapse`), and the
// section (`pd-section--collapsed`); mobile.css hides the header's siblings.
// Panels nest their header at different depths (the section header can be a
// direct child, wrapped in a bare div, or inside `.descriptions-panel`), and
// several carry direct-child and adjacent-sibling CSS selectors — leaving the
// tree untouched keeps every one of those rules working exactly as before,
// and lets the documents panel keep filling its list in asynchronously.

import { el } from './dom.js';

const PHONE_QUERY = '(max-width: 768px)';

/** Sections that ship their own collapse keep it (see partner-bio.css). */
const SELF_MANAGED = '.partner-bio__chevron, .partner-next-steps__chevron';

/** A section is driven by whichever of these headers comes first inside it. */
const HEADER_SELECTOR = '.partner-detail-page__section-header, .descriptions-panel__header';

/** The chevron goes here, so it trails the title instead of the CTAs. */
const TITLE_SELECTOR = '.partner-detail-page__section-title, .descriptions-panel__title';

const CHEVRON_HTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Which sections the user has opened, keyed by scope (the partner id) then by
// section name. The view re-renders on every edit — adding a contact, saving a
// deal — so without this, a save would slam shut the section being worked in.
const openSections = new Map();

/**
 * Collapse a view's sections into tappable accordion rows on phones.
 *
 * Safe to call after every render: sections already enhanced are skipped, so
 * a re-render only wires up whatever was rebuilt. A no-op above 768px and on
 * any browser without matchMedia, so the desktop page is untouched.
 *
 * @param {HTMLElement} root       The rendered view root.
 * @param {string}      opts.scope Key the open/closed state belongs to
 *                                 (the partner id), so two partners don't
 *                                 inherit each other's expanded sections.
 */
export function initMobileSections(root, { scope = '' } = {}) {
  if (!root) return;
  if (typeof window === 'undefined' || !window.matchMedia) return;
  if (!window.matchMedia(PHONE_QUERY).matches) return;

  let open = openSections.get(scope);
  if (!open) {
    open = new Set();
    openSections.set(scope, open);
  }

  root.querySelectorAll('.partner-detail-page__section').forEach(section => {
    if (section.dataset.pdCollapse === 'on') return;
    if (section.querySelector(SELF_MANAGED)) return;

    const header = section.querySelector(HEADER_SELECTOR);
    // A header with nothing after it has no body to collapse.
    if (!header || !header.parentElement || !header.nextElementSibling) return;

    const name = sectionName(header);
    const isOpen = open.has(name);

    section.dataset.pdCollapse = 'on';
    section.classList.add('pd-section');
    section.classList.toggle('pd-section--collapsed', !isOpen);
    header.classList.add('pd-collapse__header');
    header.parentElement.classList.add('pd-collapse');

    const chevron = el('span', {
      class: `pd-collapse__chevron${isOpen ? ' pd-collapse__chevron--open' : ''}`,
      html: CHEVRON_HTML,
    });
    (header.querySelector(TITLE_SELECTOR) || header).appendChild(chevron);

    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', String(isOpen));

    const toggle = () => {
      const nowOpen = section.classList.toggle('pd-section--collapsed') === false;
      chevron.classList.toggle('pd-collapse__chevron--open', nowOpen);
      header.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) open.add(name);
      else open.delete(name);
    };

    header.addEventListener('click', (e) => {
      // The header also carries the section's CTAs ("New Opportunity",
      // "Scan Sources", "Copy All"). A tap on one of those is not a tap on
      // the header, and must not fold the section the user is acting on.
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      toggle();
    });

    header.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target !== header) return;  // let controls inside keep their keys
      e.preventDefault();
      toggle();
    });
  });
}

/**
 * The section's name, used as its open/closed key.
 *
 * Read from the title's own text nodes so the leading icon element and the
 * trailing count chip are excluded — "Opportunities", not "Opportunities2",
 * which would otherwise change key every time a deal was added.
 */
function sectionName(header) {
  const title = header.querySelector(TITLE_SELECTOR) || header;
  const text = Array.from(title.childNodes)
    .filter(n => n.nodeType === 3)  // Node.TEXT_NODE
    .map(n => n.textContent.trim())
    .filter(Boolean)
    .join(' ');
  return text || title.textContent.trim();
}
