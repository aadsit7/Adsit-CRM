// ============================================
// Text-to-Speech — Web Speech API (instant, local)
// ============================================
// Uses the browser's built-in speechSynthesis. No network
// round-trip, no API key — speech starts immediately.
// Provides speaker buttons on assistant messages, an
// auto-speak mode, a simple settings popover, and a
// generic speak() helper used by Randy and the voice widget.

import { getRuntimeConfig, setRuntimeConfig } from '../config.js';

// ── State ─────────────────────────────────────────────────────────
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let currentUtterance = null;
let currentBtn = null;

// ── SVG Icons ─────────────────────────────────────────────────────
const SPEAKER_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;

const STOP_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`;

// ── Public API ────────────────────────────────────────────────────

export function isTTSEnabled() {
  return getRuntimeConfig('TTS_ENABLED') === true || getRuntimeConfig('TTS_ENABLED') === 'true';
}

export function isAutoSpeakEnabled() {
  return getRuntimeConfig('TTS_AUTO_SPEAK') === true || getRuntimeConfig('TTS_AUTO_SPEAK') === 'true';
}

function isSupported() {
  return !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
}

function getPreferredVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  const preferred = ['Google US English', 'Microsoft Zira', 'Samantha', 'Alex'];
  for (const name of preferred) {
    const match = voices.find(v => v.name.includes(name));
    if (match) return match;
  }
  return voices.find(v => v.lang.startsWith('en')) || voices[0] || null;
}

/**
 * Speak text using the browser's Web Speech API.
 * Returns a handle with stop(), or null if TTS is unsupported.
 *
 * @param {string} rawText - Text to speak (markdown/actions are stripped)
 * @param {Object} [callbacks]
 * @param {Function} [callbacks.onStart]
 * @param {Function} [callbacks.onEnd]
 * @param {Function} [callbacks.onError]
 * @returns {{ stop: Function } | null}
 */
export function speak(rawText, { onStart, onEnd, onError } = {}) {
  if (!isSupported()) return null;

  const text = cleanTextForSpeech(rawText);
  if (!text) {
    if (onEnd) setTimeout(onEnd, 0);
    return { stop() {} };
  }

  if (synth.speaking) synth.cancel();

  let stopped = false;
  const utt = new SpeechSynthesisUtterance(text);
  const voice = getPreferredVoice();
  if (voice) utt.voice = voice;
  utt.rate = 1.05;
  utt.pitch = 1;

  utt.onstart = () => { if (onStart && !stopped) onStart(); };
  utt.onend = () => { if (onEnd && !stopped) onEnd(); };
  utt.onerror = (e) => {
    if (stopped) return;
    if (e.error === 'canceled' || e.error === 'interrupted') return;
    if (onError) onError(new Error(e.error || 'speech error'));
  };

  synth.speak(utt);
  currentUtterance = utt;

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (currentUtterance === utt) currentUtterance = null;
      if (synth.speaking) synth.cancel();
    },
  };
}

/**
 * Attach a speaker button to an assistant chat bubble.
 * Call this after rendering each assistant message.
 */
export function attachSpeakerButton(bubble, text) {
  if (!bubble || !text || !isSupported()) return;

  const btn = document.createElement('button');
  btn.className = 'tts-speak-btn';
  btn.innerHTML = SPEAKER_ICON;
  btn.title = 'Read aloud';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleSpeakClick(btn, text);
  });
  bubble.style.position = 'relative';
  bubble.appendChild(btn);
  return btn;
}

/**
 * Auto-speak a message if auto-speak is enabled and TTS is on.
 */
export function autoSpeak(bubble, text) {
  if (!isTTSEnabled() || !isAutoSpeakEnabled()) return;
  if (!isSupported()) return;

  const btn = bubble.querySelector('.tts-speak-btn');
  if (btn) handleSpeakClick(btn, text);
}

/**
 * Stop any currently playing TTS audio (button-based or speak()-based).
 */
export function stopTTS() {
  if (synth && synth.speaking) synth.cancel();
  currentUtterance = null;
  if (currentBtn) {
    currentBtn.innerHTML = SPEAKER_ICON;
    currentBtn.classList.remove('tts-active');
    currentBtn.title = 'Read aloud';
    currentBtn = null;
  }
}

/**
 * Render the TTS settings popover HTML and wire up events.
 * Returns the gear button element to insert into the DOM.
 */
export function createSettingsButton() {
  const wrapper = document.createElement('div');
  wrapper.className = 'tts-settings-wrapper';

  const gearBtn = document.createElement('button');
  gearBtn.className = 'tts-gear-btn';
  gearBtn.title = 'TTS Settings';
  gearBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

  const popover = document.createElement('div');
  popover.className = 'tts-popover';
  popover.innerHTML = `
    <div class="tts-popover__title">Text-to-Speech</div>
    <label class="tts-popover__row">
      <span>Enable TTS</span>
      <input type="checkbox" id="tts-toggle" ${isTTSEnabled() ? 'checked' : ''}>
    </label>
    <label class="tts-popover__row">
      <span>Auto-speak replies</span>
      <input type="checkbox" id="tts-auto-speak" ${isAutoSpeakEnabled() ? 'checked' : ''}>
    </label>
  `;

  wrapper.appendChild(gearBtn);
  wrapper.appendChild(popover);

  gearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.classList.toggle('tts-popover--open');
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      popover.classList.remove('tts-popover--open');
    }
  });

  popover.querySelector('#tts-toggle').addEventListener('change', (e) => {
    setRuntimeConfig('TTS_ENABLED', e.target.checked);
  });
  popover.querySelector('#tts-auto-speak').addEventListener('change', (e) => {
    setRuntimeConfig('TTS_AUTO_SPEAK', e.target.checked);
  });

  return wrapper;
}

// ── Text Cleaning ─────────────────────────────────────────────────

export function cleanTextForSpeech(text) {
  if (!text) return '';
  return text
    .replace(/:::ACTION[\s\S]*?:::/g, '')
    .replace(/:::NAV[\s\S]*?:::/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,4}\s+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^[-•*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Extract voice text from a raw response string (markdown or legacy HTML).
 * @param {string} text
 * @returns {string|null}
 */
export function extractVoiceTextFromString(text) {
  const htmlMatch = text.match(/data-voice="true"[^>]*>([\s\S]*?)<\/div>\s*<(?:details|\/div)/);
  if (htmlMatch) {
    const temp = document.createElement('div');
    temp.innerHTML = htmlMatch[1];
    return temp.textContent.replace('Summary', '').trim();
  }
  const mdMatch = text.match(/\*\*Summary\*\*\s*\n([\s\S]*?)(?=\n---|\n###|$)/);
  if (mdMatch) {
    return mdMatch[1].replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').trim();
  }
  return null;
}

/**
 * Extract voice text from a rendered DOM element or raw string.
 * @param {string|HTMLElement} htmlOrElement
 * @returns {string|null}
 */
export function extractVoiceText(htmlOrElement) {
  if (typeof htmlOrElement === 'string') return extractVoiceTextFromString(htmlOrElement);
  if (!(htmlOrElement instanceof HTMLElement)) return null;

  const voiceEl = htmlOrElement.querySelector('[data-voice="true"]');
  if (voiceEl) return voiceEl.textContent.replace('Summary', '').trim();

  const hr = htmlOrElement.querySelector('hr');
  if (hr) {
    let text = '';
    let node = htmlOrElement.firstChild;
    while (node && node !== hr) {
      text += node.textContent || '';
      node = node.nextSibling;
    }
    return text.replace('Summary', '').trim();
  }
  return null;
}

// ── Internal ──────────────────────────────────────────────────────

function handleSpeakClick(btn, rawText) {
  // Clicking the active button = stop
  if (btn === currentBtn && synth && synth.speaking) {
    stopTTS();
    return;
  }

  stopTTS();

  const handle = speak(rawText, {
    onEnd: () => {
      if (currentBtn === btn) {
        btn.innerHTML = SPEAKER_ICON;
        btn.classList.remove('tts-active');
        btn.title = 'Read aloud';
        currentBtn = null;
      }
    },
    onError: () => {
      if (currentBtn === btn) {
        btn.innerHTML = SPEAKER_ICON;
        btn.classList.remove('tts-active');
        btn.title = 'Read aloud';
        currentBtn = null;
      }
    },
  });

  if (!handle) return;

  currentBtn = btn;
  btn.innerHTML = STOP_ICON;
  btn.classList.add('tts-active');
  btn.title = 'Stop';
}
