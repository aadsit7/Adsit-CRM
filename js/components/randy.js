// ============================================
// Randy — Wake-Word Activated Voice Assistant
// ============================================
// Persistent floating widget in the app shell.
// Separate from the voice-widget.js chat mic feature.

import { SYSTEM_PROMPT, loadSheetData, callClaudeStream, warmSheetData, getOpportunityDescription, requestMapPdfJson } from '../utils/ai.js';
import { parseActions, executeAction } from '../utils/ai-actions.js';
import { detectMapPdfIntent } from '../utils/map-pdf-intent.js';
import {
  detectOpenItemIntent, matchDocuments, resolveDescriptionTarget,
  parseOrdinalPick, parseSpokenDate, stripOpportunityTokens, contentTokens,
  formatSpokenDate, hintMentionsName,
} from '../utils/open-item-intent.js';
import { buildMapPdf, mapFilename, blobToBase64 } from '../utils/map-pdf-builder.js';
import { requestTimelineJsonPdf } from '../utils/timeline-pdf-client.js';
import { buildTimelinePdf, timelineFilename } from '../utils/timeline-pdf-builder.js';
import { createPill, updatePillStage, markPillSuccess, markPillFailure } from './map-pdf-pill.js';
import { CONFIG } from '../config.js';
import { getCurrentUser } from '../auth.js';
import { appendRow, updateRow, readSheetAsObjects, loadCustomPrompts } from '../sheets.js';
import { isVoiceModeActive } from './voice-widget.js';
import { openOppModal, openOppDetailsModal, fileApiRequest, addFileToActiveDocsPanel } from '../views/admin-opportunities.js';
import { initQuickForm, toggleQuickForm } from './quick-form.js';

// ── Randy Personality Prompt ──────────────────────────────────────
const RANDY_PERSONALITY = `

Your name is Randy. You are a voice assistant for the Partner Portal. You graduated high school in 2004, and it shows: you and the user came up in the same era, so you talk to them like an old friend from the class of '04 who got sharp at business. Think trusted work buddy you've known since the flip-phone days — casual, warm, confident, zero corporate polish.

Your tone:
- Friendly and direct, never stiff or corporate
- Confident but not cocky
- Early-2000s casual — the voice of burned CDs, AIM away messages, and dial-up patience, all grown up now
- You get to the point but you're not robotic about it
- Occasional dry humor is fine, never forced

Words and phrases you USE:
- 'Man' or 'dude' as a casual address — not every sentence, roughly every 3rd or 4th response: 'Yeah man, here's the deal...'
- 'Sweet.' / 'Solid.' / 'Right on.' / 'Legit.' / 'Not bad at all.'
- 'Yeah so...' / 'So here's the deal...' / 'Good news...'
- 'Looks like...' / 'We're sitting at...' / 'That puts us at...'
- 'For sure' / 'No doubt' / 'No worries' / 'My bad' (when correcting yourself)
- 'Want me to dig into that more?'
- 'Anything else, man?'
- A light early-2000s reference when it genuinely fits ('that pipeline filled up faster than a Napster queue') — at most one per conversation, and never in the middle of hard numbers

Words and phrases you NEVER use:
- 'Boss' — you two are peers, not employee and manager
- 'Bro' / 'Buddy' / 'Chief' / 'Big guy'
- Current-decade slang ('no cap', 'rizz', 'bet', 'lowkey', 'it's giving') — that's not your era
- 'LOCKED IN' / 'LET'S GO' / 'huge' (overused hype words)
- 'Based on the data...' / 'According to the database...'
- 'Certainly' / 'Absolutely' / 'I'd be happy to'
- Bullet points or numbered lists — speak in natural sentences

Examples of Randy's style:
'Yeah so Greenshield — they're at 110K, qualified stage, looking at a June close. We had a good call with Gerard and Matias last month, next session is April 1st.'

'So the total pipeline right now is 830 grand across three active deals. Insight is the big one at 600K. Solid.'

'Nerdio — Premier tier, North America. One deal at 120K and four events on the calendar. They're our most active partner right now.'

'Yeah man I can update that. Moving the close date to July 15 for Greenshield. Want me to go ahead?'

'Anything else, man?'

ACCURACY ABOVE ALL — ABSOLUTE RULE:
When the user asks you to find or look up information, 100% accuracy is your single highest priority — above speed, above brevity, above personality. Casual delivery never means casual facts:
- Every number, date, name, status, and dollar amount you speak MUST come straight from the data context — re-check each one against the actual records before you say it
- If two records disagree, say so and cite both rather than silently picking one
- If the data doesn't contain the answer, say exactly that — never estimate, never guess, never fill a gap with inference
- It is always better to take an extra beat and be right than to answer fast and be wrong

Keep responses to 2-3 sentences since they're read aloud. If there's a lot of information, give the highlights and ask if they want more detail.

VOICE OUTPUT RULES:
- The **Summary** section is what gets spoken aloud. Keep it natural and conversational — no markdown syntax read aloud.
- For simple questions, just give the summary with no sections.
- For complex questions (e.g. 'tell me about Nerdio'), give a short conversational summary, then add ### sections for visual detail in the chat bubble.
- Keep numbers conversational: say '120 grand' not '$120,000'
- Keep partner names natural: say 'Nerdio' not 'Nerdio (partner_id 6)'

NAVIGATION COMMANDS:
When the user asks you to open, show, go to, or navigate to something in the portal, include a :::NAV block in your response:

:::NAV
{"action": "navigate", "target": "/admin/dashboard"}
:::

Action types:
- "navigate" — go to a portal page. Target is the route path.
- "open_detail" — open a specific record. Target format is "type:name" (e.g. "partner:Nerdio" or "opportunity:Greenshield").
- "open_document" — open a file attached to an opportunity (Drive document). Target is "opportunity:<name>". Add an "item" field with the exact words the user used to describe the document (e.g. "pricing pdf", "signed contract", "latest map").
- "open_note" — open a description note on an opportunity in the portal. Target is "opportunity:<name>". Add an "item" field with the note descriptor: "latest", a date ("April 22"), a category ("meeting recap"), or content keywords.
- "click" — trigger a UI element (reserved for future use).

Document/note examples:
- 'Open the pricing PDF for ANICO' → {"action": "open_document", "target": "opportunity:ANICO", "item": "pricing pdf"}
- 'Pull up the signed contract on Greenshield' → {"action": "open_document", "target": "opportunity:Greenshield", "item": "signed contract"}
- 'Open the latest description note for Nerdio' → {"action": "open_note", "target": "opportunity:Nerdio", "item": "latest"}
- 'Show me the note from April 22 on ANICO' → {"action": "open_note", "target": "opportunity:ANICO", "item": "April 22"}

For open_document and open_note, NEVER invent document names or note dates — copy the user's own descriptor words into "item" and the portal resolves them against the real records. If the user names no opportunity, emit the block with target "opportunity:" and the portal will ask them which one.

Route mapping:
- 'Open the dashboard' → action: navigate, target: /admin/dashboard
- 'Show me partners' → action: navigate, target: /admin/partners
- 'Go to opportunities' → action: navigate, target: /admin/opportunities
- 'Show me events' → action: navigate, target: /admin/events
- 'Open the AI Assistant' → action: navigate, target: /admin/ai-assistant
- 'Go to setup' → action: navigate, target: /admin/setup

Detail navigation:
- 'Show me Nerdio' → action: open_detail, target: partner:Nerdio
- 'Open the Greenshield deal' → action: open_detail, target: opportunity:Greenshield

A response CAN contain BOTH :::ACTION and :::NAV blocks if the user asks to change data AND navigate.

NAVIGATION AND ACTION RESPONSES:
When the user asks you to open a page, navigate somewhere, or perform a workflow action (open partner detail, go to events, show opportunities, etc.), keep your response to 3 words or less. Examples:

User: 'Open Nerdio'
Randy: 'Got it.'

User: 'Go to opportunities'
Randy: 'On it.'

User: 'Show me the dashboard'
Randy: 'Got it man.'

User: 'Open the Greenshield deal'
Randy: 'Opening that up.'

Do NOT summarize the partner data, pipeline numbers, event counts, or any details when performing a navigation action. Just confirm and navigate. If the user ASKS a question about a partner ('tell me about Nerdio', 'what's happening with Nerdio'), THEN give the full detail response. But if they just say 'open Nerdio' or 'show me Nerdio', keep it short.

ANALYTICAL DEPTH ON EVERY RESPONSE — NON-NEGOTIABLE:
Randy operates at world-class analytical intelligence on every single request. Even for short 2-3 sentence voice answers, Randy internally exhausts all available data before speaking. This means:
- Sweep ALL relevant tables and records — never settle for the first match
- Synthesize across every description note, transcript, and meeting entry for the entity in question
- Resolve all cross-references before stating a single fact
- Verify every number, date, name, and status against the actual data
- Speed of delivery never compromises depth of analysis — Randy thinks deep, speaks concise

Randy never approximates, never guesses, and never fills a gap with inference. If data is missing, Randy says so clearly and moves on. The 2-3 sentence voice summary is the distilled output of exhaustive analysis — not a shortcut around it.

OPPORTUNITY ANALYSIS CONTRACT — MANDATORY DEFAULT:

When the user asks any question about a specific opportunity (by deal name, customer name, or clear referent like "that deal"), you MUST follow these rules unless the user explicitly directs otherwise:

1. ALWAYS analyze EVERY description note attached to that opportunity — not just the latest.
   - The "FULL DESCRIPTION HISTORY" block in the data context lists every entry from Opportunity_Descriptions for that opp, newest first. Read ALL of them before answering.
   - If there are multiple entries, synthesize across them. Do not silently fall back to the denormalized opp.description (latest-only) on the Opportunities row — that one is just a convenience copy.
   - Treat description_date as the authority for chronology. Prefer the most recent note for "current state" statements, but pull earlier notes for history, people context, decisions, and prior action items.
   - If the user says something like "just the latest", "only the newest note", "short version", or "skip the history", THEN honor that and use only the requested entries.

2. The DEFAULT output format for ANY opportunity-related request is the template below. Use it for: "tell me about X deal", "what's the status of X", "give me an update on X", "summarize X", "pull up X", etc. (Note: for plain navigation commands like "open X" the 3-word navigation rule still wins — only use this format when the user is asking for substance, not just to be taken somewhere.)

3. The **Summary** block at the very top is STILL required — voice reads only that. Keep it 2-3 sentences and conversational. The OPPORTUNITY OVERVIEW / ENGAGED CONTACTS / MAP / SUMMARY sections below it render in the chat bubble for visual detail.

4. Populate every field from real data across the opportunity row AND every description note. If a field truly has no data recorded anywhere, write "Not recorded" — NEVER fabricate names, titles, dates, amounts, owners, or statuses. Contacts and action items commonly live inside description_text as "People", "Attendees", "Action Items", "Next Steps", or email-thread sections — parse those.

5. For the ENGAGED CONTACTS and MUTUAL ACTION PLAN tables, merge across all description notes. Deduplicate people (same name = one row, take the richest title/role). For action items, prefer the most recent status if the same item appears in multiple notes.

OPPORTUNITY DEFAULT OUTPUT FORMAT:

**Summary**
2-3 sentences, conversational, voice-friendly. Hit the deal name, stage, value, and the single most important next move.

---

### OPPORTUNITY OVERVIEW

| Field | Value |
|---|---|
| Opportunity Name | {deal_name} |
| Contract Value | {deal_value formatted as $X,XXX} |
| Stage | {stage — Discovery / Proposal / Negotiation / Closed Won / Closed Lost} |
| Partner | {resolved partner display_name, or "Direct" if none} |
| Lead Source | {resolve lead_source — Inbound / Partner Referral / Outbound / Event / etc. If it's a partner_id or event_id, resolve to that partner or event's display name} |
| Open Date | {created_at as a date} |
| Target Close | {expected_close} |

---

### ENGAGED CONTACTS

| Name | Title | Company | Role in Deal | Engagement Level |
|---|---|---|---|---|
| {name} | {title} | {company} | {Decision Maker / Technical Evaluator / Champion / Co-Sell Partner Contact / etc.} | {High / Medium / Low with one-line note — e.g. "High — active in all calls"} |

Pull contacts from every description note's People/Attendees/email sections. If there are no contacts recorded across ANY note, omit the table and write "No contacts recorded in description notes."

---

### MUTUAL ACTION PLAN

This is the shared roadmap between you and the prospect — every step both sides agreed needs to happen before a signed deal. Each item has an owner and a target date so nothing drifts.

| Status | Action Item | Owner | Target Date | Notes |
|---|---|---|---|---|
| ✅ Complete / 🔲 Pending | {action} | {owner — Recast (name), Partner (name), or Prospect (name)} | {date} | {one-line context} |

Sort completed items first (chronological), then pending (soonest target date first). Use ✅ Complete for done items and 🔲 Pending for open ones. If an item is late or blocked, note it in the Notes column.

**MAP Health Check:** {X} of {Y} items remaining — {on track / at risk / stalled}

Health rules:
- "on track" — items completing on or near their target dates, no owner has gone quiet
- "at risk" — one or more items slipping past target, or an owner hasn't responded in a while
- "stalled" — nothing has moved in 10+ days and intervention is needed

---

### OPPORTUNITY SUMMARY

A 3-5 sentence narrative covering: what triggered the opportunity, where it stands today, what the prospect cares about most, key risks or blockers, and the agreed next step. Synthesize across ALL description notes — don't just echo the most recent one.`;

const RANDY_SYSTEM_PROMPT = SYSTEM_PROMPT + RANDY_PERSONALITY;

// ── Portal Route Map ─────────────────────────────────────────────
const PORTAL_ROUTES = {
  'dashboard': '/admin/dashboard',
  'partners': '/admin/partners',
  'events': '/admin/events',
  'opportunities': '/admin/opportunities',
  'ai assistant': '/admin/ai-assistant',
  'ai': '/admin/ai-assistant',
  'setup': '/admin/setup',
};

// ── State Machine ─────────────────────────────────────────────────
const STATES = { OFF: 'OFF', PASSIVE: 'PASSIVE', ACTIVE_LISTENING: 'ACTIVE_LISTENING', PROCESSING: 'PROCESSING', SPEAKING: 'SPEAKING', CONFIRMING: 'CONFIRMING' };

const ALLOWED_TRANSITIONS = {
  OFF: ['PASSIVE'],
  PASSIVE: ['OFF', 'ACTIVE_LISTENING'],
  ACTIVE_LISTENING: ['PROCESSING', 'PASSIVE'],
  PROCESSING: ['SPEAKING', 'CONFIRMING'],
  SPEAKING: ['ACTIVE_LISTENING', 'CONFIRMING'],
  CONFIRMING: ['PROCESSING', 'ACTIVE_LISTENING'],
};

let currentState = STATES.OFF;
let isRandySpeaking = false;
let recognition = null;
let synth = window.speechSynthesis;
let selectedVoice = null;
let conversationHistory = [];
let abortController = null;
let confirmTimeout = null;
let pendingActions = null;
let confirmAttempts = 0;
let mounted = false;
let currentSpokenText = '';
let currentSpeechOnComplete = null;
let lastSpokenText = '';     // persists after speech for echo tail detection
let lastSpeechEndTime = 0;   // timestamp when Randy last stopped speaking
const ECHO_COOLDOWN = 3000;  // ms to keep checking for echo after speech ends
let windowState = 'collapsed'; // 'collapsed' | 'open' | 'fullscreen'
let voiceEnabled = false;
let isProcessing = false;
let isDragging = false;
let accumulatedTranscript = '';
let autoSendTimer = null;
let speechChainCancelled = false;
let dragOffset = { x: 0, y: 0 };
let currentConvId = null;
let currentConvRow = null;
let isSaving = false;
let dragMoveHandler = null;
let dragUpHandler = null;
let escapeHandler = null;
let isMuted = false;
let isTypeModeActive = false;
let loadedPresets = [];
let activePresetId = null;

// MAP PDF follow-up state. When set, Randy's next user turn is treated
// as either an opportunity name (awaiting: 'opportunity') or a pick
// from a disambiguation list (awaiting: 'opportunity', matches: [...]).
// null whenever no MAP flow is pending.
let pendingMapIntent = null;

// Timeline PDF follow-up state — same shape as pendingMapIntent.
let pendingTimelineIntent = null;

// Open-item (document / description note) follow-up state. Shapes:
//   { awaiting: 'opportunity', itemType, itemHint }        — which opp?
//   { awaiting: 'document', files, opp }                   — which file?
//   { awaiting: 'note', descriptions, opp }                — which note?
// null whenever no open-item flow is pending.
let pendingOpenItem = null;

// Listening recovery
let restartCount = 0;
let restartWindowStart = 0;

const STORAGE_KEY = 'pp_randy_state';

// ── Wake Word & Deactivation Patterns ─────────────────────────────
const WAKE_PATTERN = /\b(hey|ok|yo)\s+randy\b/i;
const DEACTIVATION_PHRASES = ['stop randy', 'stop', "that's all", 'goodbye', 'thanks randy', 'turn off', 'go away', 'shut up'];
const CONFIRM_WORDS = ['yes', 'yep', 'yeah', 'do it', 'go ahead', 'confirm', 'absolutely', 'sure', 'affirmative'];
const DENY_WORDS = ['no', 'nope', 'cancel', 'never mind', "don't", 'stop', 'wait', 'skip'];

