// ============================================
// Persistent Voice Assistant Widget
// ============================================
// Floating pill in bottom-right, activated from chat mic button.
// Mounted to #voice-root (outside view-container).

import { isAdmin } from '../auth.js';
import { loadSheetData, callClaudeStream } from '../utils/ai.js';
import { getCurrentPath } from '../router.js';

// ── State ──────────────────────────────────────────────────────────
let voiceHistory = [];
let voiceState = 'idle'; // idle | listening | processing | speaking
let stopping = false;
let recognition = null;
let synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let currentUtterance = null;
let abortController = null;
let mounted = false;

const STORAGE_KEY = 'pp_voice_active';

// ── Feature Detection ──────────────────────────────────────────────
function hasVoiceSupport() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition) && !!window.speechSynthesis;
}

// ── Markdown Stripping ─────────────────────────────────────────────
function stripMarkdown(text) {
  return text
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

// ── Speech Synthesis ───────────────────────────────────────────────
function getPreferredVoice() {
  const voices = synth.getVoices();
  const preferred = ['Google US English', 'Microsoft Zira', 'Samantha', 'Alex'];
  for (const name of preferred) {
    const match = voices.find(v => v.name.includes(name));
    if (match) return match;
  }
  return voices.find(v => v.lang.startsWith('en')) || voices[0] || null;
}

function speak(text) {
  // Stop any previous playback
  if (synth.speaking) synth.cancel();

  const clean = stripMarkdown(text);

  // Web Speech API — instant, local, no network round-trip
  currentUtterance = new SpeechSynthesisUtterance(clean);
  const voice = getPreferredVoice();
  if (voice) currentUtterance.voice = voice;
  currentUtterance.rate = 1.05;
  currentUtterance.pitch = 1;

  currentUtterance.onstart = () => setState('speaking');
  currentUtterance.onend = () => {
    if (!stopping && voiceState === 'speaking') {
      startListening();
    }
  };
  currentUtterance.onerror = (e) => {
    if (e.error !== 'canceled') console.error('Speech error:', e.error);
    if (!stopping && voiceState === 'speaking') startListening();
  };

  synth.speak(currentUtterance);
}

// ── Speech Recognition ─────────────────────────────────────────────
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    // Only process final results
    const result = event.results[event.results.length - 1];
    if (!result.isFinal) return;

    const transcript = result[0].transcript.trim();
    if (!transcript) return;

    // Immediately prevent any restarts
    setState('processing');
    handleVoiceInput(transcript);
  };

  rec.onerror = (event) => {
    if (event.error === 'no-speech') {
      // No speech detected — restart if still in voice mode
      if (!stopping && voiceState === 'listening') {
        setTimeout(() => { if (!stopping) startListening(); }, 300);
      }
      return;
    }
    if (event.error === 'aborted') return;
    console.error('Voice recognition error:', event.error);
    if (!stopping) stopEverything();
  };

  rec.onend = () => {
    // Only restart if we're still explicitly in listening state
    // Do NOT restart if processing/speaking — the cycle handles that
    if (!stopping && voiceState === 'listening') {
      setTimeout(() => {
        if (!stopping && voiceState === 'listening') {
          try { rec.start(); } catch { /* ok */ }
        }
      }, 300);
    }
  };

  return rec;
}

function startListening() {
  if (stopping) return;
  if (!recognition) recognition = initRecognition();
  if (!recognition) return;

  setState('listening');
  try {
    recognition.start();
  } catch {
    // Already started, ignore
  }
}

function stopEverything() {
  stopping = true;

  if (recognition) {
    try { recognition.abort(); } catch { /* ok */ }
  }
  if (synth.speaking) synth.cancel();
  if (abortController) abortController.abort();

  currentUtterance = null;
  voiceHistory = [];
  setState('idle');
  hideWidget();
  localStorage.removeItem(STORAGE_KEY);
  // Hand the mic back to Randy now that this widget is done
  window._randyResume?.();
}

