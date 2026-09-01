// ============================================
// Universal Field Voice Dictation (Search by Voice)
// ============================================
// Focus any text field in the portal and a small microphone button
// appears anchored to its right edge (just like the search bar mockup).
// Click the mic to start talking — your speech is transcribed straight
// into that field, firing the same `input` events typing would, so live
// search filters, validation and autosize all react exactly as normal.
// Click the mic again, or click away from the field, to stop. The user
// can always still type or edit by hand.
//
// This is deliberately CLICK-to-activate, not focus-to-activate: focusing
// a field no longer seizes the microphone (which used to fire a browser
// permission prompt on every field and fight the other mic features). The
// mic is only claimed when the user explicitly asks for it.
//
// Coordination with the other two mic consumers (only one SpeechRecognition
// can own the device mic at a time):
//   • Randy (wake-word assistant, admin-only) — paused via the global
//     window._randyPause / _randyResume hooks it installs, and kept from
//     grabbing the mic back while we dictate via window._fieldDictationActive
//     (Randy's startRecognition checks that flag).
//   • The chat voice widget (admin-only) — if a live voice conversation is
//     in progress we never start (isVoiceModeActive()); and when the widget
//     starts it calls window._fieldDictationStop to take the mic back from us.
// A single recognition instance persists while focus moves between fields;
// we just retarget which field the finalized transcript lands in.

import { isVoiceModeActive } from '../components/voice-widget.js';

// ── State ──────────────────────────────────────────────────────────
let recognition = null;
let activeField = null;     // field final transcripts are written into (while listening)
let anchorField = null;     // field the mic button is currently attached to (focused)
let listening = false;      // recognition currently running
let hideTimer = null;       // debounce for hiding the button as focus moves
let disabled = false;       // turned off for the session (mic denied / opt-out)
let indicator = null;       // floating "Listening…" pill
let micButton = null;       // the clickable mic affordance
let initialized = false;

// Generalized "sink" for the finalized transcript. The built-in field flow
// sets these to write into a plain <input>/<textarea>; external consumers
// (e.g. the rich-text Quill editors) register their own insert callback so
// they can reuse this single recognition instance instead of fighting it for
// the device mic. Only one sink is ever active at a time.
let currentInsert = null;   // fn(text) invoked for each finalized transcript
let currentAnchor = null;   // element the "Listening…" pill positions against
let currentOnStop = null;   // fn() invoked when this sink is torn down / replaced

const STORAGE_KEY = 'pp_field_dictation'; // set to 'off' to opt out

