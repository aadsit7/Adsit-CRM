// ============================================
// Mobile table labels
// ============================================
//
// On phones the multi-column data tables (.table, .events-page__table) are
// re-laid-out by css/mobile.css into stacked label/value cards — that CSS
// needs each <td> to carry its column header text in data-label. Rather than
// threading data-label through every view that builds a table (and every
// future one), watch the view container and stamp the labels whenever a
// table appears or its rows change (filtering and sorting re-render rows
// without going through the router).

const TABLE_SELECTOR = 'table.table, table.events-page__table';

function stampTable(table) {
  const headers = Array.from(table.querySelectorAll(':scope > thead th'))
    .map(th => th.textContent.trim());
  if (!headers.length) return;

  for (const row of table.querySelectorAll(':scope > tbody > tr')) {
    const cells = row.children;
    // Full-width rows (colspan placeholders like "no results") keep their
    // native layout — a column label would be meaningless on them.
    if (cells.length === 1 && cells[0].hasAttribute('colspan')) continue;
    for (let i = 0; i < cells.length; i++) {
      const label = headers[i];
      if (label && !cells[i].hasAttribute('data-label')) {
        cells[i].setAttribute('data-label', label);
      }
    }
  }
}

/**
 * Start watching the view container, stamping data-label attributes onto
 * every data-table cell. Attribute-only writes on childList observation, so
 * the observer can't feed itself. Tables here are tens of rows, so a full
 * re-stamp per mutation batch is cheaper than diffing and always correct.
 */
export function initMobileTableLabels() {
  const root = document.getElementById('view-container');
  if (!root || typeof MutationObserver === 'undefined') return;

  const stampAll = () => root.querySelectorAll(TABLE_SELECTOR).forEach(stampTable);

  new MutationObserver(stampAll).observe(root, { childList: true, subtree: true });
  stampAll();
}
