// ============================================
// Checklist Component
// ============================================

import { el } from '../utils/dom.js';

const DEFAULT_CHECKLISTS = {
  Webinar: [
    'Confirm speakers', 'Create registration page', 'Send invitations',
    'Prepare slides', 'Test tech setup', 'Send reminder email',
    'Host event', 'Send follow-up',
  ],
  Workshop: [
    'Book venue', 'Prepare materials', 'Confirm attendees',
    'Setup equipment', 'Run workshop', 'Collect feedback',
  ],
  Conference: [
    'Register booth', 'Prepare collateral', 'Book travel',
    'Staff booth', 'Collect leads', 'Follow up',
  ],
  Campaign: [
    'Define target audience', 'Create content', 'Setup tracking',
    'Launch campaign', 'Monitor performance', 'Report results',
  ],
  Other: [
    'Define objectives', 'Assign tasks', 'Set timeline',
    'Execute', 'Review results',
  ],
};

/**
 * Parse checklist JSON string into an array of {text, done} items.
 */
export function parseChecklist(raw, eventType) {
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
  }
  // Return default checklist for the event type
  const defaults = DEFAULT_CHECKLISTS[eventType] || DEFAULT_CHECKLISTS.Other;
  return defaults.map(text => ({ text, done: false }));
}

/**
 * Render an interactive checklist.
 * @param {Array<{text: string, done: boolean}>} items
 * @param {(items: Array) => void} onChange - called whenever items change
 * @returns {HTMLElement}
 */
export function renderChecklist(items, onChange) {
  const wrapper = el('div', { class: 'checklist' });

  function rebuild() {
    wrapper.innerHTML = '';

    // Progress
    const doneCount = items.filter(i => i.done).length;
    const total = items.length;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

    const progressBar = el('div', { class: 'checklist__progress' },
      el('div', { class: 'checklist__progress-bar' },
        el('div', { class: 'checklist__progress-fill', style: { width: `${pct}%` } })
      ),
      el('span', { class: 'checklist__progress-text' }, `${doneCount}/${total} complete`)
    );
    wrapper.appendChild(progressBar);

    // Items
    const list = el('div', { class: 'checklist__items' });

    items.forEach((item, idx) => {
      const checkbox = el('input', {
        type: 'checkbox',
        class: 'checklist__checkbox',
        ...(item.done ? { checked: 'checked' } : {}),
      });

      checkbox.addEventListener('change', () => {
        items[idx].done = checkbox.checked;
        onChange(items);
        rebuild();
      });

      const textEl = el('span', {
        class: `checklist__text${item.done ? ' checklist__text--done' : ''}`,
      }, item.text);

      const deleteBtn = el('button', {
        class: 'checklist__delete',
        title: 'Remove task',
        onClick: (e) => {
          e.stopPropagation();
          items.splice(idx, 1);
          onChange(items);
          rebuild();
        },
      }, '\u00D7');

      const row = el('div', {
        class: `checklist__item${item.done ? ' checklist__item--done' : ''}`,
        draggable: 'true',
      }, checkbox, textEl, deleteBtn);

      // Drag reordering
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/checklist-idx', String(idx));
        row.classList.add('checklist__item--dragging');
      });

      row.addEventListener('dragend', () => {
        row.classList.remove('checklist__item--dragging');
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('checklist__item--dragover');
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('checklist__item--dragover');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('checklist__item--dragover');
        const fromIdx = parseInt(e.dataTransfer.getData('text/checklist-idx'), 10);
        if (isNaN(fromIdx) || fromIdx === idx) return;
        const [moved] = items.splice(fromIdx, 1);
        items.splice(idx, 0, moved);
        onChange(items);
        rebuild();
      });

      list.appendChild(row);
    });

    wrapper.appendChild(list);

    // Add new item input
    const addInput = el('input', {
      type: 'text',
      class: 'checklist__add-input',
      placeholder: 'Add a task...',
    });

    const addBtn = el('button', {
      class: 'btn btn--ghost btn--sm checklist__add-btn',
      onClick: () => addItem(),
    }, '+ Add');

    function addItem() {
      const text = addInput.value.trim();
      if (!text) return;
      items.push({ text, done: false });
      onChange(items);
      rebuild();
      // Re-focus input after rebuild
      setTimeout(() => {
        const newInput = wrapper.querySelector('.checklist__add-input');
        if (newInput) newInput.focus();
      }, 0);
    }

    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem();
      }
    });

    wrapper.appendChild(el('div', { class: 'checklist__add' }, addInput, addBtn));
  }

  rebuild();
  return wrapper;
}
