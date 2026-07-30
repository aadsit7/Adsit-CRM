// ============================================
// Shared Quill Rich Text Editor
// ============================================

import { el } from '../utils/dom.js';
import {
  startExternalDictation,
  stopExternalDictation,
  isDictationAvailable,
} from '../utils/field-dictation.js';

// Mic glyph — matches the field-dictation / assistant widgets for a consistent look.
const MIC_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line x1="12" y1="19" x2="12" y2="23"></line>
    <line x1="8" y1="23" x2="16" y2="23"></line>
  </svg>`;

// ---- HTML helpers ----

export function stripHtml(html) {
  // textContent flattens markup with NO separator between adjacent blocks,
  // so "<p>…Objective</p><p>Wipro is…</p>" reads back as "ObjectiveWipro
  // is…". Every consumer of this text suffers: analyzers are shown run-on
  // words, previews glue sentences, and the verbatim evidence gates reject
  // snippets that begin at a block boundary because the snippet appears to
  // start mid-word. Materialize the visual line breaks in the markup itself
  // (a real </p> etc. can only be a tag — inside text it would be entity-
  // encoded), then let the DOM decode tags and entities as before.
  const withBreaks = String(html == null ? '' : html)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|blockquote|pre|h[1-6])\s*>/gi, '\n</$1>');
  const tmp = document.createElement('div');
  tmp.innerHTML = withBreaks;
  return tmp.textContent || tmp.innerText || '';
}

export function ensureHtml(text) {
  if (!text) return '';
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  return text.replace(/\n/g, '<br>');
}

// ---- Shared toolbar config ----

const TOOLBAR_OPTIONS = [
  ['bold', 'italic', 'underline'],
  [{ header: [1, 2, 3, false] }],
  [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
  ['link'],
  ['clean'],
];

// ---- Voice dictation wiring ----

/**
 * Insert a finalized transcript chunk into the Quill editor at the caret
 * (or appended), keeping spacing/capitalization sensible — mirrors the plain
 * field behaviour so dictation feels identical everywhere.
 */
function insertDictation(quill, raw) {
  const text = (raw || '').trim();
  if (!quill || !text) return;

  const sel = quill.getSelection();
  // getLength() counts Quill's trailing "\n"; insert just before it when
  // there's no live selection so text lands at the end of the content.
  let index = sel ? sel.index : Math.max(0, quill.getLength() - 1);

  // Replace any selected text, just like typing over a selection would.
  if (sel && sel.length) {
    quill.deleteText(index, sel.length, 'user');
  }

  const preceding = quill.getText(0, index);
  const trimmedBefore = preceding.replace(/\s+$/, '');
  const atSentenceStart = trimmedBefore === '' || /[.!?]$/.test(trimmedBefore);
  let chunk = atSentenceStart ? text.charAt(0).toUpperCase() + text.slice(1) : text;

  const needsSpace = preceding.length > 0 && !/\s$/.test(preceding);
  const out = (needsSpace ? ' ' : '') + chunk;

  quill.insertText(index, out, 'user');
  quill.setSelection(index + out.length, 0, 'user');
}

/**
 * Attach a start/stop mic button to a Quill editor container. No-op on
 * browsers without speech support or when dictation is opted out.
 * @param {HTMLElement} container - the `.quill-editor` element
 * @param {function} getQuill - returns the live Quill instance
 */
function setupDictation(container, getQuill) {
  if (!isDictationAvailable()) return;

  const micBtn = el('button', {
    class: 'quill-editor-mic-btn',
    type: 'button',
    title: 'Dictate',
    'aria-label': 'Dictate',
    'aria-pressed': 'false',
    html: MIC_SVG,
  });

  let active = false;
  function setActive(on) {
    active = on;
    micBtn.classList.toggle('quill-editor-mic-btn--active', on);
    micBtn.title = on ? 'Stop dictation' : 'Dictate';
    micBtn.setAttribute('aria-label', on ? 'Stop dictation' : 'Dictate');
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // Keep the editor's selection when the button is pressed — without this the
  // click would blur the editor and we'd lose the caret position.
  micBtn.addEventListener('mousedown', (e) => e.preventDefault());
  micBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (active) {
      stopExternalDictation();
      return;
    }
    const started = startExternalDictation({
      insert: (text) => insertDictation(getQuill(), text),
      anchor: container,
      onStop: () => setActive(false),
    });
    if (started) setActive(true);
  });

  container.appendChild(micBtn);
}

// ---- Editor factory ----

/**
 * Create a Quill rich-text editor with fullscreen support.
 *
 * Call this BEFORE opening the modal to get the wrapper element,
 * then call mount() AFTER the modal is in the DOM.
 *
 * @param {Object} opts
 * @param {string} [opts.placeholder]  - Placeholder text
 * @param {string} [opts.initialHtml]  - HTML to load into the editor
 * @param {string} [opts.title]        - Fullscreen header title
 * @param {function} [opts.onTextChange] - Called on every text-change (receives quill instance)
 * @returns {{ wrapper: HTMLElement, mount: function, getHtml: function, getText: function, isEmpty: function }}
 */
export function initQuillEditor({ placeholder = '', initialHtml = '', title = 'Edit', onTextChange } = {}) {
  const editorContainer = el('div', { class: 'quill-editor' });

  const fullscreenBtn = el('button', {
    class: 'quill-editor-expand-btn',
    type: 'button',
    title: 'Expand editor',
    html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 10v4h4M14 6V2h-4M2 6V2h4M14 10v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  });

  const wrapper = el('div', { class: 'quill-editor-wrapper' }, editorContainer, fullscreenBtn);

  let quill = null;

  function getHtml() {
    return quill ? quill.root.innerHTML.trim() : '';
  }

  function getText() {
    return quill ? quill.getText().trim() : '';
  }

  function isEmpty() {
    return !getText();
  }

  /**
   * Initialise Quill after the wrapper is in the DOM (e.g. inside a modal).
   * Must be called inside requestAnimationFrame or after a tick.
   */
  function mount() {
    requestAnimationFrame(() => {
      if (!window.Quill || !editorContainer.isConnected) return;

      quill = new Quill(editorContainer, {
        theme: 'snow',
        placeholder,
        modules: { toolbar: TOOLBAR_OPTIONS },
      });

      if (initialHtml) {
        quill.clipboard.dangerouslyPasteHTML(ensureHtml(initialHtml));
      }

      if (onTextChange) {
        quill.on('text-change', () => onTextChange(quill));
      }

      // ---- Voice dictation (voice-to-text) ----
      // A mic button anchored to the editor lets the user dictate straight
      // into the rich-text field, matching every other typeable input in the
      // portal. It reuses the shared recognition instance from field-dictation
      // so it never fights the other mic consumers for the device mic.
      setupDictation(editorContainer, () => quill);

      // ---- Fullscreen toggle ----
      let isFullscreen = false;

      const overlay = el('div', { class: 'quill-editor-fullscreen' });

      const collapseBtn = el('button', {
        class: 'quill-editor-collapse-btn',
        type: 'button',
        html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Close fullscreen',
        onClick: () => toggleFullscreen(),
      });

      const fullscreenHeader = el('div', { class: 'quill-editor-fullscreen__header' },
        el('span', { class: 'quill-editor-fullscreen__title' }, title),
        collapseBtn,
      );
      overlay.appendChild(fullscreenHeader);

      function toggleFullscreen() {
        isFullscreen = !isFullscreen;
        if (isFullscreen) {
          overlay.appendChild(editorContainer);
          document.body.appendChild(overlay);
          fullscreenBtn.style.display = 'none';
        } else {
          wrapper.insertBefore(editorContainer, fullscreenBtn);
          overlay.remove();
          fullscreenBtn.style.display = '';
        }
        quill.focus();
      }

      fullscreenBtn.addEventListener('click', toggleFullscreen);
    });
  }

  return { wrapper, mount, getHtml, getText, isEmpty };
}
