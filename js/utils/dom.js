// ============================================
// DOM Helper Utilities
// ============================================

/**
 * Create an element with attributes and children.
 * @param {string} tag
 * @param {Object} attrs - { class, id, onclick, dataset, ... }
 * @param  {...(string|Node)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class' || key === 'className') {
      if (Array.isArray(value)) {
        element.classList.add(...value.filter(Boolean));
      } else if (value) {
        element.className = value;
      }
    } else if (key === 'dataset') {
      Object.assign(element.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      element.innerHTML = value;
    } else if (key === 'value') {
      // Set value as a DOM property so date/select inputs reliably
      // reflect user changes when read back via element.value
      element.value = value ?? '';
    } else if (value !== null && value !== undefined && value !== false) {
      element.setAttribute(key, value);
    }
  }

  for (const child of children) {
    if (child == null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      element.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      element.appendChild(child);
    }
  }

  return element;
}

/** Shorthand query selector */
export function $(selector, parent = document) {
  return parent.querySelector(selector);
}

/** Shorthand query selector all */
export function $$(selector, parent = document) {
  return [...parent.querySelectorAll(selector)];
}

/** Clear all children of an element */
export function clear(element) {
  element.innerHTML = '';
}

/** Mount content into a container with animation */
export function mount(container, ...children) {
  clear(container);
  const wrapper = el('div', { class: 'view-enter' }, ...children);
  container.appendChild(wrapper);
}

/** Format a number as USD currency */
export function formatCurrency(value) {
  const num = parseFloat(value) || 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

/** Generate a simple UUID */
export function uuid(prefix = '') {
  const id = crypto.getRandomValues(new Uint32Array(2))
    .reduce((acc, v) => acc + v.toString(36), '');
  return prefix ? `${prefix}_${id}` : id;
}

/** Debounce function */
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Create a collapsible dashboard section with summary bar.
 * @param {Object} opts
 * @param {string} opts.id - Unique ID for localStorage persistence
 * @param {string} opts.title - Section title
 * @param {Array<{label:string, value:string}>} opts.summaryItems - Compressed metrics
 * @param {HTMLElement} opts.content - The inner content (bento grid, charts, etc.)
 * @param {boolean} [opts.defaultOpen=true] - Default expanded state
 * @returns {HTMLElement}
 */
export function collapsibleSection({ id, title, summaryItems, content, defaultOpen = true }) {
  const STORAGE_KEY = `dashboard-collapsed-${id}`;
  const stored = localStorage.getItem(STORAGE_KEY);
  const isOpen = stored !== null ? stored === 'open' : defaultOpen;

  const chevronSvg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 8l5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const summaryChildren = [];
  summaryItems.forEach((item, i) => {
    if (i > 0) {
      summaryChildren.push(el('div', { class: 'dashboard-section__summary-divider' }));
    }
    summaryChildren.push(
      el('div', { class: 'dashboard-section__summary-item' },
        el('span', { class: 'dashboard-section__summary-value' }, item.value),
        item.label
      )
    );
  });

  const section = el('div', {
    class: `dashboard-section ${isOpen ? 'dashboard-section--open' : ''}`,
  },
    el('div', {
      class: 'dashboard-section__header',
      onClick: () => {
        const nowOpen = section.classList.toggle('dashboard-section--open');
        localStorage.setItem(STORAGE_KEY, nowOpen ? 'open' : 'collapsed');
      },
    },
      el('div', { class: 'dashboard-section__title-group' },
        el('span', { class: 'dashboard-section__title' }, title),
      ),
      el('div', { class: 'dashboard-section__summary' }, ...summaryChildren),
      el('span', { class: 'dashboard-section__chevron', html: chevronSvg }),
    ),
    el('div', { class: 'dashboard-section__body-outer' },
      el('div', { class: 'dashboard-section__body-inner' },
        el('div', { class: 'dashboard-section__body' }, content)
      )
    )
  );

  return section;
}
