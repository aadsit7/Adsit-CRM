// ============================================
// Documents Panel — drag-drop file attachments backed by Google Drive
// ============================================
// Shared between Opportunities and Events. The panel itself is
// entity-agnostic: callers pass an `entityId` (e.g. opportunity_id or
// event_id) and a context name used by the Apps Script to organize
// uploads on the Drive side.
//
// Note on the wire format: the Apps Script endpoint reads its key from
// the JSON field `opportunityId`. We retain that field name in the
// outgoing payload for backwards compatibility (the script doesn't
// inspect prefixes — it just uses the value as a folder/key string).
// Because the key is one untyped string, records of different types can
// only stay separate if their ids differ: the app's generated ids all carry
// a type prefix (`opp_` / `evt_` / `p_` / `pct_`) and cannot collide, but
// legacy bare-integer partner/event ids do. See the note in
// js/utils/analyzer-pdf-attach.js.
// ============================================

import { el } from '../utils/dom.js';
import { formatDate } from '../utils/date.js';
import { confirmDialog } from './modal.js';
import { showToast } from './toast.js';
import { fileApiRequest } from '../utils/file-api.js';
import { createPill, markPillSuccess, markPillFailure } from './map-pdf-pill.js';

const ALLOWED_FILE_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.xlsm', '.csv', '.pptx', '.png', '.jpg', '.jpeg'];

/**
 * List documents stored in Drive for a given entity (opportunity or event).
 * Optional AbortSignal lets non-interactive callers (the partner contact
 * scan) bound the call instead of hanging on a wedged connection.
 */
export async function listEntityDocuments(entityId, { signal } = {}) {
  if (!entityId) return [];
  const data = await fileApiRequest({ action: 'listFiles', opportunityId: entityId }, { signal });
  return Array.isArray(data.files) ? data.files : [];
}

/**
 * Read a File as base64 (strips the data:<mime>;base64, prefix).
 */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function isAllowedFile(file) {
  const name = (file.name || '').toLowerCase();
  return ALLOWED_FILE_EXTENSIONS.some(ext => name.endsWith(ext));
}

function fileIconSvg() {
  return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>';
}

/**
 * Build the Documents panel.
 *
 * @param {Object} opts
 * @param {string|null} opts.entityId - Opportunity or event ID. If null/empty,
 *   the dropzone is replaced with a "save first" placeholder.
 * @param {Function} opts.getContextName - Returns a human label for the entity
 *   (customer name for opps, event title for events). Used as the Drive
 *   folder name on upload.
 * @param {Array} [opts.initialFiles] - Files already attached to the entity.
 * @param {Function} [opts.onAnalyze] - Optional callback to enable the
 *   per-row "Analyze" action. Signature: async (file, link) => void.
 *   When omitted, the Analyze link is hidden. The handler is responsible
 *   for calling fileApiRequest('analyzeDocument'), persisting any
 *   resulting description, and setting file.analyzed = 'TRUE'.
 * @param {string} [opts.savePrompt] - Message shown when entityId is empty
 *   (e.g., for new unsaved entities).
 * @param {boolean} [opts.loading] - When true, show a loading indicator
 *   inside the list area instead of the empty state. Cleared automatically
 *   on the first refresh() / addFile() call.
 * @returns {{ panel: HTMLElement, addFile: Function, refresh: Function, entityId: string|null }}
 */