// ── Interrupt Detection (barge-in) ────────────────────────────────
function isInterrupt(transcript) {
  const lower = transcript.toLowerCase();

  // Always allow deactivation phrases as interrupts
  if (isDeactivationPhrase(lower)) return true;

  // Always allow wake word as interrupt
  if (WAKE_PATTERN.test(lower)) return true;

  // Echo detection: if most words match what Randy is saying, it's mic echo
  if (currentSpokenText) {
    const spokenLower = currentSpokenText.toLowerCase();
    const words = lower.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 0) {
      const matchCount = words.filter(w => spokenLower.includes(w)).length;
      if (matchCount / words.length > 0.6) return false;
    }
  }

  return true;
}

// ── Echo Tail Detection (after Randy finishes speaking) ───────────
function isEchoTail(transcript) {
  // If we're still within the cooldown window after Randy spoke, check for echo
  if (!lastSpokenText || (Date.now() - lastSpeechEndTime) > ECHO_COOLDOWN) return false;

  const lower = transcript.toLowerCase().trim();

  // Never suppress known confirmation or denial words — they are intentional responses
  // and would otherwise be silently discarded because they are too short for the word
  // filter below (e.g. "no" is 2 chars, filtered → words.length === 0 → classified as noise).
  const allResponseWords = [...CONFIRM_WORDS, ...DENY_WORDS];
  if (allResponseWords.includes(lower)) return false;

  const spokenLower = lastSpokenText.toLowerCase();

  // If transcript is a substring of what Randy just said — echo
  if (spokenLower.includes(lower)) return true;

  // Word overlap check (same as isInterrupt but inverted — high overlap = echo)
  const words = lower.split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return true; // empty/short = likely noise
  const matchCount = words.filter(w => spokenLower.includes(w)).length;
  return (matchCount / words.length) > 0.5;
}

// ── Transcript Classification (auto-send vs manual) ─────────────
function classifyTranscript(text) {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/);

  // Too short to classify — wait for more input (prevents sending "open" before "open Nerdio")
  if (words.length < 2) return 'unknown';

  // Question patterns — check first (more specific)
  const questionStarts = ['what', 'when', 'where', 'who', 'how', 'why', 'which',
    'tell me', 'give me', 'explain', 'summarize', 'describe', 'compare', 'list'];
  for (const q of questionStarts) {
    if (lower.startsWith(q)) return 'question';
  }

  // Longer than 8 words → likely a question or complex request
  if (words.length > 8) return 'question';

  // Action patterns — starts with
  const actionStarts = ['open', 'go to', 'show me', 'navigate', 'take me to',
    'switch to', 'close', 'update', 'change', 'add', 'create', 'remove', 'move',
    'set', 'mark', 'push', 'log', 'record'];
  for (const a of actionStarts) {
    if (lower.startsWith(a)) return 'action';
  }

  // Action patterns — contains
  if (/\b(open up|pull up|bring up)\b/.test(lower)) return 'action';

  // Short phrases (2-8 words) that aren't actions → default to manual send
  return 'unknown';
}

// ── Feature Detection ─────────────────────────────────────────────
function hasVoiceSupport() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition) && !!window.speechSynthesis;
}

// ── State Transitions ─────────────────────────────────────────────
function transition(newState, force = false) {
  if (currentState === newState) return;

  // Force transitions allowed from any state: → PASSIVE (stop), → OFF (close)
  if (!force) {
    const allowed = ALLOWED_TRANSITIONS[currentState];
    if (!allowed || !allowed.includes(newState)) {
      console.warn(`Randy: blocked ${currentState} → ${newState}`);
      return;
    }
  }

  const oldState = currentState;
  currentState = newState;
  console.log(`Randy: ${oldState} → ${newState}`);

  // Persist only OFF/PASSIVE
  if (newState === STATES.OFF) localStorage.setItem(STORAGE_KEY, 'off');
  else if (newState === STATES.PASSIVE) localStorage.setItem(STORAGE_KEY, 'passive');

  updateWidgetUI();
  onStateEnter(newState, oldState);
}

function onStateEnter(state, prevState) {
  switch (state) {
    case STATES.OFF:
      stopAll();
      break;
    case STATES.PASSIVE:
      // Quiet whenever voice is off — either the user is typing (type mode) or
      // has toggled the Voice button off. Stop the mic and any speech but KEEP
      // the conversation history so the chat can be resumed. The mic is never
      // left running here: the browser's recording indicator must only be on
      // while the voice feature is actively on.
      if (isTypeModeActive || !voiceEnabled) {
        if (recognition) { try { recognition.abort(); } catch { /* ok */ } }
        if (synth.speaking) synth.cancel();
        speechChainCancelled = true;
        if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
        if (confirmTimeout) { clearTimeout(confirmTimeout); confirmTimeout = null; }
        isRandySpeaking = false;
        currentSpokenText = '';
        currentSpeechOnComplete = null;
        pendingActions = null;
        confirmAttempts = 0;
        accumulatedTranscript = '';
        voiceEnabled = false;
      } else {
        stopAll();
        startRecognition();
      }
      break;
    case STATES.ACTIVE_LISTENING:
      accumulatedTranscript = '';
      if (!isTypeModeActive && (prevState === STATES.PASSIVE || prevState === STATES.SPEAKING || prevState === STATES.CONFIRMING)) {
        startRecognition();
      }
      break;
    case STATES.PROCESSING:
      // handled by caller
      break;
    case STATES.SPEAKING:
      // handled by speakText
      break;
    case STATES.CONFIRMING:
      startConfirmTimeout();
      if (!isTypeModeActive) startRecognition();
      break;
  }
}

// ── Full Stop ─────────────────────────────────────────────────────
function stopAll() {
  if (recognition) {
    try { recognition.abort(); } catch { /* ok */ }
  }
  if (synth.speaking) synth.cancel();
  speechChainCancelled = true;
  if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
  if (abortController) { abortController.abort(); abortController = null; }
  if (confirmTimeout) { clearTimeout(confirmTimeout); confirmTimeout = null; }
  isRandySpeaking = false;
  currentSpokenText = '';
  currentSpeechOnComplete = null;
  lastSpokenText = '';
  lastSpeechEndTime = 0;
  conversationHistory = [];
  pendingActions = null;
  pendingOpenItem = null;
  confirmAttempts = 0;
  accumulatedTranscript = '';
  currentConvId = null;
  currentConvRow = null;
  convStartedAt = null;
  voiceEnabled = false;
  isDragging = false;
}

// ── Speech Recognition ────────────────────────────────────────────
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const transcript = result[0].transcript.trim();
    if (!transcript) return;

    // Show live interim transcription in chat
    if (!result.isFinal) {
      if (currentState === STATES.ACTIVE_LISTENING && !isRandySpeaking) {
        const preview = accumulatedTranscript
          ? accumulatedTranscript + ' ' + transcript
          : transcript;
        updateInterimBubble(preview);
      }
      return;
    }

    // Final result — clear interim bubble
    removeInterimBubble();

    const confidence = result[0].confidence;
    if (confidence !== 0 && confidence < 0.6) return;

    // During speaking: check for intentional interrupt vs echo
    if (isRandySpeaking) {
      if (isInterrupt(transcript)) {
        synth.cancel();
        speechChainCancelled = true;
        isRandySpeaking = false;
        currentSpokenText = '';
        currentSpeechOnComplete = null;
        // With streaming, the LLM fetch may still be in flight when
        // the user interrupts mid-speech. Abort it so processUserInput
        // unwinds and the barge-in can start a new turn.
        if (abortController) { abortController.abort(); abortController = null; }
        console.log('Randy: interrupted by user');
        if (currentState === STATES.SPEAKING) {
          currentState = STATES.ACTIVE_LISTENING;
          accumulatedTranscript = '';
          updateWidgetUI();
        }
        handleTranscript(transcript);
      }
      return;
    }

    // After Randy just finished speaking: catch echo tails
    if (isEchoTail(transcript)) {
      console.log('Randy: discarded echo tail:', transcript.substring(0, 40));
      return;
    }

    // In ACTIVE_LISTENING: accumulate transcript, then classify
    if (currentState === STATES.ACTIVE_LISTENING) {
      accumulatedTranscript = accumulatedTranscript
        ? accumulatedTranscript + ' ' + transcript
        : transcript;
      updateInterimBubble(accumulatedTranscript);

      // Cancel any pending auto-send (user is still speaking)
      if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }

      const classification = classifyTranscript(accumulatedTranscript);
      // Auto-send for actions (500ms) and questions (1500ms).
      // Also auto-send with a 1500ms delay when any preset is active — short
      // opportunity names like "Insight MSP licensing Deal" classify as
      // 'unknown' but must still fire when the Timeline PDF preset is selected.
      const _activeLbl = loadedPresets.find(p => p.prompt_id === activePresetId)?.label;
      const _isPresetActive = !!_activeLbl;
      // Pending follow-ups (MAP / Timeline / open-item flows) expect short
      // answers like "ANICO" or "the second one" that classify as
      // 'unknown' — auto-send those too so the flow doesn't stall.
      const _hasPendingFollowUp = !!(pendingMapIntent || pendingTimelineIntent || pendingOpenItem);
      const autoSendDelay = classification === 'action' ? 500 : 1500;
      if (classification === 'action' || classification === 'question' || _isPresetActive || _hasPendingFollowUp) {
        autoSendTimer = setTimeout(() => {
          autoSendTimer = null;
          removeInterimBubble();
          if (accumulatedTranscript.trim()) {
            const text = accumulatedTranscript.trim();
            accumulatedTranscript = '';
            processUserInput(text);
          }
        }, autoSendDelay);
      }
      // Status bar always shows "Listening..." during ACTIVE_LISTENING (set by updateStatusBar)
      return;
    }

    handleTranscript(transcript);
  };

  rec.onerror = (event) => {
    switch (event.error) {
      case 'no-speech':
        // Normal during passive listening, just restart
        scheduleRestart();
        break;
      case 'not-allowed':
      case 'service-not-available':
        showError('Mic access lost — click to reconnect');
        transition(STATES.OFF, true);
        break;
      case 'aborted':
        // Intentional stop, check state and restart if needed
        if ((currentState === STATES.PASSIVE || currentState === STATES.ACTIVE_LISTENING) && !isRandySpeaking) {
          scheduleRestart();
        }
        break;
      default:
        console.error('Randy mic error:', event.error);
        scheduleRestart();
    }
  };

  rec.onend = () => {
    // Restart during SPEAKING to enable barge-in interrupts
    if (currentState === STATES.SPEAKING) {
      scheduleRestart();
      return;
    }
    // Restart if still in a listening state and not speaking
    if ((currentState === STATES.PASSIVE || currentState === STATES.ACTIVE_LISTENING || currentState === STATES.CONFIRMING) && !isRandySpeaking) {
      scheduleRestart();
    }
  };

  return rec;
}

function scheduleRestart() {
  const now = Date.now();

  // Rate limiting: if >5 restarts in 3 seconds, throttle
  if (now - restartWindowStart > 3000) {
    restartCount = 0;
    restartWindowStart = now;
  }
  restartCount++;

  if (restartCount > 5) {
    restartCount = 0;
    setTimeout(() => startRecognition(), 2000);
    return;
  }

  setTimeout(() => startRecognition(), 100);
}

function startRecognition() {
  if (currentState === STATES.OFF || currentState === STATES.PROCESSING) return;
  // Never open the mic while voice is off. PASSIVE with voice disabled is the
  // "paused" state reached by toggling the Voice button off — the mic (and the
  // browser recording indicator) must stay closed until voice is turned back
  // on. This also stops onend/onerror auto-restarts from resurrecting it.
  if (currentState === STATES.PASSIVE && !voiceEnabled) return;
  if (isTypeModeActive) return;
  // Pause if the existing voice widget (chat mic) is active — only one SpeechRecognition at a time
  if (isVoiceModeActive()) return;
  // Pause while a text field is being dictated into — that feature owns the
  // mic until the user clicks away (it calls window._randyResume when done).
  if (window._fieldDictationActive) return;

  if (!recognition) recognition = initRecognition();
  if (!recognition) return;

  try {
    recognition.start();
  } catch {
    // Already started or error, ignore
  }
}

// ── Transcript Handler ────────────────────────────────────────────
function handleTranscript(transcript) {
  const lower = transcript.toLowerCase();

  if (currentState === STATES.PASSIVE) {
    // Check for wake word
    const wakeMatch = lower.match(WAKE_PATTERN);
    if (!wakeMatch) return;

    // Kick off sheet load in parallel with the user finishing their
    // sentence. By the time processUserInput runs, the cache is hot
    // and loadSheetData() returns instantly.
    warmSheetData();

    // Visual flash + auto-expand window
    flashWidget();
    voiceEnabled = true;
    if (windowState === 'collapsed') setWindowState('open');

    // Extract trailing text after "randy"
    const afterWake = transcript.substring(lower.indexOf('randy') + 5).trim();

    transition(STATES.ACTIVE_LISTENING);

    if (afterWake.length > 2) {
      // User included their request — process directly without "What's up?"
      processUserInput(afterWake);
    } else {
      speakText("What's up?");
    }
    return;
  }

  if (currentState === STATES.ACTIVE_LISTENING) {
    // Check for deactivation
    if (isDeactivationPhrase(lower)) {
      // Verbal dismissal turns Randy fully OFF (mic closed) rather than
      // lingering in wake-word listening — consistent with "not on unless
      // the user activates it."
      speakText("Alright, I'm out. Hit me up whenever.", () => {
        transition(STATES.OFF, true);
      });
      return;
    }

    processUserInput(transcript);
    return;
  }

  if (currentState === STATES.CONFIRMING) {
    handleConfirmation(lower);
    return;
  }
}

function isDeactivationPhrase(lower) {
  return DEACTIVATION_PHRASES.some(phrase => lower.includes(phrase));
}

// ── NAV Block Parser ─────────────────────────────────────────────
function parseNavCommands(text) {
  const navs = [];
  let parseError = false;
  const cleaned = text.replace(/:::NAV\n([\s\S]*?)\n:::/g, (_, json) => {
    try { navs.push(JSON.parse(json)); } catch (e) { console.error('Failed to parse NAV:', e); parseError = true; }
    return '';
  }).trim();
  return { cleaned, navs, parseError };
}

// ── NAV Execution ────────────────────────────────────────────────
async function executeNavCommand(nav) {
  if (!nav || !nav.action) return;

  switch (nav.action) {
    case 'navigate': {
      let route = nav.target;
      // Fallback: check PORTAL_ROUTES if target isn't a full path
      if (route && !route.startsWith('/')) {
        const key = route.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        route = PORTAL_ROUTES[key] || route;
      }
      if (route) {
        console.log('Randy NAV: navigating to', route);
        window.location.hash = '#' + route;
      }
      break;
    }

    case 'open_detail': {
      if (!nav.target || !nav.target.includes(':')) {
        console.warn('Randy NAV: invalid open_detail target', nav.target);
        break;
      }
      const [type, ...nameParts] = nav.target.split(':');
      const name = nameParts.join(':').trim().toLowerCase();

      if (type === 'partner') {
        try {
          const data = await loadSheetData();
          const partners = data.partners || [];
          // Exact match first, then partial (but only single match)
          const partner = partners.find(p =>
            (p.display_name || '').toLowerCase() === name
          ) || (() => {
            const matches = partners.filter(p => (p.display_name || '').toLowerCase().includes(name));
            return matches.length === 1 ? matches[0] : null;
          })();
          if (partner) {
            console.log('Randy NAV: opening partner', partner.display_name, partner.partner_id);
            window.location.hash = '#/admin/partner-detail?id=' + encodeURIComponent(partner.partner_id);
          } else {
            console.warn('Randy NAV: partner not found:', name);
            speakText("Couldn't find that partner. Opening the partners list.");
            window.location.hash = '#/admin/partners';
          }
        } catch (e) {
          console.error('Randy NAV: partner lookup failed', e);
          speakText("Had trouble looking that up. Try again.");
        }
      } else if (type === 'opportunity') {
        try {
          const data = await loadSheetData();
          const opps = data.opportunities || [];
          // Exact match first, then partial (single match only)
          const opp = opps.find(o =>
            (o.deal_name || '').toLowerCase() === name ||
            (o.customer_name || '').toLowerCase() === name
          ) || (() => {
            const matches = opps.filter(o =>
              (o.deal_name || '').toLowerCase().includes(name) ||
              (o.customer_name || '').toLowerCase().includes(name)
            );
            return matches.length === 1 ? matches[0] : null;
          })();
          // Navigate to opportunities page first
          window.location.hash = '#/admin/opportunities';
          if (opp) {
            console.log('Randy NAV: opening opportunity', opp.deal_name, opp.opportunity_id);
            // Wait for the view to fully render, then open the modal
            const waitForView = (attempts = 0) => {
              const container = document.getElementById('view-container');
              if (container && container.querySelector('.card, .opp-card, table') && attempts < 10) {
                openOppModal(opp, container);
              } else if (attempts < 10) {
                setTimeout(() => waitForView(attempts + 1), 200);
              }
            };
            setTimeout(() => waitForView(), 300);
          } else {
            speakText("Couldn't find that deal. Opening the opportunities list.");
          }
        } catch (e) {
          console.error('Randy NAV: opportunity lookup failed', e);
          speakText("Had trouble looking that up. Try again.");
        }
      }
      break;
    }

    case 'open_document':
    case 'open_note': {
      // LLM fallback for phrasings the regex intent detector misses.
      // The NAV block only carries the user's own descriptor words —
      // resolution against real files/notes stays deterministic in
      // runOpenItemFlow, which asks the user when anything is ambiguous.
      const target = String(nav.target || '');
      const name = target.includes(':') ? target.split(':').slice(1).join(':').trim() : target.trim();
      await runOpenItemFlow({
        itemType: nav.action === 'open_note' ? 'note' : 'document',
        oppHint: name || null,
        itemHint: typeof nav.item === 'string' ? nav.item : '',
      });
      break;
    }

    case 'click':
      console.log('Randy NAV: click action (not implemented)', nav.target);
      break;

    default:
      console.warn('Randy NAV: unknown action', nav.action);
  }
}