// Mic glyph — matches the assistant widgets' icon for a consistent look.
const MIC_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line x1="12" y1="19" x2="12" y2="23"></line>
    <line x1="8" y1="23" x2="16" y2="23"></line>
  </svg>`;

// ── Feature Detection ──────────────────────────────────────────────
function hasSpeechSupport() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function isOptedOut() {
  // Guarded: with storage blocked the accessor itself throws, and this runs
  // on every page load via initFieldDictation.
  try { return localStorage.getItem(STORAGE_KEY) === 'off'; } catch { return false; }
}

// ── Eligibility ────────────────────────────────────────────────────
// A "text box" is a plain text-bearing <input> or a <textarea> that the
// user can actually type into. We deliberately leave out password fields
// (privacy), numeric/date/etc. controls (dictation is unreliable there),
// the rich-text Quill editors (their own model would fight raw inserts),
// and the dedicated assistant inputs that already own a mic button.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email']);

function isEligible(node) {
  if (!node || node.nodeType !== 1) return false;
  // Never steal the mic from the assistants' own inputs / widgets.
  if (node.closest('#voice-root, #randy-root, #ai-input')) return false;
  // Explicit per-field opt-out: <input data-no-dictation>
  if (node.hasAttribute('data-no-dictation')) return false;

  if (node.tagName === 'TEXTAREA') {
    return !node.disabled && !node.readOnly;
  }
  if (node.tagName === 'INPUT') {
    const type = (node.getAttribute('type') || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(type) && !node.disabled && !node.readOnly;
  }
  return false;
}

// ── Text Insertion ─────────────────────────────────────────────────
// Insert a finalized chunk at the caret (or appended), keeping spacing
// sensible, then fire an `input` event so the app's own change handlers
// (validation, autosize, enable/disable of save buttons, live search
// filtering) all run exactly as they would for typed input.
function insertTranscript(field, raw) {
  let text = raw.trim();
  if (!text) return;

  let start, end;
  try {
    start = field.selectionStart;
    end = field.selectionEnd;
  } catch {
    start = end = null; // some input types disallow selection access
  }
  const usesCaret = start != null && end != null;
  const value = field.value || '';
  const before = usesCaret ? value.slice(0, start) : value;
  const after = usesCaret ? value.slice(end) : '';

  // Capitalize the first letter when starting an empty field / sentence.
  const trimmedBefore = before.replace(/\s+$/, '');
  const atSentenceStart = trimmedBefore === '' || /[.!?]$/.test(trimmedBefore);
  if (atSentenceStart) text = text.charAt(0).toUpperCase() + text.slice(1);

  const needsSpace = before.length > 0 && !/\s$/.test(before);
  const chunk = (needsSpace ? ' ' : '') + text;

  field.value = before + chunk + after;

  if (usesCaret) {
    const caret = before.length + chunk.length;
    try { field.setSelectionRange(caret, caret); } catch { /* ok */ }
  }

  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Mic Button (per-field affordance) ──────────────────────────────
function ensureMicButton() {
  if (micButton) return micButton;
  micButton = document.createElement('button');
  micButton.type = 'button';
  micButton.id = 'field-dictation-mic';
  micButton.className = 'field-dictation-mic';
  micButton.tabIndex = -1;                     // never a tab stop
  micButton.setAttribute('aria-label', 'Search by voice');
  micButton.title = 'Search by voice';
  micButton.innerHTML = MIC_SVG;
  // Keep focus on the field when the button is pressed — without this the
  // click would blur the input, dropping our dictation target.
  micButton.addEventListener('mousedown', (e) => e.preventDefault());
  micButton.addEventListener('click', onMicClick);
  document.body.appendChild(micButton);
  return micButton;
}

function positionMicButton() {
  if (!micButton || !anchorField) return;
  if (!anchorField.isConnected) { detach(); return; }
  const rect = anchorField.getBoundingClientRect();
  // Hide the button if its field has scrolled out of the viewport.
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    micButton.style.visibility = 'hidden';
    return;
  }
  micButton.style.visibility = '';
  const size = 30;
  const top = rect.top + (rect.height - size) / 2;
  const left = rect.right - size - 6;
  micButton.style.top = Math.round(top) + 'px';
  micButton.style.left = Math.round(left) + 'px';
}

function showMicButton(field) {
  ensureMicButton();
  anchorField = field;
  micButton.classList.add('field-dictation-mic--visible');
  setMicActive(listening && activeField === field);
  positionMicButton();
}

function hideMicButton() {
  anchorField = null;
  if (!micButton) return;
  micButton.classList.remove('field-dictation-mic--visible', 'field-dictation-mic--active');
}

function setMicActive(on) {
  if (!micButton) return;
  micButton.classList.toggle('field-dictation-mic--active', !!on);
  micButton.title = on ? 'Stop voice input' : 'Search by voice';
  micButton.setAttribute('aria-label', on ? 'Stop voice input' : 'Search by voice');
  micButton.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function onMicClick(e) {
  e.preventDefault();
  e.stopPropagation();
  if (!anchorField) return;
  if (disabled || !hasSpeechSupport() || isOptedOut()) return;
  if (listening && activeField === anchorField) {
    stopDictation();
  } else {
    startDictation(anchorField);
  }
}

// ── Floating Indicator ─────────────────────────────────────────────
function ensureIndicator() {
  if (indicator) return indicator;
  indicator = document.createElement('div');
  indicator.id = 'field-dictation-indicator';
  indicator.className = 'field-dictation-indicator';
  indicator.innerHTML = `
    <span class="field-dictation-indicator__dot"></span>
    <span class="field-dictation-indicator__label">Listening…</span>`;
  document.body.appendChild(indicator);
  return indicator;
}

function positionIndicator() {
  if (!indicator || !currentAnchor) return;
  if (!currentAnchor.isConnected) return;
  const rect = currentAnchor.getBoundingClientRect();
  const top = rect.top - 34;
  // Keep it on-screen if the field is near the top edge.
  indicator.style.top = (top < 6 ? rect.bottom + 6 : top) + 'px';
  indicator.style.left = rect.left + 'px';
}

function showIndicator(label) {
  ensureIndicator();
  const labelEl = indicator.querySelector('.field-dictation-indicator__label');
  if (labelEl) labelEl.textContent = label || 'Listening…';
  indicator.classList.add('field-dictation-indicator--visible');
  positionIndicator();
}

function hideIndicator() {
  if (indicator) indicator.classList.remove('field-dictation-indicator--visible');
}

// ── Recognition Lifecycle ──────────────────────────────────────────
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    if (!currentInsert) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;
      if (result.isFinal) {
        currentInsert(transcript);
      } else {
        interim += transcript;
      }
    }
    showIndicator(interim.trim() ? '“' + interim.trim() + '”' : 'Listening…');
  };

  rec.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      // Mic permission denied — disable for the rest of the session so we
      // don't re-prompt, and drop the mic button (it wouldn't work).
      disabled = true;
      stopDictation();
      hideMicButton();
      return;
    }
    // Other transient errors: let onend handle the restart.
  };

  rec.onend = () => {
    // Chrome ends recognition after a stretch of silence even with
    // continuous=true. Restart automatically while we're still listening.
    if (listening && currentInsert) {
      try { rec.start(); } catch { /* already starting */ }
    }
  };

  return rec;
}

// Fire (and clear) the current sink's teardown callback. Used when a new sink
// takes over, or when recognition is stopped, so any external UI (e.g. a Quill
// mic button) can reset itself.
function fireOnStop() {
  if (!currentOnStop) return;
  const cb = currentOnStop;
  currentOnStop = null;
  try { cb(); } catch { /* ok */ }
}

// Boot the shared recognition instance if it isn't already running. Returns
// true when recognition is (or is now) live, false if it can't start.
function beginRecognition() {
  if (listening) return true;
  if (!recognition) recognition = initRecognition();
  if (!recognition) return false;

  listening = true;
  window._fieldDictationActive = true;
  // Pause Randy's passive wake-word mic so we can own the device mic.
  window._randyPause?.();

  try {
    recognition.start();
  } catch {
    // start() throws if it's mid-stop; onend will restart it for us.
  }
  return true;
}

function startDictation(field) {
  if (disabled || !hasSpeechSupport() || isOptedOut()) return;
  // Never fight an in-progress voice conversation for the mic.
  if (isVoiceModeActive()) return;

  // A field takes over from any external (e.g. Quill) dictation sink.
  fireOnStop();
  activeField = field;
  currentInsert = (text) => insertTranscript(field, text);
  currentAnchor = field;

  if (!beginRecognition()) return;
  showIndicator('Listening…');
  setMicActive(true);
  positionIndicator();
}

function stopDictation() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  fireOnStop();
  activeField = null;
  currentInsert = null;
  currentAnchor = null;
  hideIndicator();
  setMicActive(false);

  if (listening) {
    listening = false;
    if (recognition) { try { recognition.stop(); } catch { /* ok */ } }
  }

  if (window._fieldDictationActive) {
    window._fieldDictationActive = false;
    // Hand the mic back to Randy if it was passively listening before.
    window._randyResume?.();
  }
}

// Stop dictation AND drop the mic button — used when focus leaves every
// eligible field, or when another feature reclaims the mic.
function detach() {
  stopDictation();
  hideMicButton();
}

// ── Focus Wiring ───────────────────────────────────────────────────
function onFocusIn(event) {
  const target = event.target;
  if (target === micButton) return;         // pressing our own button
  if (!isEligible(target)) return;
  if (disabled || !hasSpeechSupport() || isOptedOut()) return;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

  showMicButton(target);
  // If we're mid-dictation and the user tabbed to another field, keep the
  // single recognition running and just retarget onto the new field.
  if (listening) startDictation(target);
}

function onFocusOut() {
  // Defer: focus moving from one eligible field to another fires focusout
  // then focusin. The pending focusin cancels this timer, so we keep the
  // button (and any running recognition) and just retarget — no mic churn.
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    const active = document.activeElement;
    if (isEligible(active)) return; // moved to another field; focusin handles it
    // An external editor (e.g. a Quill mic) may have just claimed the mic —
    // don't tear that session down, only drop the field button.
    if (currentInsert && !activeField) { hideMicButton(); return; }
    detach();
  }, 150);
}

function reposition() {
  positionIndicator();
  positionMicButton();
}

// ── Public Init ────────────────────────────────────────────────────
export function initFieldDictation() {
  if (initialized) return;
  if (!hasSpeechSupport()) return; // graceful no-op on unsupported browsers
  initialized = true;

  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);

  // Keep the button + indicator glued to the field as the page scrolls/resizes.
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  // Let the voice widget reclaim the mic from us when it starts (it can't
  // import this module without a cycle, so it calls through the window).
  window._fieldDictationStop = detach;
}

// ── External Dictation API ─────────────────────────────────────────
// For editors that aren't plain <input>/<textarea> fields (the rich-text
// Quill editors), which manage their own DOM/selection model. They register
// an insert callback and reuse this module's single recognition instance and
// all its mic-coordination logic, so we never end up with two SpeechRecognition
// instances fighting for the device mic.

// True when voice dictation can currently be offered at all (browser support,
// not opted out, not disabled after a denied permission prompt).
export function isDictationAvailable() {
  return !disabled && hasSpeechSupport() && !isOptedOut();
}

// True while an external sink (not a plain field) is the one being dictated
// into. Lets a caller reflect the live state on its own mic button.
export function isExternalDictationActive() {
  return listening && !!currentInsert && !activeField;
}

/**
 * Start dictating into a custom target (e.g. a Quill editor).
 * @param {Object} opts
 * @param {function(string):void} opts.insert - Called with each finalized transcript chunk.
 * @param {HTMLElement} [opts.anchor] - Element the "Listening…" pill is positioned against.
 * @param {function():void} [opts.onStop] - Called when this sink is torn down or replaced.
 * @returns {boolean} true if dictation started.
 */
export function startExternalDictation({ insert, anchor = null, onStop = null } = {}) {
  if (typeof insert !== 'function') return false;
  if (disabled || !hasSpeechSupport() || isOptedOut()) return false;
  // Never fight an in-progress voice conversation for the mic.
  if (isVoiceModeActive()) return false;

  // Take over from whatever sink (field or other editor) was active.
  fireOnStop();
  hideMicButton();
  activeField = null;
  currentInsert = insert;
  currentAnchor = anchor;
  currentOnStop = onStop;

  if (!beginRecognition()) return false;
  showIndicator('Listening…');
  positionIndicator();
  return true;
}

// Stop an external dictation session (also fires its onStop callback).
export function stopExternalDictation() {
  stopDictation();
}

// Optional programmatic opt-out/opt-in (defaults to on).
export function setFieldDictationEnabled(enabled) {
  if (enabled) {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
    disabled = false;
  } else {
    try { localStorage.setItem(STORAGE_KEY, 'off'); } catch { /* storage blocked */ }
    detach();
  }
}