export function buildDocumentsPanel({
  entityId,
  getContextName,
  initialFiles,
  onAnalyze,
  savePrompt,
  loading = false,
}) {
  const files = [...(initialFiles || [])];
  const list = el('div', { class: 'documents-list' });
  const countBadge = el('span', { class: 'descriptions-panel__count' }, '0');
  let isLoading = !!loading;

  // Sort files by date_added descending so newest appears first.
  function sortFilesByDateDesc() {
    files.sort((a, b) => {
      const at = Date.parse(a.date_added || '') || 0;
      const bt = Date.parse(b.date_added || '') || 0;
      return bt - at;
    });
  }

  function rebuildList() {
    sortFilesByDateDesc();
    list.innerHTML = '';
    countBadge.textContent = isLoading ? '…' : String(files.length);

    if (isLoading) {
      list.appendChild(
        el('div', { class: 'documents-list__loading', style: { padding: 'var(--space-5) var(--space-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)', color: 'var(--color-text-muted)' } },
          el('div', { class: 'spinner', style: { width: '16px', height: '16px', borderWidth: '2px' } }),
          el('span', {}, 'Loading documents…'),
        )
      );
      return;
    }

    if (files.length === 0) {
      list.appendChild(
        el('div', { class: 'empty-state', style: { padding: 'var(--space-5) var(--space-2)' } },
          el('div', { class: 'empty-state__title' }, 'No documents yet'),
          el('div', { class: 'empty-state__description' }, 'Drop a file below to attach it.')
        )
      );
      return;
    }

    files.forEach(f => list.appendChild(documentRow(f)));
  }

  function isAnalyzed(file) {
    return String(file.analyzed || '').toUpperCase() === 'TRUE';
  }

  function documentRow(file) {
    const removeLink = el('a', {
      href: '#',
      class: 'document-row__remove',
      onClick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const confirmed = await confirmDialog(
          'Remove Document',
          `Are you sure you want to remove "${file.file_name || 'this file'}"? This cannot be undone.`,
        );
        if (!confirmed) return;
        try {
          await fileApiRequest({ action: 'deleteFile', docId: file.doc_id });
          const idx = files.findIndex(f => f.doc_id === file.doc_id);
          if (idx >= 0) files.splice(idx, 1);
          rebuildList();
          showToast('File removed', 'success');
        } catch (err) {
          showToast(err.message || 'Failed to remove file', 'error');
        }
      },
    }, 'Remove');

    const nameLink = el('a', {
      href: file.drive_url || '#',
      target: '_blank',
      rel: 'noopener',
      class: 'document-row__name',
    }, file.file_name || 'Untitled');

    let analyzeEl = null;
    if (typeof onAnalyze === 'function') {
      analyzeEl = isAnalyzed(file)
        ? el('span', { class: 'document-row__analyzed', title: 'Already analyzed' }, '✓ Analyzed')
        : buildAnalyzeLink(file);
    }

    return el('div', { class: 'document-row' },
      el('span', { class: 'document-row__icon', html: fileIconSvg() }),
      nameLink,
      el('span', { class: 'document-row__date' }, file.date_added ? formatDate(file.date_added) : ''),
      analyzeEl,
      removeLink,
    );
  }

  function buildAnalyzeLink(file) {
    const link = el('a', {
      href: '#',
      class: 'document-row__analyze',
    }, 'Analyze');
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (link.classList.contains('document-row__analyze--loading')) return;
      link.classList.add('document-row__analyze--loading');
      link.textContent = 'Analyzing...';
      // The floating Randy pill carries progress in the global body-fixed
      // stack, so the user can close this modal (or leave the page entirely)
      // and still watch the document analysis run to completion.
      const pill = createPill('Analyzing document…', { label: file.file_name || 'Document' });
      try {
        await onAnalyze(file, link);
        markPillSuccess(pill, 'Analyzed');
        rebuildList();
      } catch (err) {
        markPillFailure(pill, 'Analyze failed');
        if (link.isConnected) {
          link.classList.remove('document-row__analyze--loading');
          link.textContent = 'Analyze';
        }
        showToast(err.message || 'Failed to analyze document', 'error');
      }
    });
    return link;
  }

  // Drop zone
  const dropzoneLabel = el('span', { class: 'document-dropzone__label' },
    'Drag files here or click to browse'
  );
  const dropzoneHint = el('span', { class: 'document-dropzone__hint' },
    'PDF, Word, Excel, CSV, PowerPoint, or images'
  );

  const fileInput = el('input', {
    type: 'file',
    multiple: true,
    accept: ALLOWED_FILE_EXTENSIONS.join(','),
    style: { display: 'none' },
    onChange: (e) => {
      const selected = Array.from(e.target.files || []);
      if (selected.length) uploadFiles(selected);
      e.target.value = '';
    },
  });

  const dropzone = el('div', {
    class: 'document-dropzone',
    onClick: () => fileInput.click(),
  }, dropzoneLabel, dropzoneHint, fileInput);

  function setDropzoneMessage(message) {
    dropzoneLabel.textContent = message;
    dropzoneHint.style.display = 'none';
  }
  function resetDropzone() {
    dropzoneLabel.textContent = 'Drag files here or click to browse';
    dropzoneHint.style.display = '';
  }

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('document-dropzone--dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('document-dropzone--dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('document-dropzone--dragover');
    const dropped = Array.from(e.dataTransfer?.files || []);
    if (dropped.length) uploadFiles(dropped);
  });

  async function uploadFiles(selected) {
    const contextName = ((getContextName && getContextName()) || '').trim();
    if (!contextName) {
      showToast('Set a name before uploading files', 'error');
      return;
    }

    for (const file of selected) {
      if (!isAllowedFile(file)) {
        showToast(`Unsupported file type: ${file.name}`, 'error');
        continue;
      }

      setDropzoneMessage(`Uploading ${file.name}...`);
      try {
        const fileData = await readFileAsBase64(file);
        // The Apps Script endpoint reads the entity key as `opportunityId`
        // and the folder name as `customerName`. We pass the appropriate
        // values regardless of which entity type we're working with.
        const data = await fileApiRequest({
          action: 'uploadFile',
          opportunityId: entityId,
          customerName: contextName,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileData,
        });
        const newFile = data.file || {
          doc_id: data.doc_id,
          file_name: data.file_name || file.name,
          drive_url: data.drive_url,
          date_added: data.date_added || new Date().toISOString(),
        };
        files.unshift(newFile);
        rebuildList();
        showToast('File uploaded', 'success');
      } catch (err) {
        showToast(err.message || `Failed to upload ${file.name}`, 'error');
      } finally {
        resetDropzone();
      }
    }
  }

  const panel = el('div', { class: 'descriptions-panel documents-panel' },
    el('div', { class: 'descriptions-panel__header' },
      el('div', { class: 'descriptions-panel__title-group' },
        el('h3', { class: 'descriptions-panel__title' }, 'Documents'),
        countBadge,
      ),
    ),
    list,
  );

  if (entityId) {
    panel.appendChild(dropzone);
  } else {
    panel.appendChild(
      el('div', { class: 'document-dropzone document-dropzone--disabled' },
        el('span', { class: 'document-dropzone__label' },
          savePrompt || 'Save this record first to attach documents'
        )
      )
    );
  }

  rebuildList();

  // External handle: addFile injects a freshly uploaded file into the
  // visible list (used by Randy's MAP PDF flow); refresh reloads from server.
  function addFile(file) {
    if (!file) return;
    isLoading = false;
    files.unshift(file);
    rebuildList();
    const firstRow = list.querySelector('.document-row');
    if (firstRow) {
      firstRow.classList.add('document-row--just-added');
      setTimeout(() => firstRow.classList.remove('document-row--just-added'), 1500);
    }
  }
  async function refresh() {
    if (!entityId) {
      isLoading = false;
      rebuildList();
      return;
    }
    try {
      const fresh = await listEntityDocuments(entityId);
      files.splice(0, files.length, ...fresh);
    } catch (err) {
      console.warn('documents panel refresh failed', err);
    } finally {
      isLoading = false;
      rebuildList();
    }
  }

  return { panel, addFile, refresh, entityId };
}