// ── Claude API Handler ─────────────────────────────────────────────
async function handleVoiceInput(text) {
  if (stopping) return;

  renderInChatIfVisible('user', text);
  voiceHistory.push({ role: 'user', content: text });

  try {
    const sheetData = await loadSheetData();
    abortController = new AbortController();

    // Mirror Randy's early-TTS strategy: start speaking the Summary block
    // mid-stream rather than waiting for the full response, cutting
    // perceived latency by several seconds on longer responses.
    let summarySpoken = false;

    const response = await callClaudeStream(voiceHistory, sheetData, text, abortController.signal, null,
      (_chunk, accumulated) => {
        if (stopping || summarySpoken || accumulated.includes(':::ACTION')) return;
        const marker = '**Summary**';
        const start = accumulated.indexOf(marker);
        if (start === -1) return;
        const body = accumulated.slice(start + marker.length);
        const endMatch = body.match(/\n(?:---|###|\n)/);
        if (!endMatch) return;
        const summaryText = body.slice(0, endMatch.index).trim();
        if (!summaryText || !/[.!?]/.test(summaryText)) return;
        summarySpoken = true;
        if (!stopping) speak(summaryText);
      }
    );

    voiceHistory.push({ role: 'assistant', content: response });
    renderInChatIfVisible('assistant', response);

    // Fall back to speaking the full response if no Summary block was found
    if (!stopping && !summarySpoken) {
      speak(stripMarkdown(response));
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Voice assistant error:', err);
    if (!stopping) speak('Sorry, something went wrong. Please try again.');
  }
}

function renderInChatIfVisible(role, text) {
  const path = getCurrentPath();
  if (path !== '/admin/ai-assistant') return;
  const chatArea = document.getElementById('ai-chat-area');
  if (!chatArea) return;

  const welcome = chatArea.querySelector('.ai-welcome');
  if (welcome) welcome.remove();

  if (typeof window._aiChatRenderMessage === 'function') {
    window._aiChatRenderMessage(role, text, chatArea);
  }
}

// ── UI State Management ────────────────────────────────────────────
function setState(state) {
  voiceState = state;
  updateWidget();
}

function updateWidget() {
  const widget = document.getElementById('voice-widget');
  if (!widget) return;

  const pill = widget.querySelector('.voice-widget__pill');
  const label = widget.querySelector('.voice-widget__label');
  const micIcon = widget.querySelector('.voice-widget__mic');
  const speakerIcon = widget.querySelector('.voice-widget__speaker');
  const dots = widget.querySelector('.voice-widget__dots');

  widget.className = `voice-widget voice-widget--${voiceState}`;

  if (voiceState === 'idle') {
    pill.hidden = true;
  } else {
    pill.hidden = false;
    micIcon.hidden = voiceState !== 'listening';
    speakerIcon.hidden = voiceState !== 'speaking';
    dots.hidden = voiceState !== 'processing';

    const labels = { listening: 'Listening...', processing: 'Thinking...', speaking: 'Speaking...' };
    label.textContent = labels[voiceState] || '';
  }
}

function hideWidget() {
  const widget = document.getElementById('voice-widget');
  if (widget) widget.style.display = 'none';
}

function showWidget() {
  const widget = document.getElementById('voice-widget');
  if (widget) widget.style.display = '';
}

// ── Public API ─────────────────────────────────────────────────────
export function activateVoiceMode() {
  if (!hasVoiceSupport()) return;
  if (!mounted) return;

  stopping = false;
  voiceHistory = [];
  localStorage.setItem(STORAGE_KEY, 'true');
  // Yield the mic to this widget — Randy will resume when we're done,
  // and any in-progress field dictation stops so the mics don't overlap.
  window._randyPause?.();
  window._fieldDictationStop?.();
  showWidget();
  startListening();
}

export function isVoiceModeActive() {
  return voiceState !== 'idle' && !stopping;
}

export { stopEverything };

// ── Mount / Unmount ────────────────────────────────────────────────
export function mountVoiceWidget() {
  if (mounted) return;
  if (!hasVoiceSupport()) return;

  const root = document.getElementById('voice-root');
  if (!root) return;

  root.innerHTML = `
    <div id="voice-widget" class="voice-widget voice-widget--idle" style="display:none">
      <div class="voice-widget__pill" hidden>
        <div class="voice-widget__mic">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
          </svg>
        </div>
        <div class="voice-widget__speaker" hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
          </svg>
        </div>
        <div class="voice-widget__dots" hidden>
          <span></span><span></span><span></span>
        </div>
        <span class="voice-widget__label">Listening...</span>
        <div class="voice-widget__input-wrap" hidden>
          <input type="text" class="voice-widget__input" placeholder="Type a message..." maxlength="500">
        </div>
        <button class="voice-widget__edit" title="Type a message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
          </svg>
        </button>
        <button class="voice-widget__stop" title="Stop voice assistant">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
        </button>
      </div>
    </div>
  `;

  // Stop button — only this button stops everything
  root.querySelector('.voice-widget__stop').addEventListener('click', (e) => {
    e.stopPropagation();
    stopEverything();
  });

  // Edit button — toggle text input
  const editBtn = root.querySelector('.voice-widget__edit');
  const inputWrap = root.querySelector('.voice-widget__input-wrap');
  const textInput = root.querySelector('.voice-widget__input');

  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = !inputWrap.hidden;
    inputWrap.hidden = isVisible;
    if (!isVisible) {
      // Pause recognition while typing
      if (recognition && voiceState === 'listening') {
        try { recognition.abort(); } catch { /* ok */ }
      }
      textInput.focus();
    } else {
      // Resume listening if we were in voice mode
      if (!stopping && voiceState === 'listening') startListening();
    }
  });

  textInput.addEventListener('click', (e) => e.stopPropagation());

  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = textInput.value.trim();
      if (!text) return;
      textInput.value = '';
      inputWrap.hidden = true;
      setState('processing');
      handleVoiceInput(text);
    }
    if (e.key === 'Escape') {
      textInput.value = '';
      inputWrap.hidden = true;
      if (!stopping && voiceState !== 'processing' && voiceState !== 'speaking') startListening();
    }
  });

  // Load voices (some browsers load them async)
  if (synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = () => getPreferredVoice();
  }

  mounted = true;
}

export function unmountVoiceWidget() {
  stopEverything();
  const root = document.getElementById('voice-root');
  if (root) root.innerHTML = '';
  mounted = false;
}