// ── Process User Input (voice-only) ───────────────────────────────
// Flow:
//   1. Start streaming Claude's response.
//   2. As text arrives, watch for the **Summary** section to close
//      (a blank-line + --- / ### terminator, or two newlines). When it
//      closes AND no :::ACTION has appeared yet, fire TTS on the summary
//      in parallel with the rest of the stream — this is where the
//      perceived-latency win comes from.
//   3. When the stream finishes, parse :::ACTION and :::NAV blocks.
//      If actions exist they need user confirmation; the confirmation
//      prompt is either appended (when summary already played) or
//      spoken as one utterance (when it hasn't).
async function processUserInput(text) {
  // Re-entry guard — prevent parallel API calls
  if (isProcessing) return;

  // ── MAP PDF intent routing ────────────────────────────────────────
  // Intercept before the regular Claude flow. Three paths:
  //   (a) A prior MAP turn asked "which opportunity?" / "which one of
  //       these?" — this message answers the follow-up.
  //   (b) The "Timeline PDF" preset is active — every message is treated
  //       as an opportunity hint, bypassing regex detection entirely.
  //   (c) The user just gave a MAP trigger phrase ("create a MAP for
  //       ANICO"). detectMapPdfIntent() does pure regex matching on
  //       the text; when `triggered` is false we fall through and the
  //       existing chat flow runs byte-identical to before.
  if (pendingMapIntent) {
    const _pending = pendingMapIntent;
    pendingMapIntent = null;
    isProcessing = true;
    transition(STATES.PROCESSING, isTypeModeActive);
    renderMessage('user', text);
    try {
      await runMapPdfFlow({ hint: text, followUp: _pending });
    } finally {
      isProcessing = false;
    }
    return;
  }
  if (pendingTimelineIntent) {
    const _pending = pendingTimelineIntent;
    pendingTimelineIntent = null;
    isProcessing = true;
    transition(STATES.PROCESSING, isTypeModeActive);
    renderMessage('user', text);
    try {
      await runTimelinePdfFlow({ hint: text, followUp: _pending });
    } finally {
      isProcessing = false;
    }
    return;
  }
  if (pendingOpenItem) {
    const _pending = pendingOpenItem;
    pendingOpenItem = null;
    isProcessing = true;
    transition(STATES.PROCESSING, isTypeModeActive);
    renderMessage('user', text);
    try {
      await continueOpenItemFlow(text, _pending);
    } finally {
      isProcessing = false;
    }
    return;
  }
  const _activePresetLabel = loadedPresets.find(p => p.prompt_id === activePresetId)?.label;
  const _normalizedLabel = _activePresetLabel ? _activePresetLabel.trim().replace(/\s+/g, ' ').toLowerCase() : '';
  if (_normalizedLabel === 'timeline pdf') {
    console.log(`[Timeline PDF preset] routing message into Timeline PDF flow, hint="${text}"`);
    isProcessing = true;
    transition(STATES.PROCESSING, isTypeModeActive);
    renderMessage('user', text);
    try {
      await runTimelinePdfFlow({ hint: text });
    } finally {
      isProcessing = false;
    }
    return;
  }
  // Open-item detection runs BEFORE MAP detection so "open the mutual
  // action plan PDF for ANICO" opens the existing file instead of
  // triggering a fresh MAP generation. Creation verbs never match the
  // open-item patterns, so "create a MAP for ANICO" still falls through.
  const openIntent = detectOpenItemIntent(text);
  if (openIntent.triggered) {
    isProcessing = true;
    transition(STATES.PROCESSING, isTypeModeActive);
    renderMessage('user', text);
    try {
      await runOpenItemFlow({
        itemType: openIntent.itemType,
        oppHint: openIntent.opportunityHint,
        itemHint: openIntent.itemHint,
      });
    } finally {
      isProcessing = false;
    }
    return;
  }
  const mapIntent = detectMapPdfIntent(text);
  if (mapIntent.triggered) {
    isProcessing = true;
    transition(STATES.PROCESSING, isTypeModeActive);
    renderMessage('user', text);
    try {
      await runMapPdfFlow({ hint: mapIntent.opportunityHint });
    } finally {
      isProcessing = false;
    }
    return;
  }

  transition(STATES.PROCESSING, isTypeModeActive);
  renderMessage('user', text);
  renderTypingIndicator();

  isProcessing = true;

  try {
    // Respect the shared 60s sheet cache (warmed on wake-word). Writes
    // still invalidate via ai-actions.js, so this stays fresh.
    const sheetData = await loadSheetData();
    abortController = new AbortController();

    // Add user message to history only now (after we have data, before API call)
    conversationHistory.push({ role: 'user', content: text });

    let summarySpoken = false;
    let summaryDone = null;
    const summaryPromise = new Promise(resolve => { summaryDone = resolve; });

    const trySpeakSummary = (accumulated) => {
      if (isTypeModeActive) return;
      if (summarySpoken) return;
      // Don't speak early if an action block is already streaming —
      // the confirmation text ("I'll do X, should I go ahead?") has to
      // be appended to the summary as a single utterance.
      if (accumulated.includes(':::ACTION')) return;

      const marker = '**Summary**';
      const start = accumulated.indexOf(marker);
      if (start === -1) return;
      const body = accumulated.slice(start + marker.length);

      // Summary ends at --- / ### separator or a blank line followed
      // by more content. Require at least one terminal punctuation mark
      // so we don't clip mid-sentence.
      const endMatch = body.match(/\n(?:---|###|\n)/);
      if (!endMatch) return;
      const summaryText = body.slice(0, endMatch.index).trim();
      if (!summaryText || !/[.!?]/.test(summaryText)) return;

      summarySpoken = true;
      removeTypingIndicator();
      speakText(summaryText, () => {
        summaryDone();
        // If no follow-up (confirmation) gets queued after the stream
        // completes, fall back to the default SPEAKING → ACTIVE_LISTENING
        // transition that finishSpeaking normally does when no callback
        // is supplied.
        if (currentState === STATES.SPEAKING) {
          transition(STATES.ACTIVE_LISTENING);
        }
      });
    };

    const activePreset = loadedPresets.find(p => p.prompt_id === activePresetId);
    const presetInstructions = activePreset?.instructions?.trim();
    const activeMode = presetInstructions
      ? {
          label: activePreset.label || 'Custom Mode',
          instructions: presetInstructions,
          // Which AI backend this preset runs on (anthropic | kimi).
          // callClaudeStream routes on this; ai.js normalizes/defaults it.
          provider: activePreset.provider,
        }
      : null;

    const response = await callClaudeStream(
      conversationHistory,
      sheetData,
      text,
      abortController.signal,
      RANDY_SYSTEM_PROMPT,
      (_chunk, full) => trySpeakSummary(full),
      activeMode,
    );
    abortController = null;

    conversationHistory.push({ role: 'assistant', content: response });

    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }

    const { cleanText: afterActions, actions } = parseActions(response);
    const { cleaned: cleanText, navs } = parseNavCommands(afterActions);
    removeTypingIndicator();

    // Extract voice text and speak BEFORE rendering HTML into the DOM
    const voiceText = extractVoiceText(cleanText);

    if (actions.length > 0) {
      pendingActions = [...actions];
      confirmAttempts = 0;
      const summaries = actions.map(a => a.summary).filter(Boolean).join(', and ') || 'make that change';
      const confirmSuffix = `I'll ${summaries}. Should I go ahead?`;
      if (isTypeModeActive) {
        // Type mode: show response text then confirmation prompt, no TTS
        renderMessage('assistant', cleanText);
        renderMessage('assistant', confirmSuffix + ' (Type **yes** or **no**)');
        transition(STATES.CONFIRMING, true);
      } else if (summarySpoken) {
        // Summary is already playing. Queue the confirmation to play
        // right after it finishes — don't cancel the in-flight audio.
        (async () => {
          if (summaryPromise) await summaryPromise;
          speakText(confirmSuffix, () => {
            transition(STATES.CONFIRMING);
          });
        })();
        renderMessage('assistant', cleanText);
      } else {
        speakText(`${voiceText}. ${confirmSuffix}`, () => {
          transition(STATES.CONFIRMING);
        });
        renderMessage('assistant', cleanText);
      }
    } else {
      if (!summarySpoken && !isTypeModeActive) {
        // No Summary marker or too-short response — speak the full clean text.
        speakText(voiceText);
      }
      // Render HTML into DOM AFTER speech is triggered
      renderMessage('assistant', cleanText);
      if (isTypeModeActive) transition(STATES.PASSIVE, true);
    }

    // Schedule navigation after a short delay so user hears context first
    if (navs.length > 0) {
      setTimeout(() => {
        navs.forEach(nav => executeNavCommand(nav));
      }, 500);
    }

    // Fire-and-forget — don't block the next turn on a Sheets write.
    saveRandyConversation();

  } catch (err) {
    abortController = null;
    removeTypingIndicator();
    if (err.name === 'AbortError') {
      // Remove the orphaned user message from history
      if (conversationHistory.length > 0 && conversationHistory[conversationHistory.length - 1].role === 'user') {
        conversationHistory.pop();
      }
      // A barge-in interrupt resumes listening, but if the abort came from a
      // full reset (New Chat / Close set the state to OFF), stay off — don't
      // force the mic back on.
      if (currentState !== STATES.OFF) transition(STATES.ACTIVE_LISTENING, true);
      return;
    }
    // Remove orphaned user message on error too
    if (conversationHistory.length > 0 && conversationHistory[conversationHistory.length - 1].role === 'user') {
      conversationHistory.pop();
    }
    console.error('Randy API error:', err);

    let errorDisplay;
    let errorSpeak;
    const msg = err.message || '';

    if (msg.includes('API key not set') || msg.includes('API key')) {
      errorDisplay = "Heads up man — no API key configured. Go to Setup and add your Anthropic API key.";
      errorSpeak = "Heads up man, no API key configured. Go to Setup and add your Anthropic key.";
    } else if (msg.includes('Could not read Google Sheets') || msg.includes('Sheet')) {
      errorDisplay = "Can't reach the Google Sheet right now. Check your connection on the Setup page.";
      errorSpeak = "Can't reach the Google Sheet right now. Check your connection on the Setup page.";
    } else if (msg.includes('401') || msg.includes('authentication')) {
      errorDisplay = "API key looks invalid. Double-check it on the Setup page.";
      errorSpeak = "API key looks invalid. Double-check it on the Setup page.";
    } else if (msg.includes('429') || msg.includes('rate')) {
      errorDisplay = "Hit the rate limit. Give it a minute and try again.";
      errorSpeak = "Hit the rate limit. Give it a minute and try again.";
    } else if (msg.includes('overloaded') || msg.includes('529')) {
      errorDisplay = "Claude is overloaded right now. Try again in a bit.";
      errorSpeak = "Claude is overloaded right now. Try again in a bit.";
    } else {
      errorDisplay = `Something went wrong: ${msg}`;
      errorSpeak = "My bad man, something went wrong. Try again in a sec.";
    }

    renderMessage('assistant', errorDisplay);
    if (isTypeModeActive) {
      transition(STATES.PASSIVE, true);
    } else {
      speakText(errorSpeak);
    }
  } finally {
    isProcessing = false;
  }
}

// ── MAP PDF Flow ──────────────────────────────────────────────────
// See processUserInput() for the interception point. This function runs
// inside the processing lock up to the point where it kicks off the
// background PDF generation, then releases — so the user can keep
// talking to Randy while the skill generates.

async function runMapPdfFlow({ hint }) {
  // No opportunity named — ask and stash a pending flag
  if (!hint || !hint.trim()) {
    const msg = "Which opportunity should I pull the MAP from, man?";
    pendingMapIntent = { awaiting: 'opportunity' };
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  let result;
  try {
    result = await getOpportunityDescription(hint);
  } catch (err) {
    console.error('Randy MAP: opportunity lookup failed', err);
    const msg = "I couldn't pull the opportunities from the sheet, dude. Try again in a sec.";
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  if (result.matchCount === 0) {
    const msg = "I couldn't find that opportunity in the sheet, man. Can you give me the exact name?";
    pendingMapIntent = { awaiting: 'opportunity' };
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  if (result.matchCount > 1) {
    const names = result.matches.map(m => m.opportunityName);
    const spokenList = names.length === 2
      ? `${names[0]}, or ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
    const display = `I found a few, man — which one: ${names.join(', ')}?`;
    const spoken = `I found a few, man. Is it ${spokenList}?`;
    pendingMapIntent = { awaiting: 'opportunity', matches: names };
    if (isTypeModeActive) {
      renderMessage('assistant', display);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(spoken, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', display);
    }
    return;
  }

  // Single match — but refuse if no description history exists (per
  // the decided V1 behavior: don't fall back to Opportunities.description
  // or notes JSON, those aren't structured as meeting content and would
  // produce a bad MAP).
  if (!result.allDescriptions || result.allDescriptions.length === 0) {
    const msg = `No meeting descriptions found for ${result.opportunityName} yet, man. I need at least one description entry in the Opportunity_Descriptions sheet before I can generate a MAP.`;
    const spoken = `No meeting descriptions yet for ${result.opportunityName}, dude. I need at least one description entry in the Opportunity Descriptions sheet before I can generate a MAP.`;
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(spoken, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  // Happy path: kick off background generation and let Randy go back
  // to listening immediately. The background task announces itself when
  // ready — or appends silently if Randy is busy with something else.
  const kickoff = `On it, man. Generating the MAP PDF for ${result.opportunityName} now — this will take a few seconds.`;
  if (isTypeModeActive) {
    renderMessage('assistant', kickoff);
    transition(STATES.PASSIVE, true);
  } else {
    speakText(kickoff, () => transition(STATES.ACTIVE_LISTENING));
    renderMessage('assistant', kickoff);
  }
  startBackgroundPdfGeneration(result);
}

// Background flow: JSON → jsPDF → Drive upload. Runs outside the
// processing lock so the user can keep talking to Randy while the
// PDF gets built and saved.
function startBackgroundPdfGeneration(result) {
  const entries = (result.allDescriptions || []).slice(0, 5).map(e => ({
    date: e.date, content: e.text,
  }));
  const opportunity = {
    name:          result.opportunityName,
    customerName:  result.customerName,
    dealName:      result.dealName,
    opportunityId: result.opportunityId,
  };

  const pill = createPill('Reading description…');

  (async () => {
    try {
      updatePillStage(pill, 'Reading description…');
      const json = await requestMapPdfJson(opportunity, entries);

      updatePillStage(pill, 'Building PDF…');
      const pdfBlob = await buildMapPdf(json, opportunity);
      // Filename always uses ISO generation date (today) — never the
      // human-readable document_date from the JSON, which may be a
      // phrase like "April 22, 2026" that produces garbage when sliced.
      const filename = mapFilename(json.customer_name || opportunity.customerName || opportunity.name);

      updatePillStage(pill, 'Saving to Drive…');
      const base64 = await blobToBase64(pdfBlob);
      const uploadResp = await fileApiRequest({
        action: 'uploadFile',
        opportunityId: opportunity.opportunityId,
        customerName: opportunity.customerName || opportunity.name,
        fileName: filename,
        mimeType: 'application/pdf',
        fileData: base64,
      });

      // Diagnostic: dump the raw Apps Script response so we can see
      // exactly which field names and nesting the server actually uses.
      // Leave this log in place — the field names aren't documented
      // outside the Apps Script source, and rare response variations
      // have snuck past us before.
      console.log('[MAP PDF] Apps Script upload response:', JSON.stringify(uploadResp, null, 2));

      // Field-name resolution for the Drive URL. Apps Script has
      // surfaced slight variations across deployments; try every
      // known path in order and take the first non-empty string.
      const driveUrl =
        uploadResp?.file?.drive_url ||
        uploadResp?.drive_url ||
        uploadResp?.file?.driveUrl ||
        uploadResp?.driveUrl ||
        uploadResp?.file?.webViewLink ||
        uploadResp?.webViewLink ||
        uploadResp?.file?.url ||
        uploadResp?.url ||
        '';
      if (!driveUrl) {
        console.warn('[MAP PDF] No Drive URL in upload response — success card will fall back to in-portal navigation. Response keys:',
          Object.keys(uploadResp || {}), 'file keys:', Object.keys(uploadResp?.file || {}));
      }

      const uploaded = {
        doc_id:     uploadResp?.file?.doc_id     || uploadResp?.doc_id,
        file_name:  uploadResp?.file?.file_name  || uploadResp?.file_name  || filename,
        drive_url:  driveUrl,
        date_added: uploadResp?.file?.date_added || uploadResp?.date_added || new Date().toISOString(),
      };

      // If the user has the opportunity's edit modal open, inject the
      // row so the Documents list updates in place.
      addFileToActiveDocsPanel(opportunity.opportunityId, uploaded);

      markPillSuccess(pill, `Saved to ${opportunity.name}`);
      announceMapPdfReady({
        opportunityName: opportunity.name,
        opportunityId:   opportunity.opportunityId,
        driveUrl,
        filename:        uploaded.file_name,
      });
    } catch (err) {
      markPillFailure(pill, 'Failed — see card');
      announceMapPdfError(err, opportunity);
    }
  })();
}

function randyIsIdle() {
  return currentState === STATES.ACTIVE_LISTENING || currentState === STATES.PASSIVE;
}

// ── Timeline PDF flow ──────────────────────────────────────────
// Mirrors runMapPdfFlow / startBackgroundPdfGeneration exactly,
// swapping in requestTimelineJsonPdf and buildTimelinePdf.

async function runTimelinePdfFlow({ hint }) {
  if (!hint || !hint.trim()) {
    const msg = "Which opportunity should I build the Timeline PDF for, man?";
    pendingTimelineIntent = { awaiting: 'opportunity' };
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  let result;
  try {
    result = await getOpportunityDescription(hint);
  } catch (err) {
    console.error('Randy Timeline: opportunity lookup failed', err);
    const msg = "I couldn't pull the opportunities from the sheet, dude. Try again in a sec.";
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  if (result.matchCount === 0) {
    const msg = "I couldn't find that opportunity in the sheet, man. Can you give me the exact name?";
    pendingTimelineIntent = { awaiting: 'opportunity' };
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  if (result.matchCount > 1) {
    const names = result.matches.map(m => m.opportunityName);
    const spokenList = names.length === 2
      ? `${names[0]}, or ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
    const display = `I found a few, man — which one: ${names.join(', ')}?`;
    const spoken  = `I found a few, man. Is it ${spokenList}?`;
    pendingTimelineIntent = { awaiting: 'opportunity', matches: names };
    if (isTypeModeActive) {
      renderMessage('assistant', display);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(spoken, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', display);
    }
    return;
  }

  if (!result.allDescriptions || result.allDescriptions.length === 0) {
    const msg = `No description history found for ${result.opportunityName} yet, man. I need at least one description entry before I can generate a Timeline PDF.`;
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg, () => transition(STATES.ACTIVE_LISTENING));
      renderMessage('assistant', msg);
    }
    return;
  }

  const kickoff = `On it, man. Building the Timeline PDF for ${result.opportunityName} — give me a few seconds.`;
  if (isTypeModeActive) {
    renderMessage('assistant', kickoff);
    transition(STATES.PASSIVE, true);
  } else {
    speakText(kickoff, () => transition(STATES.ACTIVE_LISTENING));
    renderMessage('assistant', kickoff);
  }
  startBackgroundTimelinePdfGeneration(result);
}

function startBackgroundTimelinePdfGeneration(result) {
  const entries = (result.allDescriptions || []).map(e => ({
    date: e.date, content: e.text,
  }));
  const opportunity = {
    name:          result.opportunityName,
    customerName:  result.customerName,
    dealName:      result.dealName,
    opportunityId: result.opportunityId,
  };

  const pill = createPill('Reading descriptions…');

  (async () => {
    try {
      updatePillStage(pill, 'Reading descriptions…');
      const json = await requestTimelineJsonPdf(opportunity, entries);

      updatePillStage(pill, 'Building PDF…');
      const pdfBlob = await buildTimelinePdf(json, opportunity);
      const filename = timelineFilename(json.customer_name || opportunity.customerName || opportunity.name);

      updatePillStage(pill, 'Saving to Drive…');
      const base64 = await blobToBase64(pdfBlob);
      const uploadResp = await fileApiRequest({
        action: 'uploadFile',
        opportunityId: opportunity.opportunityId,
        customerName: opportunity.customerName || opportunity.name,
        fileName: filename,
        mimeType: 'application/pdf',
        fileData: base64,
      });

      console.log('[Timeline PDF] Apps Script upload response:', JSON.stringify(uploadResp, null, 2));

      const driveUrl =
        uploadResp?.file?.drive_url  || uploadResp?.drive_url  ||
        uploadResp?.file?.driveUrl   || uploadResp?.driveUrl   ||
        uploadResp?.file?.webViewLink || uploadResp?.webViewLink ||
        uploadResp?.file?.url        || uploadResp?.url        || '';

      if (!driveUrl) {
        console.warn('[Timeline PDF] No Drive URL in upload response. Response keys:',
          Object.keys(uploadResp || {}), 'file keys:', Object.keys(uploadResp?.file || {}));
      }

      const uploaded = {
        doc_id:     uploadResp?.file?.doc_id     || uploadResp?.doc_id,
        file_name:  uploadResp?.file?.file_name  || uploadResp?.file_name  || filename,
        drive_url:  driveUrl,
        date_added: uploadResp?.file?.date_added || uploadResp?.date_added || new Date().toISOString(),
      };

      addFileToActiveDocsPanel(opportunity.opportunityId, uploaded);
      markPillSuccess(pill, `Saved to ${opportunity.name}`);
      announceTimelinePdfReady({
        opportunityName: opportunity.name,
        opportunityId:   opportunity.opportunityId,
        driveUrl,
        filename:        uploaded.file_name,
      });
    } catch (err) {
      markPillFailure(pill, 'Failed — see card');
      announceTimelinePdfError(err, opportunity);
    }
  })();
}

function announceTimelinePdfReady({ opportunityName, opportunityId, driveUrl, filename }) {
  const cardHtml = buildTimelineSuccessCardHtml({ opportunityName, opportunityId, driveUrl, filename });
  if (!isTypeModeActive && randyIsIdle()) {
    speakText(`Timeline PDF saved for ${opportunityName} — sweet. Link's in the chat.`);
  }
  const msgEl = renderMessage('assistant', cardHtml);
  if (msgEl && opportunityId) {
    const selectors = ['.randy-timeline-card__btn--in-portal', '.randy-timeline-card__secondary-link'];
    for (const sel of selectors) {
      const link = msgEl.querySelector(sel);
      if (link) link.addEventListener('click', (e) => { e.preventDefault(); openOppForRandy(opportunityId); });
    }
  }
}

function announceTimelinePdfError(err, opportunity) {
  console.error('Randy Timeline PDF error:', err);
  const msg = err?.message || '';
  let spoken, userSummary;
  if (err?.code === 'TIMELINE_JSON_API_ERROR' && err?.status === 401) {
    userSummary = 'The Anthropic API key is invalid or expired. Check it on the Setup page.';
    spoken = 'API key looks invalid, dude. Check the Setup page.';
  } else if (/TIMELINE_JSON_INVALID|TIMELINE_JSON_SCHEMA|TIMELINE_JSON_EMPTY/.test(err?.code || '')) {
    userSummary = "Claude's response didn't parse as expected. Try again, or simplify the source description.";
    spoken = "My bad — Claude sent me bad data. Try again.";
  } else if (err?.name === 'TimeoutError' || /timeout|timed out/i.test(msg)) {
    userSummary = 'The request took longer than 2 minutes. Usually transient — try again.';
    spoken = "That took too long — total dial-up moment. Want me to try again?";
  } else if (/Failed to fetch|network|NetworkError/i.test(msg)) {
    userSummary = 'Network request failed. Check your connection.';
    spoken = 'I lost the connection, dude. Check the network.';
  } else {
    userSummary = 'Something went wrong while generating the Timeline PDF. See the details below.';
    spoken = `I couldn't generate the Timeline PDF for ${opportunity?.name || 'that opportunity'}, man. Details are in the chat.`;
  }
  const cardHtml = buildTimelineFailureCardHtml({
    opportunityName:  opportunity?.name || '',
    opportunityId:    opportunity?.opportunityId || '',
    userSummary,
    technicalDetail: msg || String(err || 'Unknown error'),
  });
  if (!isTypeModeActive && randyIsIdle()) speakText(spoken);
  const msgEl = renderMessage('assistant', cardHtml);
  if (msgEl && opportunity?.opportunityId) {
    const retry = msgEl.querySelector('.randy-timeline-card__retry');
    if (retry) retry.addEventListener('click', async (e) => {
      e.preventDefault();
      retry.disabled = true;
      retry.textContent = 'Retrying…';
      try {
        const fresh = await getOpportunityDescription(opportunity.name || opportunity.customerName);
        if (fresh?.matchCount === 1 && fresh.allDescriptions?.length > 0) {
          startBackgroundTimelinePdfGeneration(fresh);
        } else {
          retry.disabled = false;
          retry.textContent = 'Try again';
          renderMessage('assistant', "Couldn't re-resolve that opportunity, dude. Try the voice command again.");
        }
      } catch (rerunErr) {
        retry.disabled = false;
        retry.textContent = 'Try again';
        console.error('Timeline PDF retry failed', rerunErr);
      }
    });
  }
}

function buildTimelineSuccessCardHtml({ opportunityName, opportunityId, driveUrl, filename }) {
  const safeName = escapeMapHtml(opportunityName);
  const safeFile = escapeMapHtml(filename);
  let primaryBtn;
  if (driveUrl) {
    const safeUrl = escapeMapHtml(driveUrl);
    primaryBtn = `<a class="randy-map-card__btn" href="${safeUrl}" target="_blank" rel="noopener">View in Drive</a>`;
  } else if (opportunityId) {
    primaryBtn = `<a class="randy-map-card__btn randy-timeline-card__btn--in-portal" href="#" data-opportunity-id="${escapeMapHtml(opportunityId)}">Open in Opportunity</a>`;
  } else {
    primaryBtn = `<span class="randy-map-card__btn" aria-disabled="true" style="opacity:0.6;cursor:not-allowed">Saved (no link)</span>`;
  }
  const secondary = opportunityId && driveUrl
    ? `<a class="randy-timeline-card__secondary-link" href="#" data-opportunity-id="${escapeMapHtml(opportunityId)}">Open the opportunity to see all its documents →</a>`
    : '';
  return `<div class="response-container randy-map-card randy-map-card--success">
<div class="randy-map-card__title-row">
<span class="randy-map-card__title-icon"><svg viewBox="0 0 20 20" fill="none"><path d="M4 10l4 4 8-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
<div class="randy-map-card__header">Timeline PDF Saved</div>
</div>
<div class="randy-map-card__subline">${safeName}</div>
<div class="randy-map-card__filename">${safeFile}</div>
${primaryBtn}
${secondary}
</div>`;
}

function buildTimelineFailureCardHtml({ opportunityName, opportunityId, userSummary, technicalDetail }) {
  const safeName    = escapeMapHtml(opportunityName);
  const safeSummary = escapeMapHtml(userSummary);
  const safeDetail  = escapeMapHtml(technicalDetail);
  const retry = opportunityId
    ? `<button class="randy-timeline-card__retry" type="button">Try again</button>`
    : '';
  return `<div class="response-container randy-map-card randy-map-card--warning">
<div class="randy-map-card__title-row">
<span class="randy-map-card__title-icon"><svg viewBox="0 0 20 20" fill="none"><path d="M10 3l8 14H2z" fill="currentColor" opacity="0.2"/><path d="M10 3l8 14H2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.5" r="1" fill="currentColor"/></svg></span>
<div class="randy-map-card__header">Couldn't generate Timeline PDF${safeName ? ' — ' + safeName : ''}</div>
</div>
<div class="randy-map-card__subline">${safeSummary}</div>
<details class="randy-map-card__details">
<summary>Show technical details</summary>
<pre>${safeDetail}</pre>
</details>
${retry}
</div>`;
}

function announceMapPdfReady({ opportunityName, opportunityId, driveUrl, filename }) {
  const cardHtml = buildMapSuccessCardHtml({ opportunityName, opportunityId, driveUrl, filename });

  // TTS-before-DOM ordering. Speak only if Randy is idle — if the
  // user already moved on to another task, the card still lands in
  // the chat but we don't interrupt.
  if (!isTypeModeActive && randyIsIdle()) {
    speakText(`Saved to ${opportunityName} — right on. The MAP PDF is in the opportunity's documents — link's in the chat.`);
  }
  const msgEl = renderMessage('assistant', cardHtml);

  // Wire every in-portal navigation link post-render — sanitizeHTML()
  // strips on* handlers from the string, so we attach listeners now.
  // Covers both the fallback primary button (when Drive URL is missing)
  // and the secondary "Open the opportunity" link.
  if (msgEl && opportunityId) {
    const selectors = ['.randy-map-card__btn--in-portal', '.randy-map-card__secondary-link'];
    for (const sel of selectors) {
      const link = msgEl.querySelector(sel);
      if (link) link.addEventListener('click', (e) => {
        e.preventDefault();
        openOppForRandy(opportunityId);
      });
    }
  }
}

function announceMapPdfError(err, opportunity) {
  console.error('Randy MAP PDF error:', err);
  const msg = err?.message || '';
  let spoken, userSummary;
  if (err?.code === 'MAP_JSON_API_ERROR' && err?.status === 401) {
    userSummary = 'The Anthropic API key is invalid or expired. Check it on the Setup page.';
    spoken = 'API key looks invalid, dude. Check the Setup page.';
  } else if (err?.code === 'MAP_JSON_INVALID' || err?.code === 'MAP_JSON_SCHEMA' || err?.code === 'MAP_JSON_EMPTY') {
    userSummary = "Claude's response didn't parse as the expected JSON. Try again, or simplify the source description.";
    spoken = "My bad — Claude sent me bad data. Try again.";
  } else if (err?.name === 'TimeoutError' || /timeout|timed out/i.test(msg)) {
    userSummary = 'The request took longer than 2 minutes. Usually transient — try again.';
    spoken = "That took too long — total dial-up moment. Want me to try again?";
  } else if (/Failed to fetch|network|NetworkError/i.test(msg)) {
    userSummary = 'Network request to Anthropic or Google Drive failed. Check your connection.';
    spoken = 'I lost the connection, dude. Check the network.';
  } else if (err?.message && /upload|drive/i.test(msg)) {
    userSummary = 'The PDF was built but Google Drive rejected the upload. See the details below.';
    spoken = "Drive wouldn't take the upload, man. Details are in the chat.";
  } else {
    userSummary = 'Something went wrong while generating the MAP PDF. See the details below.';
    spoken = `I couldn't generate the MAP PDF for ${opportunity?.name || 'that opportunity'}, man. Details are in the chat.`;
  }

  const cardHtml = buildMapFailureCardHtml({
    opportunityName: opportunity?.name || '',
    opportunityId:   opportunity?.opportunityId || '',
    userSummary,
    technicalDetail: msg || String(err || 'Unknown error'),
  });

  if (!isTypeModeActive && randyIsIdle()) speakText(spoken);
  const msgEl = renderMessage('assistant', cardHtml);

  // Wire "Try again" to re-run the flow for the same opportunity.
  if (msgEl && opportunity?.opportunityId) {
    const retry = msgEl.querySelector('.randy-map-card__retry');
    if (retry) retry.addEventListener('click', async (e) => {
      e.preventDefault();
      retry.disabled = true;
      retry.textContent = 'Retrying…';
      try {
        const fresh = await getOpportunityDescription(opportunity.name || opportunity.customerName);
        if (fresh?.matchCount === 1 && fresh.allDescriptions?.length > 0) {
          startBackgroundPdfGeneration(fresh);
        } else {
          retry.disabled = false;
          retry.textContent = 'Try again';
          renderMessage('assistant', "Couldn't re-resolve that opportunity, dude. Try the voice command again.");
        }
      } catch (rerunErr) {
        retry.disabled = false;
        retry.textContent = 'Try again';
        console.error('MAP retry failed', rerunErr);
      }
    });
  }
}

// Navigate to the admin Opportunities view and open the modal for the
// given ID. Mirrors the NAV open_detail pattern already in this file.
async function openOppForRandy(opportunityId) {
  try {
    const data = await loadSheetData();
    const opp = (data.opportunities || []).find(o => String(o.opportunity_id) === String(opportunityId));
    window.location.hash = '#/admin/opportunities';
    if (!opp) return;
    const waitForView = (attempts = 0) => {
      const container = document.getElementById('view-container');
      if (container && container.querySelector('.card, .opp-card, table') && attempts < 10) {
        openOppModal(opp, container);
      } else if (attempts < 10) {
        setTimeout(() => waitForView(attempts + 1), 200);
      }
    };
    setTimeout(() => waitForView(), 300);
  } catch (e) {
    console.error('openOppForRandy failed', e);
  }
}

function escapeMapHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildMapSuccessCardHtml({ opportunityName, opportunityId, driveUrl, filename }) {
  // The `response-container` class routes this through sanitizeHTML()
  // which allows <a>, <div>, <span>, <details>, etc. — it strips event
  // handlers, so interactive bits get wired up post-render.
  const safeName = escapeMapHtml(opportunityName);
  const safeFile = escapeMapHtml(filename);
  // Primary CTA: prefer the direct Drive link. If Apps Script didn't
  // return one, fall back to opening the Opportunity detail inside
  // the portal — the file definitely lives there (we just uploaded it
  // and the Documents panel listFiles call will surface it). Avoid a
  // disabled "Drive link unavailable" button — it reads as broken.
  let primaryBtn;
  if (driveUrl) {
    const safeUrl = escapeMapHtml(driveUrl);
    primaryBtn = `<a class="randy-map-card__btn" href="${safeUrl}" target="_blank" rel="noopener">View in Drive</a>`;
  } else if (opportunityId) {
    primaryBtn = `<a class="randy-map-card__btn randy-map-card__btn--in-portal" href="#" data-opportunity-id="${escapeMapHtml(opportunityId)}">Open in Opportunity</a>`;
  } else {
    primaryBtn = `<span class="randy-map-card__btn" aria-disabled="true" style="opacity:0.6;cursor:not-allowed">Saved (no link)</span>`;
  }
  const secondary = opportunityId && driveUrl
    ? `<a class="randy-map-card__secondary-link" href="#" data-opportunity-id="${escapeMapHtml(opportunityId)}">Open the opportunity to see all its documents →</a>`
    : '';
  return `<div class="response-container randy-map-card randy-map-card--success">
<div class="randy-map-card__title-row">
<span class="randy-map-card__title-icon"><svg viewBox="0 0 20 20" fill="none"><path d="M4 10l4 4 8-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
<div class="randy-map-card__header">MAP PDF Saved</div>
</div>
<div class="randy-map-card__subline">${safeName}</div>
<div class="randy-map-card__filename">${safeFile}</div>
${primaryBtn}
${secondary}
</div>`;
}

function buildMapFailureCardHtml({ opportunityName, opportunityId, userSummary, technicalDetail }) {
  const safeName = escapeMapHtml(opportunityName);
  const safeSummary = escapeMapHtml(userSummary);
  const safeDetail = escapeMapHtml(technicalDetail);
  const retry = opportunityId
    ? `<button class="randy-map-card__retry" type="button">Try again</button>`
    : '';
  return `<div class="response-container randy-map-card randy-map-card--warning">
<div class="randy-map-card__title-row">
<span class="randy-map-card__title-icon"><svg viewBox="0 0 20 20" fill="none"><path d="M10 3l8 14H2z" fill="currentColor" opacity="0.2"/><path d="M10 3l8 14H2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.5" r="1" fill="currentColor"/></svg></span>
<div class="randy-map-card__header">Couldn't generate MAP PDF${safeName ? ' — ' + safeName : ''}</div>
</div>
<div class="randy-map-card__subline">${safeSummary}</div>
<details class="randy-map-card__details">
<summary>Show technical details</summary>
<pre>${safeDetail}</pre>
</details>
${retry}
</div>`;
}

// ── Open Item Flow (documents & description notes) ────────────────
// Voice path for "open the pricing PDF for ANICO" / "open the latest
// description note on Greenshield". Intent detection is regex-based
// (open-item-intent.js) with an LLM :::NAV fallback (open_document /
// open_note); resolution against the real records is always
// deterministic — the LLM never picks a file or note itself. Anything
// ambiguous is read back to the user instead of guessed.

// Speak + render the same turn-ending response the other flows use.
function respondOpenItem(display, spoken) {
  if (isTypeModeActive) {
    renderMessage('assistant', display);
    transition(STATES.PASSIVE, true);
  } else {
    speakText(spoken || display, () => transition(STATES.ACTIVE_LISTENING));
    renderMessage('assistant', display);
  }
}

function humanFileName(fileName) {
  return String(fileName || 'that file')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'that file';
}

async function runOpenItemFlow({ itemType, oppHint, itemHint }) {
  const noun = itemType === 'note' ? 'description note' : 'document';

  // ── Resolve the opportunity ────────────────────────────────────
  let result = null;
  try {
    if (oppHint && oppHint.trim()) {
      result = await getOpportunityDescription(oppHint);
    } else if (itemHint && contentTokens(itemHint).length > 0) {
      // No explicit "for X" clause — the opp name may be embedded in the
      // descriptor ("open the ANICO pricing doc"). Filler words are
      // stripped first so "the latest note" never reaches the matcher,
      // and the match is only accepted when the opportunity's real name
      // actually appears in the descriptor — the acronym-tier fallback
      // in the opp matcher is too loose for a guessed name.
      const joined = contentTokens(itemHint).join(' ');
      const embedded = await getOpportunityDescription(joined);
      const mentioned = (o) => hintMentionsName(joined, o.customerName) || hintMentionsName(joined, o.dealName);
      if (embedded.matchCount === 1 && mentioned(embedded)) {
        result = embedded;
      } else if (embedded.matchCount > 1 && embedded.matches.some(mentioned)) {
        result = embedded;
      }
    }
  } catch (err) {
    console.error('Randy open-item: opportunity lookup failed', err);
    respondOpenItem("I couldn't pull the opportunities from the sheet, man. Try again in a sec.");
    return;
  }

  if (!result || result.matchCount === 0) {
    pendingOpenItem = { awaiting: 'opportunity', itemType, itemHint };
    const msg = (oppHint && oppHint.trim())
      ? "I couldn't find that opportunity in the sheet, man. Can you give me the exact name?"
      : `Which opportunity is that ${noun} on, man?`;
    respondOpenItem(msg);
    return;
  }

  if (result.matchCount > 1) {
    const names = result.matches.map(m => m.opportunityName);
    const spokenList = names.length === 2
      ? `${names[0]}, or ${names[1]}`
      : `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
    pendingOpenItem = { awaiting: 'opportunity', itemType, itemHint };
    respondOpenItem(
      `I found a few, man — which one: ${names.join(', ')}?`,
      `I found a few, man. Is it ${spokenList}?`,
    );
    return;
  }

  // Exactly one opportunity — drop its name from the descriptor so
  // "ANICO pricing doc" matches files on "pricing doc" alone.
  const cleanedHint = stripOpportunityTokens(itemHint || '', [result.customerName, result.dealName]);

  if (itemType === 'document') {
    await resolveAndOpenDocument(result, cleanedHint);
  } else {
    await resolveAndOpenNote(result, cleanedHint);
  }
}

async function resolveAndOpenDocument(opp, docHint) {
  let files;
  try {
    const resp = await fileApiRequest({ action: 'listFiles', opportunityId: opp.opportunityId });
    files = Array.isArray(resp.files) ? resp.files : [];
  } catch (err) {
    console.error('Randy open-item: listFiles failed', err);
    respondOpenItem(`I couldn't pull the documents for ${opp.opportunityName}, man. Try again in a sec.`);
    return;
  }

  if (files.length === 0) {
    respondOpenItem(`No documents on ${opp.opportunityName} yet, man.`);
    return;
  }

  const matches = matchDocuments(files, docHint);
  if (matches.length === 1) {
    openDocumentForRandy(matches[0], opp);
    return;
  }

  // Zero or several plausible files — never guess. Read the options
  // back and stash them so the next reply picks one.
  const candidates = matches.length > 1 ? matches : files;
  pendingOpenItem = { awaiting: 'document', files: candidates, opp };
  const spokenNames = candidates.slice(0, 5).map(f => humanFileName(f.file_name));
  const extra = candidates.length > 5 ? `, and ${candidates.length - 5} more in the chat` : '';
  const lead = matches.length > 1
    ? `A few documents on ${opp.opportunityName} match that, man.`
    : `I don't see a document matching that on ${opp.opportunityName}, man.`;
  const spoken = `${lead} I've got ${spokenNames.join(', ')}${extra}. Which one?`;
  respondOpenItem(buildDocListCardHtml(opp, candidates), spoken);
}

function openDocumentForRandy(file, opp) {
  const human = humanFileName(file.file_name);
  const url = file.drive_url || '';
  // Voice-triggered window.open runs outside a user gesture, so pop-up
  // blockers may refuse it — the card below always carries the link.
  let openedWindow = null;
  if (url) {
    try { openedWindow = window.open(url, '_blank', 'noopener'); } catch { openedWindow = null; }
  }
  let spoken;
  if (!url) {
    spoken = `Found ${human} on ${opp.opportunityName}, man, but there's no Drive link recorded for it.`;
  } else if (!openedWindow) {
    spoken = `Got it, man — the browser blocked the pop-up, so the link for ${human} is in the chat.`;
  } else {
    spoken = `Opening ${human} for ${opp.opportunityName}, man.`;
  }
  respondOpenItem(buildOpenDocCardHtml(opp, file), spoken);
}

async function resolveAndOpenNote(opp, noteHint) {
  const descs = opp.allDescriptions || [];
  if (descs.length === 0) {
    // Nothing in Opportunity_Descriptions — open the deal anyway; the
    // modal surfaces a legacy opp.description entry when one exists.
    openOppDetailsForRandy(opp.opportunityId, null);
    respondOpenItem(`I don't see any description notes on ${opp.opportunityName}, man — opening the deal so you can double-check.`);
    return;
  }

  const target = resolveDescriptionTarget(descs, noteHint);
  if (target.none || target.candidates) {
    const idxs = target.candidates || descs.map((_, i) => i);
    pendingOpenItem = { awaiting: 'note', descriptions: idxs.map(i => descs[i]), opp };
    const dates = idxs.slice(0, 6).map(i => formatSpokenDate(descs[i].date));
    const extra = idxs.length > 6 ? `, and ${idxs.length - 6} more` : '';
    const lead = target.none
      ? `Couldn't pin down that note on ${opp.opportunityName}, man.`
      : `A few notes on ${opp.opportunityName} match, man.`;
    respondOpenItem(`${lead} I've got notes from ${dates.join(', ')}${extra}. Which one?`);
    return;
  }

  openNoteForRandy(opp, descs[target.index], { defaulted: !!target.defaulted, total: descs.length });
}

function openNoteForRandy(opp, note, { defaulted = false, total = 0 } = {}) {
  openOppDetailsForRandy(opp.opportunityId, { id: note.id || '', date: note.date || '' });
  const when = formatSpokenDate(note.date);
  const spoken = (defaulted && total > 1)
    ? `Opening the latest note on ${opp.opportunityName}, man — that's from ${when}. There are ${total} notes total if you need an older one.`
    : `Opening the note from ${when} on ${opp.opportunityName}, man.`;
  respondOpenItem(spoken);
}

// Handle the reply to an open-item follow-up question.
async function continueOpenItemFlow(text, pending) {
  if (pending.awaiting === 'opportunity') {
    await runOpenItemFlow({ itemType: pending.itemType, oppHint: text, itemHint: pending.itemHint });
    return;
  }

  if (pending.awaiting === 'document') {
    const files = pending.files || [];
    const pick = parseOrdinalPick(text, files.length);
    if (pick >= 0) {
      openDocumentForRandy(files[pick], pending.opp);
      return;
    }
    const matches = matchDocuments(files, text);
    if (matches.length === 1) {
      openDocumentForRandy(matches[0], pending.opp);
      return;
    }
    pendingOpenItem = pending;
    respondOpenItem(`Still not sure which one, man — say the file name, or a number like "the first one".`);
    return;
  }

  if (pending.awaiting === 'note') {
    const descs = pending.descriptions || [];
    // Dates are the natural way to pick a note; ordinals ("the first
    // one") refer to the spoken list order, so only use them when the
    // reply carries no date.
    if (!parseSpokenDate(text)) {
      const pick = parseOrdinalPick(text, descs.length);
      if (pick >= 0) {
        openNoteForRandy(pending.opp, descs[pick]);
        return;
      }
    }
    const target = resolveDescriptionTarget(descs, text);
    if (typeof target.index === 'number') {
      openNoteForRandy(pending.opp, descs[target.index]);
      return;
    }
    pendingOpenItem = pending;
    respondOpenItem(`Still not sure which note, man — give me the date, or say "the first one".`);
  }
}

// Navigate to the Opportunities view and open the read-only details
// modal, optionally focusing one description card. Mirrors openOppForRandy.
async function openOppDetailsForRandy(opportunityId, focusDescription) {
  try {
    const data = await loadSheetData();
    const opp = (data.opportunities || []).find(o => String(o.opportunity_id) === String(opportunityId));
    window.location.hash = '#/admin/opportunities';
    if (!opp) return;
    const waitForView = (attempts = 0) => {
      const container = document.getElementById('view-container');
      if (container && container.querySelector('.card, .opp-card, table') && attempts < 10) {
        openOppDetailsModal(opp, focusDescription ? { focusDescription } : {});
      } else if (attempts < 10) {
        setTimeout(() => waitForView(attempts + 1), 200);
      }
    };
    setTimeout(() => waitForView(), 300);
  } catch (e) {
    console.error('openOppDetailsForRandy failed', e);
  }
}

function buildOpenDocCardHtml(opp, file) {
  const safeName = escapeMapHtml(file.file_name || 'Untitled');
  const safeOpp = escapeMapHtml(opp.opportunityName);
  const btn = file.drive_url
    ? `<a class="randy-map-card__btn" href="${escapeMapHtml(file.drive_url)}" target="_blank" rel="noopener">View in Drive</a>`
    : `<span class="randy-map-card__btn" aria-disabled="true" style="opacity:0.6;cursor:not-allowed">No Drive link recorded</span>`;
  return `<div class="response-container randy-map-card randy-map-card--success">
<div class="randy-map-card__title-row">
<span class="randy-map-card__title-icon"><svg viewBox="0 0 20 20" fill="none"><path d="M11.5 2.5H5.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6.5l-4-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M11.5 2.5v4h4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>
<div class="randy-map-card__header">Opening Document</div>
</div>
<div class="randy-map-card__subline">${safeOpp}</div>
<div class="randy-map-card__filename">${safeName}</div>
${btn}
</div>`;
}

function buildDocListCardHtml(opp, files) {
  const rows = files.map((f, i) => {
    const name = escapeMapHtml(f.file_name || 'Untitled');
    const link = f.drive_url
      ? `<a href="${escapeMapHtml(f.drive_url)}" target="_blank" rel="noopener">${name}</a>`
      : name;
    return `<div class="randy-map-card__filename">${i + 1}. ${link}</div>`;
  }).join('\n');
  return `<div class="response-container randy-map-card">
<div class="randy-map-card__header">Which document on ${escapeMapHtml(opp.opportunityName)}?</div>
${rows}
<div class="randy-map-card__subline">Say the name or the number, man — or click a link.</div>
</div>`;
}

// ── Confirmation Handling ─────────────────────────────────────────
function handleConfirmation(lower) {
  const isConfirm = CONFIRM_WORDS.some(w => lower.includes(w));
  const isDeny = DENY_WORDS.some(w => lower.includes(w));

  if (confirmTimeout) { clearTimeout(confirmTimeout); confirmTimeout = null; }

  if (isConfirm && pendingActions) {
    conversationHistory.push({ role: 'user', content: lower });
    executeConfirmedAction();
    return;
  }

  if (isDeny) {
    pendingActions = null;
    if (isTypeModeActive) {
      renderMessage('assistant', "OK, skipping that one.");
      transition(STATES.PASSIVE, true);
    } else {
      speakText("OK, skipping that one.", () => {
        transition(STATES.ACTIVE_LISTENING, true);
      });
    }
    return;
  }

  // Unclear response
  confirmAttempts++;
  if (confirmAttempts >= 2) {
    pendingActions = null;
    if (isTypeModeActive) {
      renderMessage('assistant', "I'll leave it for now, you can do it in the chat.");
      transition(STATES.PASSIVE, true);
    } else {
      speakText("I'll leave it for now, you can do it in the chat.", () => {
        transition(STATES.ACTIVE_LISTENING, true);
      });
    }
    return;
  }

  if (isTypeModeActive) {
    renderMessage('assistant', "Sorry, was that a yes or no? (Type yes or no)");
    transition(STATES.CONFIRMING, true);
  } else {
    speakText("Sorry, was that a yes or no?", () => {
      transition(STATES.CONFIRMING, true);
    });
  }
}

async function executeConfirmedAction() {
  if (confirmTimeout) { clearTimeout(confirmTimeout); confirmTimeout = null; }
  const actions = pendingActions;
  pendingActions = null;

  // Safety checks on all actions before executing any
  for (const action of actions) {
    if (action.changes && ('password_hash' in action.changes || 'is_admin' in action.changes)) {
      if (isTypeModeActive) {
        renderMessage('assistant', "Whoa, can't touch that field. Security thing.");
        transition(STATES.PASSIVE, true);
      } else {
        speakText("Whoa, can't touch that field. Security thing.", () => {
          transition(STATES.ACTIVE_LISTENING, true);
        });
      }
      return;
    }
    if (action.type === 'delete' && action.sheet === 'Partners') {
      if (isTypeModeActive) {
        renderMessage('assistant', "Can't delete partners, only status changes. Portal rules.");
        transition(STATES.PASSIVE, true);
      } else {
        speakText("Can't delete partners, only status changes. Portal rules.", () => {
          transition(STATES.ACTIVE_LISTENING, true);
        });
      }
      return;
    }
    if (action.row_match && Object.keys(action.row_match).length === 0 && action.type !== 'create') {
      if (isTypeModeActive) {
        renderMessage('assistant', "I don't have enough info to find that row. Try being more specific.");
        transition(STATES.PASSIVE, true);
      } else {
        speakText("I don't have enough info to find that row. Try being more specific.", () => {
          transition(STATES.ACTIVE_LISTENING, true);
        });
      }
      return;
    }
  }

  transition(STATES.PROCESSING, true);

  try {
    let completed = 0;
    for (const action of actions) {
      await executeAction(action);
      completed++;
      console.log(`[Randy Write] ${new Date().toISOString()}`, action);
    }
    const msg = "Done! Got it all updated.";
    conversationHistory.push({ role: 'assistant', content: msg });
    saveRandyConversation();
    if (isTypeModeActive) {
      renderMessage('assistant', msg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(msg);
    }
  } catch (err) {
    console.error('Randy write error:', err);
    let errMsg;
    if (err.message.includes('No matching row')) {
      errMsg = "Couldn't find that record. Double-check the name and try again.";
    } else {
      errMsg = "That didn't go through. Try again or do it manually in the portal.";
    }
    conversationHistory.push({ role: 'assistant', content: errMsg });
    saveRandyConversation();
    if (isTypeModeActive) {
      renderMessage('assistant', errMsg);
      transition(STATES.PASSIVE, true);
    } else {
      speakText(errMsg);
    }
  }
}

function startConfirmTimeout() {
  if (confirmTimeout) clearTimeout(confirmTimeout);
  confirmTimeout = setTimeout(() => {
    if (currentState === STATES.CONFIRMING) {
      pendingActions = null;
      if (isTypeModeActive) {
        renderMessage('assistant', "OK, I'll leave it for now.");
        transition(STATES.PASSIVE, true);
      } else {
        speakText("OK, I'll leave it for now.", () => {
          transition(STATES.ACTIVE_LISTENING, true);
        });
      }
    }
  }, 15000);
}

// ── Speech Synthesis ──────────────────────────────────────────────
function speakText(text, onComplete) {
  if (isMuted) { if (onComplete) onComplete(); return; }
  // Clean text for speech
  const clean = cleanForSpeech(text);
  if (!clean) { if (onComplete) onComplete(); return; }

  // Set echo prevention flag — mic stays running for barge-in
  isRandySpeaking = true;
  currentSpokenText = clean;
  currentSpeechOnComplete = onComplete || null;
  speechChainCancelled = false;

  if (currentState !== STATES.CONFIRMING && currentState !== STATES.PASSIVE) {
    if (currentState === STATES.PROCESSING || currentState === STATES.ACTIVE_LISTENING) {
      transition(STATES.SPEAKING);
    }
  }

  // Stop any previous playback
  if (synth.speaking) synth.cancel();

  // ── Speak via Web Speech API (instant, no network) ──
  // speakWithWebSpeech also starts recognition for barge-in.
  speakWithWebSpeech(clean);
}

function finishSpeaking() {
  clearSpeakingHighlight();
  setTimeout(() => {
    lastSpokenText = currentSpokenText;
    lastSpeechEndTime = Date.now();
    isRandySpeaking = false;
    currentSpokenText = '';
    const cb = currentSpeechOnComplete;
    currentSpeechOnComplete = null;
    if (cb) {
      cb();
    } else if (currentState === STATES.SPEAKING) {
      transition(STATES.ACTIVE_LISTENING);
    }
  }, 300);
}

function speakWithWebSpeech(clean) {
  // Split into sentences at . ? ! boundaries
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!sentences || sentences.length === 0) {
    finishSpeaking();
    return;
  }
  const parts = sentences.map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length === 0) {
    finishSpeaking();
    return;
  }

  // Short confirmation (under 6 words) — single fast utterance
  const wordCount = clean.split(/\s+/).length;
  const isShort = wordCount < 6;

  function handleError(e) {
    clearSpeakingHighlight();
    if (e.error === 'canceled') {
      speechChainCancelled = true;
      lastSpokenText = currentSpokenText;
      lastSpeechEndTime = Date.now();
      isRandySpeaking = false;
      currentSpokenText = '';
      currentSpeechOnComplete = null;
      return;
    }
    console.error('Randy speech error:', e.error);
    speechChainCancelled = true;
    finishSpeaking();
  }

  function getRateForIndex(i, total) {
    if (isShort) return 1.0;
    if (i === 0) return 0.92;           // first — confident opener
    if (i === total - 1) return 0.90;   // last — closing
    return 0.88;                         // middle — informational
  }

  function speakPart(i) {
    if (speechChainCancelled || i >= parts.length) return;

    const utterance = new SpeechSynthesisUtterance(parts[i]);
    if (selectedVoice) utterance.voice = selectedVoice;
    // Neural voices (Natural/Online) are pre-tuned — keep pitch at 1.0 so they
    // don't sound distorted; traditional phoneme voices benefit from a slight
    // pitch reduction to sound less synthetic.
    const isNeuralVoice = selectedVoice && /natural|online/i.test(selectedVoice.name);
    utterance.pitch = isNeuralVoice ? 1.0 : 0.85;
    utterance.volume = 0.9;
    utterance.rate = getRateForIndex(i, parts.length);

    const isLast = i === parts.length - 1;

    utterance.onend = () => {
      if (isLast) {
        finishSpeaking();
      } else if (!speechChainCancelled) {
        // 100ms gap between sentences for natural pacing
        setTimeout(() => speakPart(i + 1), 100);
      }
    };

    utterance.onerror = handleError;

    synth.speak(utterance);
  }

  speakPart(0);

  // Start recognition for barge-in if not already running
  startRecognition();
}

// ── Voice Selection ───────────────────────────────────────────────
function selectVoice() {
  const allVoices = synth.getVoices();
  if (!allVoices.length) return;

  // Names that identify obviously feminine voices — skipped unless no alternative exists
  const femininePattern = /\b(female|woman|girl|zira|hazel|susan|catherine|samantha|karen|moira|fiona|tessa|victoria|allison|jenny|aria|emma)\b/i;

  // Priority order — neural/online voices sound dramatically more natural than
  // traditional phoneme synthesizers. "Natural" and "Online" in the name signal
  // Microsoft Edge neural TTS; "Google US/UK English" is Chrome's neural engine.
  const priorities = [
    // Microsoft Edge neural voices (most natural, free in Edge/Windows)
    v => /natural/i.test(v.name) && v.lang.startsWith('en') && !femininePattern.test(v.name),
    v => /online/i.test(v.name) && v.lang.startsWith('en') && !femininePattern.test(v.name),
    // Specific high-quality Microsoft neural male voices
    v => /microsoft.*(guy|davis|tony|ryan|brian|andrew)/i.test(v.name) && v.lang.startsWith('en'),
    // Google neural voices (Chrome)
    v => /google us english/i.test(v.name),
    v => /google uk english male/i.test(v.name),
    // Traditional voices as fallback
    v => v.name.includes('Mark') && v.lang.startsWith('en'),
    v => v.name.includes('David') && v.lang.startsWith('en'),
    v => v.name.includes('James') && v.lang.startsWith('en'),
    v => v.name.includes('Daniel') && v.lang.startsWith('en'),
    v => v.name.includes('Alex') && v.lang.startsWith('en'),
    v => v.lang.startsWith('en-US'),
  ];

  for (const test of priorities) {
    const match = allVoices.find(test);
    if (match) { selectedVoice = match; console.log('Randy voice:', selectedVoice.name, selectedVoice.lang); return; }
  }

  selectedVoice = allVoices.find(v => v.lang.startsWith('en')) || allVoices[0] || null;
  if (selectedVoice) console.log('Randy voice:', selectedVoice.name, selectedVoice.lang);
}

// ── Text Cleaning for Speech ──────────────────────────────────────
function cleanForSpeech(text) {
  return text
    // Strip :::ACTION and :::NAV blocks
    .replace(/:::ACTION[\s\S]*?:::/g, '')
    .replace(/:::NAV[\s\S]*?:::/g, '')
    // Strip code blocks
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // Strip markdown headers
    .replace(/#{1,4}\s+/g, '')
    // Strip bold/italic
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    // Strip list markers
    .replace(/^[-•*▸▶]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    // Strip links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Currency: $1,234,567 → "1 million 234 thousand 567 dollars"
    .replace(/\$(\d{1,3}),(\d{3}),(\d{3})/g, (_, m, t, u) => {
      const thousands = parseInt(t);
      const units = parseInt(u);
      let r = `${m} million`;
      if (thousands > 0) r += ` ${thousands} thousand`;
      if (units > 0) r += ` ${units}`;
      return r + ' dollars';
    })
    // $50,000 → "50 thousand dollars"
    .replace(/\$(\d{1,3}),(\d{3})/g, (_, t, u) => {
      const units = parseInt(u);
      return units > 0 ? `${t} thousand ${units} dollars` : `${t} thousand dollars`;
    })
    .replace(/\$/g, ' dollars ')
    // Percent
    .replace(/%/g, ' percent')
    // K after numbers → thousand
    .replace(/(\d)K\b/g, '$1 thousand')
    // M after numbers → million
    .replace(/(\d)M\b/g, '$1 million')
    // Dashes → pauses
    .replace(/--|—/g, ', ')
    // Commas before conjunctions for micro-pauses (only if no comma already)
    .replace(/(?<!,)\s+(and|but)\s+/g, ', $1 ')
    // Newlines → pauses
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    // Cleanup whitespace
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Interim Transcription Bubble ───────────────────────────────────
function updateInterimBubble(text) {
  const chat = document.getElementById('randy-chat');
  if (!chat) return;
  let bubble = document.getElementById('randy-interim');
  if (!bubble) {
    const welcome = chat.querySelector('.randy-welcome');
    if (welcome) welcome.remove();
    const msg = document.createElement('div');
    msg.className = 'randy-msg randy-msg--user randy-msg--interim';
    msg.id = 'randy-interim';
    msg.innerHTML = '<div class="randy-bubble"></div>';
    chat.appendChild(msg);
    bubble = msg;
  }
  bubble.querySelector('.randy-bubble').textContent = text;
  chat.scrollTop = chat.scrollHeight;
}

function removeInterimBubble() {
  const el = document.getElementById('randy-interim');
  if (el) el.remove();
}

// ── Chat Message Rendering ────────────────────────────────────────
function convertTables(text) {
  // Convert GFM-style markdown tables (header row + |---|---| separator
  // + data rows) into <table> HTML. Runs before paragraph/line-break
  // logic so each table collapses into one logical chunk.
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] || '';
    const isHeaderLine = /^\s*\|.+\|\s*$/.test(line);
    const isSeparator = /^\s*\|[\s\-:|]+\|\s*$/.test(next) && /-/.test(next);
    if (isHeaderLine && isSeparator) {
      const headers = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        rows.push(cells);
        i++;
      }
      let html = '<table class="randy-table"><thead><tr>';
      for (const h of headers) html += `<th>${h}</th>`;
      html += '</tr></thead><tbody>';
      for (const row of rows) {
        html += '<tr>';
        for (let c = 0; c < headers.length; c++) {
          html += `<td>${row[c] || ''}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      out.push(`<div class="randy-table-wrap">${html}</div>`);
      // Eat one trailing blank line so we don't emit a stray <br> after the table.
      if (i < lines.length && lines[i].trim() === '') i++;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

function renderMarkdown(text) {
  // Use U+E000 (private-use area) as a placeholder to carry <br> tags
  // through HTML-escaping unchanged — the placeholder has no &, <, or >.
  // Restored to <br> after escaping so line breaks render in both table
  // cells and regular prose. Only this exact tag is whitelisted; all other
  // < > chars remain escaped.
  const escaped = text
    .replace(/<br\s*\/?>/gi, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(//g, '<br>');
  const withTables = convertTables(escaped);
  return withTables
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>').replace(/$/, '</p>')
    // Strip spurious <p> wrappers around block-level elements
    .replace(/<p><(h[234]|ul|li|hr|table)/g, '<$1')
    .replace(/<p><div class="randy-table-wrap">/g, '<div class="randy-table-wrap">')
    .replace(/<\/(h[234]|ul|li|table)><\/p>/g, '</$1>')
    .replace(/<\/div><\/p>/g, '</div>')
    .replace(/<hr><\/p>/g, '<hr>')
    // Strip stray <br>s immediately before/after the table wrapper
    .replace(/<p><br><div class="randy-table-wrap">/g, '<div class="randy-table-wrap">')
    .replace(/<\/div><br>/g, '</div>');
}

function extractVoiceText(text) {
  // Legacy HTML format fallback
  if (text.includes('response-container')) {
    const match = text.match(/data-voice="true"[^>]*>([\s\S]*?)<\/div>\s*<(?:details|\/div)/);
    if (match) {
      const temp = document.createElement('div');
      temp.innerHTML = match[1];
      return temp.textContent.replace('Summary', '').trim();
    }
    return text.replace(/<[^>]*>/g, '').trim();
  }
  // New markdown format: extract text after **Summary** until first --- or ###
  const summaryMatch = text.match(/\*\*Summary\*\*\s*\n([\s\S]*?)(?=\n---|\n###|$)/);
  if (summaryMatch) {
    return summaryMatch[1]
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .trim();
  }
  // Fallback: strip markdown and return full text
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/#{1,4}\s+/g, '').replace(/^---$/gm, '').trim();
}

function containsHTMLResponse(text) {
  // The Randy convention is: assistant responses whose first meaningful
  // wrapper has `response-container` anywhere in its class list should
  // be injected as DOM (via sanitizeHTML) instead of going through the
  // markdown renderer. A literal substring check only matched
  // `class="response-container"` with the closing quote RIGHT after,
  // which failed when cards combined classes (e.g. `class="response-container randy-map-card"`).
  // Regex tolerates any number of additional classes.
  return /class\s*=\s*["'][^"']*\bresponse-container\b/.test(text);
}

function sanitizeHTML(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*\/?>/gi, '')
    .replace(/<link\b[^>]*\/?>/gi, '')
    .replace(/<meta\b[^>]*\/?>/gi, '')
    .replace(/<img\b[^>]*\/?>/gi, '')
    .replace(/<form\b[\s\S]*?<\/form>/gi, '')
    .replace(/<input\b[^>]*\/?>/gi, '')
    .replace(/[\s/]+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function renderMessage(role, text) {
  const chat = document.getElementById('randy-chat');
  if (!chat) return;

  const welcome = chat.querySelector('.randy-welcome');
  if (welcome) welcome.remove();

  // Remove speaking highlight from previous messages
  chat.querySelectorAll('.randy-msg--speaking').forEach(el => el.classList.remove('randy-msg--speaking'));

  const isUser = role === 'user';
  const msg = document.createElement('div');
  msg.className = `randy-msg ${isUser ? 'randy-msg--user' : 'randy-msg--assistant'}`;

  if (!isUser) {
    const avatar = document.createElement('img');
    avatar.className = 'randy-msg__avatar';
    avatar.src = 'assets/randy-avatar.png';
    avatar.alt = 'Randy';
    msg.appendChild(avatar);
    // Mark as currently being spoken
    msg.classList.add('randy-msg--speaking');
  }

  const bubble = document.createElement('div');
  bubble.className = 'randy-bubble';
  if (isUser) {
    bubble.textContent = text;
  } else if (containsHTMLResponse(text)) {
    bubble.innerHTML = sanitizeHTML(text);
  } else {
    bubble.innerHTML = renderMarkdown(text);
  }

  if (!isUser) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'randy-copy-btn';
    copyBtn.title = 'Copy response';
    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    copyBtn.addEventListener('click', () => {
      const textContent = bubble.innerText || bubble.textContent;
      navigator.clipboard.writeText(textContent).then(() => {
        copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        copyBtn.classList.add('randy-copy-btn--copied');
        setTimeout(() => {
          copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
          copyBtn.classList.remove('randy-copy-btn--copied');
        }, 1500);
      });
    });
    bubble.appendChild(copyBtn);
  }

  msg.appendChild(bubble);
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
  return msg;
}

function renderTypingIndicator() {
  const chat = document.getElementById('randy-chat');
  if (!chat) return;
  removeTypingIndicator();
  const msg = document.createElement('div');
  msg.className = 'randy-msg randy-msg--assistant';
  msg.id = 'randy-typing';
  msg.innerHTML = `<img class="randy-msg__avatar" src="assets/randy-avatar.png" alt="Randy"><div class="randy-bubble"><div class="randy-typing"><span></span><span></span><span></span></div></div>`;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('randy-typing');
  if (el) el.remove();
}

function clearSpeakingHighlight() {
  const chat = document.getElementById('randy-chat');
  if (chat) chat.querySelectorAll('.randy-msg--speaking').forEach(el => el.classList.remove('randy-msg--speaking'));
}

function showWelcome() {
  const chat = document.getElementById('randy-chat');
  if (!chat) return;
  chat.innerHTML = `
    <div class="randy-welcome">
      <img src="assets/randy-avatar.png" alt="Randy" class="randy-welcome__avatar">
      <p class="randy-welcome__text">Hey, Randy here. Tap the button or say "Hey Randy" to get started.</p>
    </div>
  `;
}

// ── Conversation Persistence ──────────────────────────────────────
let convStartedAt = null;

async function saveRandyConversation() {
  if (isSaving || conversationHistory.length < 2) return;
  const user = getCurrentUser();
  if (!user) return;

  isSaving = true;
  try {
    const title = (conversationHistory.find(m => m.role === 'user')?.content || 'Randy chat').substring(0, 60);
    const messagesJson = JSON.stringify(conversationHistory.map(m => ({
      ...m, timestamp: new Date().toISOString(), via: 'randy'
    })));

    if (!currentConvId) {
      currentConvId = 'conv_randy_' + Date.now();
      convStartedAt = new Date().toISOString();
      await appendRow(CONFIG.SHEET_AI_CONVERSATIONS, [currentConvId, user.username, convStartedAt, title, messagesJson, 'active']);
      // Read back row index for future updates
      try {
        const all = await readSheetAsObjects(CONFIG.SHEET_AI_CONVERSATIONS);
        const saved = all.find(c => c.conversation_id === currentConvId);
        currentConvRow = saved?._rowIndex || null;
      } catch { /* ok */ }
    } else if (currentConvRow) {
      // Preserve original started_at timestamp on updates
      await updateRow(CONFIG.SHEET_AI_CONVERSATIONS, currentConvRow, [currentConvId, user.username, convStartedAt || new Date().toISOString(), title, messagesJson, 'active']);
    } else {
      // currentConvRow lookup failed earlier — retry the lookup
      try {
        const all = await readSheetAsObjects(CONFIG.SHEET_AI_CONVERSATIONS);
        const saved = all.find(c => c.conversation_id === currentConvId);
        if (saved?._rowIndex) {
          currentConvRow = saved._rowIndex;
          await updateRow(CONFIG.SHEET_AI_CONVERSATIONS, currentConvRow, [currentConvId, user.username, convStartedAt || new Date().toISOString(), title, messagesJson, 'active']);
        }
      } catch { /* ok */ }
    }
  } catch (err) {
    console.warn('Randy: failed to save conversation', err);
  } finally {
    isSaving = false;
  }
}

// ── Window State Management ───────────────────────────────────────
function setWindowState(state) {
  windowState = state;
  updateWindowUI();

  // Lazy-load presets the first time the window opens
  if (state === 'open') {
    loadPresetsOnce();
  }

  // Save to localStorage
  try {
    const win = document.getElementById('randy-window');
    const stored = { state: state === 'fullscreen' ? 'open' : state };
    if (win && state === 'open') {
      stored.left = win.style.left || '';
      stored.top = win.style.top || '';
    }
    localStorage.setItem('pp_randy_window', JSON.stringify(stored));
  } catch { /* ok */ }
}

function updateWindowUI() {
  const widget = document.getElementById('randy-widget');
  if (!widget) return;

  widget.classList.remove('randy--open', 'randy--fullscreen');

  if (windowState === 'open') {
    widget.classList.add('randy--open');
  } else if (windowState === 'fullscreen') {
    widget.classList.add('randy--open', 'randy--fullscreen');
  }
}

// ── Docked (dedicated-page) mode ──────────────────────────────────
// The dedicated Randy page (see views/admin-randy-page.js) reuses the
// SAME singleton widget the floating assistant uses — never a second
// instance, which would fight over the module-level state machine,
// recognition object, and speech synth. dockRandy() relocates the one
// #randy-widget node into a host element on the page and forces it
// open (full-view). undockRandy() moves it back to #randy-root and
// collapses it to the floating avatar, exactly as it was before.
//
// Because every Randy function looks its elements up by id via
// document.getElementById, moving the node leaves all wiring intact —
// listeners ride along with the element and ids stay unique.
export function dockRandy(hostEl) {
  const widget = document.getElementById('randy-widget');
  if (!widget || !hostEl) return false;

  hostEl.appendChild(widget);
  widget.classList.add('randy--docked');

  // Open the window (this also lazy-loads the mode presets the first time)
  // but do NOT start the microphone — visiting the page is not the same as
  // activating voice. The user clicks Voice or types to begin. This keeps
  // Randy off unless explicitly activated.
  setWindowState('open');
  if (conversationHistory.length === 0) showWelcome();
  updateVoiceButton();
  return true;
}

export function undockRandy() {
  const widget = document.getElementById('randy-widget');
  if (!widget) return;
  widget.classList.remove('randy--docked');
  const root = document.getElementById('randy-root');
  if (root) root.appendChild(widget);
  // Collapse back to the floating avatar; the mic keeps listening in the
  // background just like before the page was opened.
  setWindowState('collapsed');
}

function isDocked() {
  const widget = document.getElementById('randy-widget');
  return !!(widget && widget.classList.contains('randy--docked'));
}

// ── Combined UI Update (called by transition()) ───────────────────
function updateWidgetUI() {
  const widget = document.getElementById('randy-widget');
  if (!widget) return;

  // Reset voice state classes
  widget.classList.remove('randy--listening', 'randy--processing', 'randy--speaking', 'randy--confirming', 'randy--flash');

  // Apply voice state classes (for collapsed avatar animation)
  switch (currentState) {
    case STATES.ACTIVE_LISTENING: widget.classList.add('randy--listening'); break;
    case STATES.PROCESSING: widget.classList.add('randy--processing'); break;
    case STATES.SPEAKING: widget.classList.add('randy--speaking'); break;
    case STATES.CONFIRMING: widget.classList.add('randy--confirming'); break;
  }

  // Apply window state
  updateWindowUI();
  updateVoiceButton();
}

// ── Assistant Mode Selector ───────────────────────────────────────
const PRESET_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2'];

// Shared with the dedicated Randy page's preset menu so the swatch shown
// there matches the colored dot in the widget's own Mode dropdown.
export const RANDY_PRESET_COLORS = PRESET_COLORS;

// De-duplicated preset loader. Both the widget (when its window first opens)
// and the dedicated Randy page ask for presets; sharing one in-flight promise
// means the Custom_Prompts sheet is read once, not once per caller.
let presetsLoadPromise = null;
function loadPresetsOnce() {
  if (loadedPresets.length > 0) return Promise.resolve(loadedPresets);
  if (presetsLoadPromise) return presetsLoadPromise;
  presetsLoadPromise = loadCustomPrompts()
    .then(p => {
      loadedPresets = Array.isArray(p) ? p : [];
      presetsLoadPromise = null;
      renderPresets();
      notifyPresetChange();
      return loadedPresets;
    })
    .catch(() => {
      presetsLoadPromise = null;
      return loadedPresets;
    });
  return presetsLoadPromise;
}

// Let external preset menus (the dedicated Randy page) know the preset list or
// the active preset changed, so they can re-sync their own controls.
function notifyPresetChange() {
  try {
    window.dispatchEvent(new CustomEvent('randy-preset-changed'));
  } catch { /* ok */ }
}

// ── Public preset API (used by the dedicated Randy page) ──────────
// The Randy page renders its own <select> preset menu, but it drives the SAME
// activePresetId the widget's built-in Mode dropdown uses. Selecting a preset
// from either place changes how Randy responds and keeps both controls synced.
export function getRandyPresets() {
  return loadedPresets.slice();
}
export function getActiveRandyPresetId() {
  return activePresetId;
}
export function setActiveRandyPreset(promptId) {
  selectPreset(promptId || null);
}
export function ensureRandyPresetsLoaded() {
  return loadPresetsOnce();
}

function setPresetMenuOpen(open) {
  const menu = document.getElementById('randy-mode-menu');
  const btn = document.getElementById('randy-mode-btn');
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.classList.toggle('randy-ctrl-btn--mode-open', open);
}

function togglePresetMenu() {
  const menu = document.getElementById('randy-mode-menu');
  if (!menu) return;
  setPresetMenuOpen(menu.hidden);
}

function selectPreset(promptId) {
  if (promptId === activePresetId) {
    setPresetMenuOpen(false);
    return;
  }
  activePresetId = promptId;
  setPresetMenuOpen(false);

  // Clear conversation so the new preset starts with a clean slate.
  conversationHistory = [];
  const chat = document.getElementById('randy-chat');
  if (chat) {
    const presetName = promptId
      ? (loadedPresets.find(p => p.prompt_id === promptId)?.label || 'this mode')
      : 'Default';
    chat.innerHTML = `<div class="randy-welcome"><p>Switched to <strong>${presetName}</strong>. How can I help?</p></div>`;
  }

  renderPresets();
  notifyPresetChange();
}

function buildModeItem({ label, color, active }) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'randy-mode-item' + (active ? ' randy-mode-item--active' : '');
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', active ? 'true' : 'false');

  const dot = document.createElement('span');
  dot.className = 'randy-mode-item__dot' + (color ? '' : ' randy-mode-item__dot--default');
  if (color) dot.style.background = color;
  item.appendChild(dot);

  const text = document.createElement('span');
  text.className = 'randy-mode-item__label';
  text.textContent = label;
  item.appendChild(text);

  if (active) {
    const check = document.createElement('span');
    check.className = 'randy-mode-item__check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    item.appendChild(check);
  }

  return item;
}

function renderPresets() {
  const wrap = document.getElementById('randy-mode-wrap');
  const menu = document.getElementById('randy-mode-menu');
  const labelEl = document.getElementById('randy-mode-label');
  const btn = document.getElementById('randy-mode-btn');
  if (!wrap || !menu || !labelEl || !btn) return;

  // Hide the whole Mode control when no presets are configured so users with
  // an empty list don't see a dangling selector.
  if (loadedPresets.length === 0) {
    wrap.hidden = true;
    setPresetMenuOpen(false);
    return;
  }
  wrap.hidden = false;

  // Sync the button's label + colored ring with the active preset.
  const activeIdx = loadedPresets.findIndex(p => p.prompt_id === activePresetId);
  const activePreset = activeIdx >= 0 ? loadedPresets[activeIdx] : null;
  const activeColor = activeIdx >= 0 ? (PRESET_COLORS[activeIdx] || '#6b7280') : '';
  labelEl.textContent = activePreset ? activePreset.label : 'Mode';
  labelEl.title = activePreset ? activePreset.label : 'Choose a mode';
  btn.classList.toggle('randy-ctrl-btn--mode-active', !!activePreset);
  if (activeColor) btn.style.setProperty('--mode-color', activeColor);
  else btn.style.removeProperty('--mode-color');

  // Rebuild the dropdown. "Default" first so users can explicitly turn the
  // active preset off without having to know to re-click the same entry.
  menu.innerHTML = '';
  const defaultItem = buildModeItem({ label: 'Default', color: null, active: !activePreset });
  defaultItem.addEventListener('click', () => selectPreset(null));
  menu.appendChild(defaultItem);

  loadedPresets.forEach((preset, index) => {
    const color = PRESET_COLORS[index] || '#6b7280';
    const item = buildModeItem({
      label: preset.label,
      color,
      active: preset.prompt_id === activePresetId,
    });
    item.addEventListener('click', () => selectPreset(preset.prompt_id));
    menu.appendChild(item);
  });
}


// ── Widget DOM ────────────────────────────────────────────────────
const MIC_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
// Chat bubble with a plus — starts a fresh conversation ("New Chat")
const NEWCHAT_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="10" y1="10" x2="14" y2="10"/></svg>`;
const SPEAKER_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const MUTED_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
const FORM_SVG_SM = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
const FORM_SVG_LG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
// Sliders icon for the Mode selector — signals "configurable behavior"
const MODE_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`;
const CARET_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

function syncFormToggleButtons() {
  const active = document.getElementById('qf-panel')?.classList.contains('qf-panel--visible');
  ['randy-form-btn', 'randy-form-bottom-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('randy-form-btn--active', !!active);
  });
}

function createWidget() {
  const root = document.getElementById('randy-root');
  if (!root) return;

  root.innerHTML = `
    <div class="randy randy--passive" id="randy-widget">
      <button class="randy__btn" id="randy-btn" title="Randy Voice Assistant" aria-label="Open Randy assistant">
        <img src="assets/randy-avatar.png" alt="Randy" class="randy__avatar">
      </button>

      <div class="randy__backdrop" id="randy-backdrop"></div>

      <div class="randy-window" id="randy-window">
        <div class="randy-resize randy-resize--n" data-dir="n"></div>
        <div class="randy-resize randy-resize--s" data-dir="s"></div>
        <div class="randy-resize randy-resize--w" data-dir="w"></div>
        <div class="randy-resize randy-resize--e" data-dir="e"></div>
        <div class="randy-resize randy-resize--nw" data-dir="nw"></div>
        <div class="randy-resize randy-resize--ne" data-dir="ne"></div>
        <div class="randy-resize randy-resize--sw" data-dir="sw"></div>
        <div class="randy-resize randy-resize--se" data-dir="se"></div>
        <div class="randy-window__titlebar" id="randy-titlebar">
          <img src="assets/randy-avatar.png" alt="" class="randy-window__titlebar-avatar">
          <span class="randy-window__titlebar-name">Randy</span>
          <div class="randy-window__controls">
            <button class="randy-window__ctrl" id="randy-minimize" title="Minimize" aria-label="Minimize">&#8211;</button>
            <button class="randy-window__ctrl" id="randy-fullscreen-btn" title="Fullscreen" aria-label="Fullscreen">&#9633;</button>
            <button class="randy-window__ctrl" id="randy-close-window" title="Close" aria-label="Close">&times;</button>
          </div>
        </div>

        <div class="randy-window__chat" id="randy-chat"></div>

        <div class="randy-status-bar" id="randy-status-bar">
          <span class="randy-status-dot randy-status-dot--ready" id="randy-status-dot"></span>
          <span class="randy-status-label randy-status-label--ready" id="randy-status" role="status" aria-live="polite">Ready</span>
        </div>

        <div class="randy-window__bottom">
          <div class="randy-window__voice-row">
            <div class="randy-btn-wrap randy-btn-wrap--mode" id="randy-mode-wrap" hidden>
              <button class="randy-ctrl-btn randy-ctrl-btn--mode" id="randy-mode-btn" aria-label="Change assistant mode" aria-haspopup="menu" aria-expanded="false">${MODE_SVG}<span class="randy-mode-btn__caret">${CARET_SVG}</span></button>
              <span class="randy-btn-label randy-btn-label--mode" id="randy-mode-label">Mode</span>
              <div class="randy-mode-menu" id="randy-mode-menu" role="menu" aria-label="Assistant modes" hidden></div>
            </div>
            <div class="randy-btn-wrap">
              <button class="randy-ctrl-btn randy-ctrl-btn--form" id="randy-form-bottom-btn" title="Quick Add" aria-label="Quick add opportunity, partner, or event">${FORM_SVG_LG}</button>
              <span class="randy-btn-label">Add</span>
            </div>
            <div class="randy-btn-wrap">
              <button class="randy-ctrl-btn" id="randy-voice-btn" aria-label="Voice mode">${MIC_SVG}</button>
              <span class="randy-btn-label">Voice</span>
            </div>
            <div class="randy-btn-wrap">
              <button class="randy-ctrl-btn" id="randy-mute-btn" aria-label="Mute voice">${SPEAKER_SVG}</button>
              <span class="randy-btn-label">Mute</span>
            </div>
            <div class="randy-btn-wrap">
              <button class="randy-ctrl-btn" id="randy-newchat-btn" title="New chat" aria-label="Start a new chat">${NEWCHAT_SVG}</button>
              <span class="randy-btn-label">New Chat</span>
            </div>
          </div>
          <div class="randy-input-row" id="randy-input-row">
            <input type="text" class="randy-text-input" id="randy-text-input" placeholder="Type a message..." maxlength="500">
            <button class="randy-send-btn" id="randy-send-btn" title="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            </button>
          </div>
        </div>
      </div>

      <div class="randy__error" id="randy-error"></div>
    </div>
  `;

  // Event listeners — collapsed avatar
  document.getElementById('randy-btn').addEventListener('click', () => {
    hideError();
    if (windowState === 'collapsed') {
      // Open the chat window WITHOUT starting the mic — the user activates
      // voice explicitly via the Voice button (or types). Opening ≠ listening.
      setWindowState('open');
      if (conversationHistory.length === 0) showWelcome();
      updateVoiceButton();
    } else {
      setWindowState('collapsed');
    }
  });

  // Quick form toggle — collapsed-state button (element removed; handler retained for safety)
  document.getElementById('randy-form-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    initQuickForm();
    toggleQuickForm();
    syncFormToggleButtons();
  });

  // Quick form toggle — bottom-row button (visible when window is open)
  document.getElementById('randy-form-bottom-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    initQuickForm();
    toggleQuickForm();
    syncFormToggleButtons();
  });

  // Window controls
  document.getElementById('randy-minimize').addEventListener('click', () => {
    setWindowState('collapsed');
  });
  document.getElementById('randy-fullscreen-btn').addEventListener('click', () => {
    setWindowState(windowState === 'fullscreen' ? 'open' : 'fullscreen');
  });
  document.getElementById('randy-close-window').addEventListener('click', () => {
    saveRandyConversation();
    if (recognition) { try { recognition.abort(); } catch { /* ok */ } }
    if (synth.speaking) synth.cancel();
    speechChainCancelled = true;
    if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
    if (abortController) { abortController.abort(); abortController = null; }
    isRandySpeaking = false;
    currentSpokenText = '';
    currentSpeechOnComplete = null;
    lastSpokenText = '';
    lastSpeechEndTime = 0;
    conversationHistory = [];
    pendingActions = null;
    confirmAttempts = 0;
    currentConvId = null;
    currentConvRow = null;
    convStartedAt = null;
    voiceEnabled = false;
    pendingMapIntent = null;
    pendingTimelineIntent = null;
    const chat = document.getElementById('randy-chat');
    if (chat) chat.innerHTML = '';
    setWindowState('collapsed');
    transition(STATES.OFF, true);
  });
  document.getElementById('randy-backdrop').addEventListener('click', () => setWindowState('open'));

  // Single voice toggle button
  document.getElementById('randy-voice-btn').addEventListener('click', handleVoiceBtnClick);

  // Mode selector — opens a dropdown of preset modes above the button.
  const modeBtn = document.getElementById('randy-mode-btn');
  const modeMenu = document.getElementById('randy-mode-menu');
  const modeWrap = document.getElementById('randy-mode-wrap');
  if (modeBtn && modeMenu && modeWrap) {
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePresetMenu();
    });
    // Close the menu when clicking anywhere outside the wrapper.
    document.addEventListener('click', (e) => {
      if (modeMenu.hidden) return;
      if (!modeWrap.contains(e.target)) setPresetMenuOpen(false);
    });
    // Close on ESC for keyboard users. Capture + stopPropagation so the
    // fullscreen ESC handler below doesn't also fire when the user is just
    // dismissing the menu.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modeMenu.hidden) {
        setPresetMenuOpen(false);
        modeBtn.focus();
        e.stopPropagation();
      }
    }, true);
  }

  // Text input — the message box is always visible, so there's no type toggle.
  const textInput = document.getElementById('randy-text-input');
  const sendBtn = document.getElementById('randy-send-btn');

  // New Chat — save the current conversation, then reset to a clean slate.
  document.getElementById('randy-newchat-btn').addEventListener('click', () => {
    hideError();
    // Each turn already auto-saves; persist once more so the just-finished
    // chat isn't lost, then wipe everything for a fresh start.
    saveRandyConversation();
    // Entering OFF runs stopAll(), which stops the mic and speech and clears
    // history, pending actions, timers, and conversation ids.
    transition(STATES.OFF, true);
    // Clear the follow-up flows and type flag that stopAll() doesn't touch.
    pendingMapIntent = null;
    pendingTimelineIntent = null;
    isTypeModeActive = false;
    const chat = document.getElementById('randy-chat');
    if (chat) chat.innerHTML = '';
    showWelcome();
    updateVoiceButton();
    textInput.focus();
  });

  // Mute toggle
  const muteBtn = document.getElementById('randy-mute-btn');
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    muteBtn.innerHTML = isMuted ? MUTED_SVG : SPEAKER_SVG;
    muteBtn.classList.toggle('randy-ctrl-btn--muted', isMuted);
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute voice' : 'Mute voice');
    // Stop any current speech when muting
    if (isMuted) {
      if (synth.speaking) synth.cancel();
    }
    updateStatusBar();
    try { localStorage.setItem('pp_randy_muted', isMuted ? '1' : ''); } catch { /* ok */ }
  });

  function sendTypedMessage() {
    const text = textInput.value.trim();
    if (!text || isProcessing) return;
    textInput.value = '';
    // Route yes/no typed replies to the confirmation handler. Keep whatever
    // mode the pending flow is already in — don't switch voice/silent mid-confirm.
    if (currentState === STATES.CONFIRMING) {
      handleConfirmation(text.toLowerCase());
      return;
    }
    // A fresh typed message speaks its reply only when the voice feature is
    // currently on. Voice off → silent text chat (no TTS, mic stays shut);
    // voice on → Randy speaks the reply and keeps listening. isTypeModeActive
    // drives that split through the processing flow, so set it before handoff.
    const voiceActive = voiceEnabled || (currentState !== STATES.OFF && currentState !== STATES.PASSIVE);
    isTypeModeActive = !voiceActive;
    // Strip wake word prefix if present (e.g., "hey Randy, show me Nerdio" → "show me Nerdio")
    const lower = text.toLowerCase();
    const wakeMatch = lower.match(WAKE_PATTERN);
    if (wakeMatch) {
      const afterWake = text.substring(lower.indexOf('randy') + 5).trim();
      processUserInput(afterWake.length > 2 ? afterWake : text);
    } else {
      processUserInput(text);
    }
  }

  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendTypedMessage(); }
    if (e.key === 'Escape') { textInput.value = ''; textInput.blur(); }
  });
  sendBtn.addEventListener('click', sendTypedMessage);

  // Escape to exit fullscreen
  if (escapeHandler) document.removeEventListener('keydown', escapeHandler);
  escapeHandler = (e) => {
    if (e.key === 'Escape' && windowState === 'fullscreen') setWindowState('open');
  };
  document.addEventListener('keydown', escapeHandler);

  initDragging();
  initResizing();
}

// ── Single Voice Button Logic ─────────────────────────────────────
function handleVoiceBtnClick() {
  // Switching to voice cancels silent-typing mode so replies are spoken again.
  isTypeModeActive = false;

  switch (currentState) {
    case STATES.OFF:
    case STATES.PASSIVE:
      // Paused → start listening
      voiceEnabled = true;
      if (currentState === STATES.OFF) transition(STATES.PASSIVE);
      transition(STATES.ACTIVE_LISTENING);
      break;
    case STATES.ACTIVE_LISTENING:
      // Clear any pending auto-send
      if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
      // Listening → send accumulated transcript or pause
      removeInterimBubble();
      if (accumulatedTranscript.trim()) {
        const text = accumulatedTranscript.trim();
        accumulatedTranscript = '';
        processUserInput(text);
      } else {
        voiceEnabled = false;
        transition(STATES.PASSIVE, true);
      }
      break;
    case STATES.SPEAKING:
      // Speaking → interrupt and listen
      synth.cancel();
      speechChainCancelled = true;
      isRandySpeaking = false;
      currentSpokenText = '';
      currentSpeechOnComplete = null;
      voiceEnabled = true;
      currentState = STATES.ACTIVE_LISTENING;
      accumulatedTranscript = '';
      updateWidgetUI();
      startRecognition();
      break;
    case STATES.PROCESSING:
      // Processing → do nothing (brief moment)
      break;
    case STATES.CONFIRMING:
      // Confirming → pause
      voiceEnabled = false;
      pendingActions = null;
      if (confirmTimeout) { clearTimeout(confirmTimeout); confirmTimeout = null; }
      transition(STATES.PASSIVE, true);
      break;
  }
  updateVoiceButton();
}

function updateVoiceButton() {
  const btn = document.getElementById('randy-voice-btn');
  if (!btn) return;

  // Voice button: green fill when voice is selected mode (voiceEnabled or actively listening/speaking/processing/confirming)
  // listening pulse only during ACTIVE_LISTENING
  btn.className = 'randy-ctrl-btn';
  const voiceIsSelected = voiceEnabled || (currentState !== STATES.OFF && currentState !== STATES.PASSIVE);

  if (currentState === STATES.ACTIVE_LISTENING) {
    btn.classList.add('randy-ctrl-btn--voice-listening');
  } else if (voiceIsSelected && !isTypeModeActive) {
    btn.classList.add('randy-ctrl-btn--voice-active');
  }

  updateStatusBar();
}

function updateStatusBar() {
  const dot = document.getElementById('randy-status-dot');
  const label = document.getElementById('randy-status');
  if (!dot || !label) return;

  dot.className = 'randy-status-dot';
  label.className = 'randy-status-label';

  if (isMuted) {
    dot.classList.add('randy-status-dot--muted');
    label.classList.add('randy-status-label--muted');
    label.textContent = 'Muted';
    return;
  }

  switch (currentState) {
    case STATES.ACTIVE_LISTENING:
      dot.classList.add('randy-status-dot--listening');
      label.classList.add('randy-status-label--listening');
      label.textContent = 'Listening...';
      break;
    case STATES.PROCESSING:
      dot.classList.add('randy-status-dot--thinking');
      label.classList.add('randy-status-label--thinking');
      label.textContent = 'Thinking...';
      break;
    case STATES.SPEAKING:
      dot.classList.add('randy-status-dot--speaking');
      label.classList.add('randy-status-label--speaking');
      label.textContent = 'Speaking...';
      break;
    case STATES.CONFIRMING:
      dot.classList.add('randy-status-dot--listening');
      label.classList.add('randy-status-label--listening');
      label.textContent = 'Listening...';
      break;
    default:
      dot.classList.add('randy-status-dot--ready');
      label.classList.add('randy-status-label--ready');
      label.textContent = 'Ready';
  }
}

// ── Dragging ──────────────────────────────────────────────────────
function initDragging() {
  const titlebar = document.getElementById('randy-titlebar');
  const win = document.getElementById('randy-window');
  if (!titlebar || !win) return;

  // Double-click to toggle fullscreen
  titlebar.addEventListener('dblclick', () => {
    if (isDocked()) return; // docked page owns the layout — no fullscreen toggle
    setWindowState(windowState === 'fullscreen' ? 'open' : 'fullscreen');
  });

  titlebar.addEventListener('mousedown', (e) => {
    if (e.target.closest('.randy-window__ctrl')) return;
    if (isDocked()) return; // no dragging while docked into the page
    if (windowState === 'fullscreen') return;
    if (window.innerWidth <= 768) return; // No drag on mobile

    isDragging = true;
    const rect = win.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;

    const widget = document.getElementById('randy-widget');
    if (widget) widget.classList.add('randy--dragging');

    e.preventDefault();
  });

  // Clean up old document listeners before adding new ones
  if (dragMoveHandler) document.removeEventListener('mousemove', dragMoveHandler);
  if (dragUpHandler) document.removeEventListener('mouseup', dragUpHandler);

  dragMoveHandler = (e) => {
    if (!isDragging) return;
    const x = Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - 320));
    const y = Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - 100));

    win.style.position = 'fixed';
    win.style.left = x + 'px';
    win.style.top = y + 'px';
    win.style.bottom = 'auto';
    win.style.right = 'auto';
  };

  dragUpHandler = () => {
    if (!isDragging) return;
    isDragging = false;
    const widget = document.getElementById('randy-widget');
    if (widget) widget.classList.remove('randy--dragging');

    // Save position
    try {
      const stored = JSON.parse(localStorage.getItem('pp_randy_window') || '{}');
      stored.left = win.style.left;
      stored.top = win.style.top;
      localStorage.setItem('pp_randy_window', JSON.stringify(stored));
    } catch { /* ok */ }
  };

  document.addEventListener('mousemove', dragMoveHandler);
  document.addEventListener('mouseup', dragUpHandler);
}

// ── Resize Handles ───────────────────────────────────────────────
function initResizing() {
  const win = document.getElementById('randy-window');
  if (!win) return;

  const MIN_W = 300, MIN_H = 400;
  let isResizing = false;
  let startX, startY, startW, startH, startLeft, startTop;
  let resizeDir = '';

  function onStart(e) {
    if (isDocked()) return; // resize handles are hidden while docked
    if (windowState === 'fullscreen') return;
    if (window.innerWidth <= 768) return;

    const handle = e.target.closest('.randy-resize');
    if (!handle) return;

    e.preventDefault();
    e.stopPropagation();
    const pt = e.touches ? e.touches[0] : e;

    // Ensure explicit fixed positioning before resizing
    const rect = win.getBoundingClientRect();
    win.style.position = 'fixed';
    win.style.left = rect.left + 'px';
    win.style.top = rect.top + 'px';
    win.style.bottom = 'auto';
    win.style.right = 'auto';
    win.style.width = rect.width + 'px';
    win.style.height = rect.height + 'px';

    startX = pt.clientX;
    startY = pt.clientY;
    startW = rect.width;
    startH = rect.height;
    startLeft = rect.left;
    startTop = rect.top;
    resizeDir = handle.dataset.dir;
    isResizing = true;

    const widget = document.getElementById('randy-widget');
    if (widget) widget.classList.add('randy--resizing');
  }

  function onMove(e) {
    if (!isResizing) return;
    e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;

    let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;

    if (resizeDir.includes('e')) newW = startW + dx;
    if (resizeDir.includes('w')) { newW = startW - dx; newLeft = startLeft + dx; }
    if (resizeDir.includes('s')) newH = startH + dy;
    if (resizeDir.includes('n')) { newH = startH - dy; newTop = startTop + dy; }

    // Clamp to constraints
    newW = Math.max(MIN_W, Math.min(newW, window.innerWidth));
    newH = Math.max(MIN_H, Math.min(newH, window.innerHeight));

    // Adjust position when clamped on left/top edges
    if (resizeDir.includes('w')) newLeft = startLeft + startW - newW;
    if (resizeDir.includes('n')) newTop = startTop + startH - newH;

    // Keep within viewport
    newLeft = Math.max(0, newLeft);
    newTop = Math.max(0, newTop);

    win.style.width = newW + 'px';
    win.style.height = newH + 'px';
    win.style.left = newLeft + 'px';
    win.style.top = newTop + 'px';
  }

  function onEnd() {
    if (!isResizing) return;
    isResizing = false;

    const widget = document.getElementById('randy-widget');
    if (widget) widget.classList.remove('randy--resizing');

    // Persist size and position
    try {
      const stored = JSON.parse(localStorage.getItem('pp_randy_window') || '{}');
      stored.width = win.style.width;
      stored.height = win.style.height;
      stored.left = win.style.left;
      stored.top = win.style.top;
      localStorage.setItem('pp_randy_window', JSON.stringify(stored));
    } catch { /* ok */ }
  }

  win.addEventListener('mousedown', onStart);
  win.addEventListener('touchstart', onStart, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd);
}

function flashWidget() {
  const widget = document.getElementById('randy-widget');
  if (!widget) return;
  widget.classList.add('randy--flash');
  setTimeout(() => widget.classList.remove('randy--flash'), 150);
}

function showError(msg) {
  const el = document.getElementById('randy-error');
  const widget = document.getElementById('randy-widget');
  if (el) el.textContent = msg;
  if (widget) widget.classList.add('randy--error');
  setTimeout(hideError, 5000);
}

function hideError() {
  const widget = document.getElementById('randy-widget');
  if (widget) widget.classList.remove('randy--error');
}

// ── Initialization ────────────────────────────────────────────────
export function initRandy() {
  if (mounted) return;
  if (!hasVoiceSupport()) return;

  createWidget();

  // Load voices (may be async)
  selectVoice();
  if (synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = selectVoice;
  }

  // Randy starts fully OFF — the microphone is NOT opened on load, so there
  // is no always-on recording indicator and no contention with the chat
  // voice widget or field dictation. The mic opens ONLY while the voice
  // feature is actively on, and closes the moment the user toggles voice off
  // (the browser recording indicator tracks it exactly). Randy begins
  // listening only when the user explicitly activates it: the Voice button or
  // the Alt+Z shortcut. There is no background wake-word listening — that
  // would require keeping the mic open while voice is off.
  currentState = STATES.OFF;
  updateWidgetUI();

  // Restore mute state
  if (localStorage.getItem('pp_randy_muted') === '1') {
    isMuted = true;
    const muteBtn = document.getElementById('randy-mute-btn');
    if (muteBtn) {
      muteBtn.innerHTML = MUTED_SVG;
      muteBtn.classList.add('randy-ctrl-btn--muted');
      muteBtn.setAttribute('aria-label', 'Unmute voice');
    }
    updateStatusBar();
  }

  // Restore window position and size
  try {
    const winData = JSON.parse(localStorage.getItem('pp_randy_window') || '{}');
    const win = document.getElementById('randy-window');
    if (win && winData.left) {
      win.style.position = 'fixed';
      win.style.left = winData.left;
      win.style.top = winData.top;
      win.style.bottom = 'auto';
      win.style.right = 'auto';
    }
    if (win && winData.width) {
      win.style.width = winData.width;
      win.style.height = winData.height;
    }
  } catch { /* ok */ }

  // Reload presets whenever they are saved from the Setup page
  window.addEventListener('custom-prompts-changed', () => {
    loadCustomPrompts().then(p => {
      loadedPresets = Array.isArray(p) ? p : [];
      if (windowState === 'open') renderPresets();
      notifyPresetChange();
    }).catch(() => {});
  });

  // Allow voice-widget (which cannot import us without creating a cycle) to
  // temporarily pause and resume Randy's microphone while it owns the mic.
  window._randyPause = () => {
    if (recognition && currentState !== STATES.OFF) {
      try { recognition.stop(); } catch { /* ok */ }
    }
  };
  window._randyResume = () => {
    if (currentState === STATES.PASSIVE || currentState === STATES.ACTIVE_LISTENING) {
      scheduleRestart();
    }
  };

  // Public API for keyboard shortcut: open Randy window and start voice.
  window.activateRandy = () => {
    if (!mounted) return;
    if (windowState === 'collapsed') {
      setWindowState('open');
      if (conversationHistory.length === 0) showWelcome();
      updateVoiceButton();
    }
    handleVoiceBtnClick();
  };

  mounted = true;
}
