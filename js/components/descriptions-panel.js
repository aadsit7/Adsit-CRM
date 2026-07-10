// ============================================
// Descriptions Panel — versioned dated description cards
// ============================================
// Shared between Opportunities and Events. Schema-agnostic: callers
// pass in a workingDescriptions array of plain objects with
// { description_text, description_date, created_at, ...flags } and
// handle persistence themselves (see openOppModal / openEventModal).
//
// Extracted from admin-opportunities.js so admin-events.js can reuse
// the exact same UI without duplicating the Quill+date+save/cancel
// card logic.
// ============================================

import { el, uuid } from '../utils/dom.js';
import { nowISO, formatDate, todayISO } from '../utils/date.js';
import { confirmDialog } from './modal.js';
import { showToast } from './toast.js';
import { initQuillEditor, ensureHtml, stripHtml } from './quill-editor.js';

/**
 * Normalize a timestamp to YYYY-MM-DD (local date portion only).
 */
export function toISODateOnly(value) {
  if (!value) return '';
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return str.split('T')[0];
  const d = new Date(str);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * True if a working description has no visible text content.
 * Treats both missing text and Quill's empty-state markup
 * (e.g. "<p><br></p>") as empty.
 */
export function isDescriptionEmpty(desc) {
  return stripHtml(desc.description_text || '').trim() === '';
}

/**
 * Among the working descriptions (ignoring ones flagged for delete or
 * left empty), return the HTML text of the one with the newest
 * description_date. Excluding empties matches the save-time filters so
 * an unfilled new card can never overwrite the entity-row description.
 */
export function pickLatestDescriptionText(workingDescriptions) {
  const live = workingDescriptions.filter(d => !d._deleted && !isDescriptionEmpty(d));
  if (live.length === 0) return '';
  const sorted = [...live].sort((a, b) =>
    new Date(b.description_date || b.created_at || 0) -
    new Date(a.description_date || a.created_at || 0)
  );
  return sorted[0].description_text || '';
}

export function getDescriptionKey(desc) {
  return desc.description_id || desc._tempId;
}

/**
 * Builds the date + Quill editor + Save/Cancel form body for a description.
 * Shared between descriptionCard (deferred save via onListChanged) and
 * external focused-edit dialogs (immediate persistence).
 *
 * @param {Object} desc       - Description object. Mutated in-place on save, reverted on cancel.
 * @param {Object} opts
 * @param {string} opts.key   - Unique key for the date <input> id.
 * @param {string} [opts.placeholder] - Editor placeholder text.
 * @param {Function} [opts.onTextChange] - Quill text-change callback (omit for dialog context).
 * @param {Function} opts.onSave   - async; called after desc is updated; handles persistence/UI.
 * @param {Function} opts.onCancel - called with { snapshot } after desc is reverted.
 * @returns {HTMLElement}
 */
export function buildDescriptionEditorForm(desc, { key, placeholder, onTextChange, onSave, onCancel }) {
  const snapshot = {
    description_date: desc.description_date,
    description_text: desc.description_text,
    _modified: !!desc._modified,
  };

  const dateInput = el('input', {
    class: 'form-input',
    type: 'date',
    id: `desc-date-${key}`,
  });
  dateInput.value = desc.description_date || todayISO();

  dateInput.addEventListener('change', () => {
    const v = dateInput.value || todayISO();
    if (v !== desc.description_date) {
      desc.description_date = v;
      if (!desc._isNew) desc._modified = true;
    }
  });

  const editor = initQuillEditor({
    placeholder: placeholder || 'Write the description...',
    initialHtml: desc.description_text || '',
    title: 'Edit Description',
    onTextChange,
  });

  let saving = false;
  const saveBtn = el('button', {
    class: 'btn btn--primary btn--sm',
    onClick: async (e) => {
      e.stopPropagation();
      if (saving) return;
      const newDate = dateInput.value || todayISO();
      const newText = editor.getHtml();
      if (editor.isEmpty()) {
        showToast('Please enter description text', 'error');
        return;
      }
      const dateChanged = newDate !== desc.description_date;
      const textChanged = newText !== desc.description_text;
      desc.description_date = newDate;
      desc.description_text = newText;
      if (!desc._isNew && (dateChanged || textChanged)) {
        desc._modified = true;
      }
      saving = true;
      saveBtn.disabled = true;
      try {
        await onSave({ snapshot });
      } finally {
        saving = false;
        saveBtn.disabled = false;
      }
    },
  }, 'Save');

  const cancelBtn = el('button', {
    class: 'btn btn--ghost btn--sm',
    onClick: (e) => {
      e.stopPropagation();
      desc.description_date = snapshot.description_date;
      desc.description_text = snapshot.description_text;
      desc._modified = snapshot._modified;
      onCancel({ snapshot });
    },
  }, 'Cancel');

  const body = el('div', { class: 'transcript-card__body transcript-card__body--open' },
    el('div', { class: 'form-group', style: { marginBottom: 'var(--space-3)' } },
      el('label', { class: 'form-label', for: `desc-date-${key}` }, 'Date'),
      dateInput,
    ),
    el('div', { class: 'form-group', style: { marginBottom: 'var(--space-3)' } },
      el('label', { class: 'form-label' }, 'Description'),
      editor.wrapper,
    ),
    el('div', { class: 'transcript-card__actions' },
      saveBtn,
      cancelBtn,
    ),
  );

  requestAnimationFrame(() => editor.mount());
  return body;
}

/**
 * A single description card. Supports three UI states:
 *   - collapsed (date + preview)
 *   - expanded view (full HTML + Edit/Delete)
 *   - expanded edit (date input + Quill editor + Save/Cancel)
 *
 * Changes to the underlying `desc` object (workingDescriptions entry)
 * are applied in-place; persistence happens on the parent modal submit.
 */
function descriptionCard(desc, onListChanged, opts) {
  const key = getDescriptionKey(desc);
  // Persist expand/edit state on the desc object so it survives list rebuilds
  // that happen after an add/save/delete.
  if (desc._startInEdit) {
    desc._uiOpen = true;
    desc._uiEditing = true;
    delete desc._startInEdit;
  }
  let isOpen = !!desc._uiOpen;
  let isEditing = !!desc._uiEditing;

  const card = el('div', { class: 'transcript-card', 'data-desc-key': key });

  function syncState() {
    desc._uiOpen = isOpen;
    desc._uiEditing = isEditing;
  }

  function rebuild() {
    syncState();
    card.innerHTML = '';
    card.appendChild(renderHeader());
    const body = renderBody();
    if (body) card.appendChild(body);
  }

  function renderHeader() {
    const plainText = stripHtml(desc.description_text || '');
    const preview = plainText
      ? plainText.slice(0, 120) + (plainText.length > 120 ? '...' : '')
      : (desc._isNew ? 'New description (unsaved)' : 'Empty');
    const dateStr = desc.description_date ? formatDate(desc.description_date) : '—';

    const toggleIcon = el('span', {
      class: 'transcript-card__toggle' + (isOpen ? ' transcript-card__toggle--open' : ''),
      html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    });

    return el('div', {
      class: 'transcript-card__header',
      onClick: () => {
        if (isEditing) return; // don't collapse while editing
        isOpen = !isOpen;
        rebuild();
      },
    },
      el('span', { class: 'transcript-card__date' }, dateStr),
      el('span', { class: 'transcript-card__preview' }, preview),
      toggleIcon
    );
  }

  function renderBody() {
    if (!isOpen) return null;
    return isEditing ? renderEditBody() : renderViewBody();
  }

  function renderViewBody() {
    return el('div', { class: 'transcript-card__body transcript-card__body--open' },
      el('div', { class: 'transcript-card__text', html: ensureHtml(desc.description_text || '') }),
      el('div', { class: 'transcript-card__actions' },
        el('button', {
          class: 'btn btn--ghost btn--sm',
          onClick: (e) => {
            e.stopPropagation();
            isEditing = true;
            rebuild();
          },
        }, 'Edit'),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          style: { color: 'var(--color-danger)' },
          onClick: async (e) => {
            e.stopPropagation();
            const confirmed = await confirmDialog(
              'Delete Description',
              'Are you sure you want to remove this description version? This will take effect when you save.'
            );
            if (!confirmed) return;
            desc._deleted = true;
            onListChanged();
          },
        }, 'Delete'),
      )
    );
  }

  function renderEditBody() {
    return buildDescriptionEditorForm(desc, {
      key,
      placeholder: opts.placeholder,
      onTextChange: (quill) => {
        const html = quill.root.innerHTML.trim();
        if (html !== desc.description_text) {
          desc.description_text = html;
          if (!desc._isNew) desc._modified = true;
        }
      },
      onSave: async () => {
        isEditing = false;
        isOpen = true;
        syncState();
        onListChanged();
      },
      onCancel: ({ snapshot }) => {
        if (desc._isNew && !snapshot.description_text) {
          // Brand-new card that was never populated → drop it entirely.
          desc._deleted = true;
          syncState();
          onListChanged();
        } else {
          isEditing = false;
          rebuild();
        }
      },
    });
  }

  rebuild();
  return card;
}

