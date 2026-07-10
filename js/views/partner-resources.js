// ============================================
// Partner Support & Resources View
// ============================================

import { CONFIG } from '../config.js';
import { el, mount } from '../utils/dom.js';
import { setTopbarTitle } from '../components/sidebar.js';

export const title = 'Resources';

export async function render(container) {
  setTopbarTitle('Resources');

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
      src: CONFIG.SUPPORT_URL,
      style: {
        flex: '1',
        width: '100%',
        border: 'none',
        minHeight: 'calc(100vh - var(--header-height) - 2px)',
      },
      title: 'Support & Resources',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
    })
  );

  mount(container, content);
}

export function cleanup() {}
