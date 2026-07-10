// ============================================
// LeadCheck Embed View
// ============================================

import { el, mount } from '../utils/dom.js';
import { setTopbarTitle } from '../components/sidebar.js';

export const title = 'LeadCheck';

const LEADCHECK_URL = 'https://aadsit7.github.io/LeadCheck-Pro/#/';

export async function render(container) {
  setTopbarTitle('LeadCheck');

  const content = el('div', {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      margin: 'calc(-1 * var(--space-8))',
      marginTop: 'calc(-1 * var(--space-8))',
    }
  },
    el('iframe', {
      src: LEADCHECK_URL,
      style: {
        flex: '1',
        width: '100%',
        border: 'none',
        minHeight: 'calc(100vh - var(--header-height) - 2px)',
      },
      title: 'LeadCheck',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
    })
  );

  mount(container, content);
}

export function cleanup() {}