/**
 * Builds the Descriptions panel: header (title + count + Add button) and
 * a vertical list of description cards. Returns { panel, refresh } where
 * refresh() rebuilds the visible list from workingDescriptions.
 *
 * @param {Array} workingDescriptions - Mutated in place. Each entry shape:
 *   { description_id?, description_date, description_text, created_at,
 *     _rowIndex?, _tempId?, _isNew?, _modified?, _deleted?,
 *     _uiOpen?, _uiEditing?, _startInEdit? }
 * @param {Object} [options]
 * @param {string} [options.placeholder] - Editor placeholder text shown in edit mode.
 * @param {string} [options.entityLabel] - Word used in empty-state copy ("opportunity"|"event"|...).
 * @returns {{ panel: HTMLElement, refresh: Function }}
 */
export function buildDescriptionsPanel(workingDescriptions, options = {}) {
  const opts = {
    placeholder: options.placeholder || 'Write the description...',
    entityLabel: options.entityLabel || 'entity',
  };

  const list = el('div', { class: 'descriptions-list' });

  const countBadge = el('span', { class: 'descriptions-panel__count' }, '0');

  function liveDescriptions() {
    return workingDescriptions.filter(d => !d._deleted);
  }

  function rebuildList() {
    list.innerHTML = '';
    const live = liveDescriptions().sort((a, b) =>
      new Date(b.description_date || b.created_at || 0) -
      new Date(a.description_date || a.created_at || 0)
    );
    countBadge.textContent = String(live.length);

    if (live.length === 0) {
      list.appendChild(
        el('div', { class: 'empty-state', style: { padding: 'var(--space-6) var(--space-2)' } },
          el('div', { class: 'empty-state__title' }, 'No descriptions yet'),
          el('div', { class: 'empty-state__description' }, `Click "Add Description" to capture details for this ${opts.entityLabel}.`)
        )
      );
      return;
    }

    live.forEach(desc => {
      list.appendChild(descriptionCard(desc, rebuildList, opts));
    });
  }

  const addBtn = el('button', {
    class: 'btn btn--primary btn--sm',
    onClick: () => {
      const newDesc = {
        _tempId: `tmp_${uuid('dsc')}`,
        _isNew: true,
        _startInEdit: true,
        description_date: todayISO(),
        description_text: '',
        created_at: nowISO(),
      };
      workingDescriptions.push(newDesc);
      rebuildList();
      requestAnimationFrame(() => {
        const card = list.querySelector(`[data-desc-key="${getDescriptionKey(newDesc)}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },
  },
    el('span', { html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
    'Add Description'
  );

  const panel = el('div', { class: 'descriptions-panel' },
    el('div', { class: 'descriptions-panel__header' },
      el('div', { class: 'descriptions-panel__title-group' },
        el('h3', { class: 'descriptions-panel__title' }, 'Descriptions'),
        countBadge,
      ),
      el('div', { class: 'descriptions-panel__actions' }, addBtn),
    ),
    list,
  );

  rebuildList();
  return { panel, refresh: rebuildList };
}
