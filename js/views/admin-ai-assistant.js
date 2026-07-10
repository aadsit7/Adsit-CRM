// ============================================
// AI Assistant Chat View — Split Screen
// ============================================
// Left: chat with Claude. Right: conversation history.
// Supports voice, write actions, and sheet persistence.

import { CONFIG, getRuntimeConfig, setRuntimeConfig } from '../config.js';
import { setTopbarTitle } from '../components/sidebar.js';
import { loadSheetData, callClaudeStream, invalidateSheetCache } from '../utils/ai.js';
import { parseActions, executeAction } from '../utils/ai-actions.js';
import { activateVoiceMode, isVoiceModeActive, stopEverything as stopVoice } from '../components/voice-widget.js';
import { attachSpeakerButton, autoSpeak, stopTTS, createSettingsButton, isTTSEnabled, extractVoiceText, extractVoiceTextFromString, isAutoSpeakEnabled, speak, cleanTextForSpeech } from '../components/tts.js';
import { getCurrentUser } from '../auth.js';
import { appendRow, updateRow, deleteRow, readSheetAsObjects } from '../sheets.js';
import { showToast } from '../components/toast.js';

// ── State ──────────────────────────────────────────────────────────
let conversationHistory = [];
let isStreaming = false;
let abortController = null;
let currentConversationId = null;
let currentConversationRow = null;
let conversations = [];

// ── Voice Mode ─────────────────────────────────────────────────────
function toggleVoice() {
  if (isVoiceModeActive()) { stopVoice(); return; }
  activateVoiceMode();
}

// ── Markdown Renderer ──────────────────────────────────────────────
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
    .replace(/<p><(h[234]|ul|li|hr)/g, '<$1')
    .replace(/<\/(h[234]|ul|li)><\/p>/g, '</$1>')
    .replace(/<hr><\/p>/g, '<hr>');
}

// ── HTML Response Detection & Sanitization ────────────────────────
function containsHTMLResponse(text) {
  return text.includes('class="response-container"') || text.includes("class='response-container'");
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
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

// ── Chat Message Rendering ─────────────────────────────────────────
function renderMessage(role, text, container) {
  const isUser = role === 'user';
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message ${isUser ? 'chat-user' : 'chat-assistant'}`;
  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = isUser ? 'AA' : 'C';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (isUser) {
    bubble.innerHTML = `<p>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
  } else if (containsHTMLResponse(text)) {
    bubble.innerHTML = sanitizeHTML(text);
  } else {
    bubble.innerHTML = renderMarkdown(text);
  }
  if (isUser) { wrapper.appendChild(bubble); wrapper.appendChild(avatar); }
  else {
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    // Attach TTS speaker button to assistant messages — prefer voice-tagged summary text
    if (isTTSEnabled()) {
      const voiceText = extractVoiceText(bubble) || text;
      attachSpeakerButton(bubble, voiceText);
    }
  }
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
  return bubble;
}
window._aiChatRenderMessage = renderMessage;

function renderLoading(container) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-message chat-assistant';
  wrapper.id = 'chat-loading';
  const avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.textContent = 'C';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-loading-bubble';
  bubble.innerHTML = `<div class="chat-loading-dots"><span></span><span></span><span></span></div><span class="chat-loading-text">Reading your sheets...</span>`;
  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
}

function removeLoading() {
  const el = document.getElementById('chat-loading');
  if (el) el.remove();
}

function renderConfirmationCard(action, container) {
  const icons = { update: '✏️', create: '➕', delete: '🗑️' };
  const card = document.createElement('div');
  card.className = 'action-card';
  card.innerHTML = `
    <div class="action-card__header">
      <div class="action-card__icon">${icons[action.type] || '⚡'}</div>
      <div class="action-card__summary">${(action.summary || '').replace(/</g, '&lt;')}</div>
    </div>
    <div class="action-card__detail">${action.sheet} · ${action.type} · ${JSON.stringify(action.row_match || {})}</div>
    <div class="action-card__buttons">
      <button class="action-card__confirm">Confirm</button>
      <button class="action-card__cancel">Cancel</button>
    </div>
  `;
  const confirmBtn = card.querySelector('.action-card__confirm');
  const cancelBtn = card.querySelector('.action-card__cancel');
  const buttonsDiv = card.querySelector('.action-card__buttons');

  confirmBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Applying...';
    try {
      await executeAction(action);
      buttonsDiv.innerHTML = '<div class="action-card__status action-card__status--applied">✓ Applied</div>';
      showToast('Change applied successfully', 'success');
    } catch (err) {
      buttonsDiv.innerHTML = `<div class="action-card__status action-card__status--cancelled">✗ Failed: ${err.message}</div>`;
      showToast(err.message, 'error');
    }
  });

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    buttonsDiv.innerHTML = '<div class="action-card__status action-card__status--cancelled">✗ Cancelled</div>';
  });

  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
}

// ── Save Indicator ─────────────────────────────────────────────────
function flashSave(success = true) {
  const el = document.getElementById('ai-save-indicator');
  if (!el) return;
  el.textContent = success ? 'Saved ✓' : 'Save failed';
  el.className = `ai-save-indicator visible${success ? '' : ' error'}`;
  setTimeout(() => { el.className = 'ai-save-indicator'; }, 2000);
}

// ── Conversation Persistence ───────────────────────────────────────
async function loadConversations() {
  try {
    const all = await readSheetAsObjects(CONFIG.SHEET_AI_CONVERSATIONS);
    const user = getCurrentUser();
    conversations = all
      .filter(c => c.username === (user?.username || ''))
      .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  } catch {
    conversations = [];
  }
  renderHistoryList();
}

async function saveConversation(isNew) {
  const user = getCurrentUser();
  if (!user) return;

  const messagesWithTs = conversationHistory.map(m => ({
    ...m,
    timestamp: m.timestamp || new Date().toISOString()
  }));
  const title = (conversationHistory.find(m => m.role === 'user')?.content || '').substring(0, 60);
  const messagesJson = JSON.stringify(messagesWithTs);

  try {
    if (isNew) {
      currentConversationId = 'conv_' + Date.now();
      const values = [currentConversationId, user.username, new Date().toISOString(), title, messagesJson, 'active'];
      await appendRow(CONFIG.SHEET_AI_CONVERSATIONS, values);
      // Read back to get _rowIndex
      const all = await readSheetAsObjects(CONFIG.SHEET_AI_CONVERSATIONS);
      const saved = all.find(c => c.conversation_id === currentConversationId);
      currentConversationRow = saved?._rowIndex || null;
      conversations.unshift(saved || { conversation_id: currentConversationId, title, started_at: new Date().toISOString(), messages: messagesJson, _rowIndex: currentConversationRow });
    } else if (currentConversationRow) {
      const conv = conversations.find(c => c.conversation_id === currentConversationId);
      const values = [currentConversationId, user.username, conv?.started_at || '', title, messagesJson, 'active'];
      await updateRow(CONFIG.SHEET_AI_CONVERSATIONS, currentConversationRow, values);
      if (conv) { conv.messages = messagesJson; conv.title = title; }
    }
    flashSave(true);
    renderHistoryList();
  } catch (err) {
    console.error('Save conversation failed:', err);
    flashSave(false);
  }
}

async function deleteConversation(convId, rowIndex) {
  try {
    await deleteRow(CONFIG.SHEET_AI_CONVERSATIONS, rowIndex);
    conversations = conversations.filter(c => c.conversation_id !== convId);
    if (currentConversationId === convId) startNewChat();
    renderHistoryList();
    showToast('Conversation deleted', 'success');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

function loadConversation(conv) {
  try {
    const msgs = JSON.parse(conv.messages || '[]');
    conversationHistory = msgs;
    currentConversationId = conv.conversation_id;
    currentConversationRow = conv._rowIndex;

    const chatArea = document.getElementById('ai-chat-area');
    if (!chatArea) return;
    chatArea.innerHTML = '';
    msgs.forEach(m => renderMessage(m.role, m.content, chatArea));
    renderHistoryList();
  } catch (err) {
    console.error('Failed to load conversation:', err);
  }
}

function startNewChat() {
  conversationHistory = [];
  currentConversationId = null;
  currentConversationRow = null;
  const chatArea = document.getElementById('ai-chat-area');
  if (chatArea) {
    chatArea.innerHTML = `
      <div class="ai-welcome">
        <div class="ai-welcome-icon">💬</div>
        <h3>Ask me anything about your partners, deals, events, or meetings</h3>
        <p>I read your Google Sheet live — Partners, Opportunities, Events, Transcripts, and Meeting Index.</p>
      </div>`;
  }
  renderHistoryList();
}

// ── History Panel ──────────────────────────────────────────────────
function renderHistoryList(filter = '') {
  const list = document.getElementById('ai-history-list');
  if (!list) return;
  list.innerHTML = '';

  const filtered = filter
    ? conversations.filter(c => (c.title || '').toLowerCase().includes(filter.toLowerCase()))
    : conversations;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="ai-history-empty">No conversations yet</div>';
    return;
  }

  filtered.forEach(conv => {
    let msgs = [];
    try { msgs = JSON.parse(conv.messages || '[]'); } catch { /* ignore */ }
    const firstReply = msgs.find(m => m.role === 'assistant');
    const preview = firstReply ? firstReply.content.substring(0, 100) + '...' : '';
    const date = conv.started_at ? new Date(conv.started_at).toLocaleDateString() : '';

    const card = document.createElement('div');
    card.className = `ai-history-card${conv.conversation_id === currentConversationId ? ' active' : ''}`;
    card.innerHTML = `
      <div class="ai-history-card__title">${(conv.title || 'Untitled').replace(/</g, '&lt;')}</div>
      <div class="ai-history-card__meta">${date} · ${msgs.length} messages</div>
      <div class="ai-history-card__preview">${preview.replace(/</g, '&lt;')}</div>
      <button class="ai-history-card__delete" title="Delete">×</button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.ai-history-card__delete')) return;
      loadConversation(conv);
    });
    card.querySelector('.ai-history-card__delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(conv.conversation_id, conv._rowIndex);
    });
    list.appendChild(card);
  });
}

// ── Main Render ────────────────────────────────────────────────────
export function renderAdminAIAssistant(container) {
  setTopbarTitle('Randy');

  const view = container || document.getElementById('view-container') || document.querySelector('main');
  if (!view) return;

  conversationHistory = [];
  currentConversationId = null;
  currentConversationRow = null;

  const hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  view.innerHTML = `
    <div class="ai-assistant-container">
      <div class="ai-header">
        <div class="ai-header-left">
          <div class="ai-header-icon"><img src="assets/randy-avatar.png" alt="Randy" style="width:46px;height:46px;object-fit:contain;"></div>
          <div>
            <h2 class="ai-header-title">Randy Assistant <span id="ai-save-indicator" class="ai-save-indicator"></span></h2>
            <p class="ai-header-sub">Connected to your Partner Portal database via Google Sheets</p>
          </div>
        </div>
        <div class="ai-header-actions">
          <button class="ai-refresh-btn" id="ai-api-key" title="Set API key" style="${getRuntimeConfig('ANTHROPIC_API_KEY') ? '' : 'color:#dc2626;'}">🔑</button>
          <button class="ai-refresh-btn" id="ai-refresh" title="Refresh sheet data">↻</button>
          <button class="ai-clear-btn" id="ai-clear">Clear Chat</button>
        </div>
      </div>

      <div class="ai-mobile-toggle" id="ai-mobile-toggle">
        <button class="active" data-panel="chat">Chat</button>
        <button data-panel="history">History</button>
      </div>

      <div class="ai-chat-panel" id="ai-chat-panel">
        <div class="ai-chat-area" id="ai-chat-area">
          <div class="ai-welcome">
            <div class="ai-welcome-icon">💬</div>
            <h3>Ask me anything about your partners, deals, events, or meetings</h3>
            <p>I read your Google Sheet live — Partners, Opportunities, Events, Transcripts, and Meeting Index.</p>
          </div>
        </div>
      </div>

      <div class="ai-history-panel" id="ai-history-panel">
        <div class="ai-history-header">
          <div class="ai-history-header__top">
            <h3 class="ai-history-header__title">History</h3>
            <button class="ai-history-new-btn" id="ai-new-chat">+ New Chat</button>
          </div>
          <input type="text" class="ai-history-search" id="ai-history-search" placeholder="Search conversations...">
        </div>
        <div class="ai-history-list" id="ai-history-list">
          <div class="ai-history-empty">Loading...</div>
        </div>
      </div>

      <div class="ai-input-area" id="ai-input-area">
        <div class="ai-input-wrapper">
          ${hasSpeech ? `
          <button class="ai-mic-btn" id="ai-mic" title="Voice input">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
          </button>
          ` : ''}
          <textarea id="ai-input" placeholder="Ask about partners, pipeline, meetings, events..." rows="1" maxlength="2000"></textarea>
          <button class="ai-send-btn" id="ai-send" disabled>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
        <p class="ai-disclaimer">AI responses are based on your Google Sheet data. Verify critical details before acting.</p>
      </div>
    </div>
  `;

  // ── Event Listeners ────────────────────────────────────────────
  const input = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    sendBtn.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (input.value.trim()) handleSend(); }
  });
  sendBtn.addEventListener('click', handleSend);

  const micBtn = document.getElementById('ai-mic');
  if (micBtn) micBtn.addEventListener('click', toggleVoice);

  // Insert TTS settings gear next to the input buttons
  const inputWrapper = document.querySelector('.ai-input-wrapper');
  if (inputWrapper) {
    const ttsSettings = createSettingsButton();
    inputWrapper.insertBefore(ttsSettings, inputWrapper.querySelector('textarea'));
  }

  document.addEventListener('keydown', handleKeyShortcut);

  document.getElementById('ai-clear').addEventListener('click', startNewChat);
  document.getElementById('ai-new-chat').addEventListener('click', startNewChat);

  document.getElementById('ai-api-key').addEventListener('click', () => {
    const current = getRuntimeConfig('ANTHROPIC_API_KEY');
    const key = prompt('Enter your Anthropic API key (copy from Setup page):', current || '');
    if (key !== null) {
      setRuntimeConfig('ANTHROPIC_API_KEY', key.trim());
      document.getElementById('ai-api-key').style.color = key.trim() ? '' : '#dc2626';
    }
  });

  document.getElementById('ai-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('ai-refresh');
    btn.disabled = true; btn.textContent = '⟳';
    try { await loadSheetData(true); btn.textContent = '✓'; }
    catch { btn.textContent = '✗'; }
    setTimeout(() => { btn.textContent = '↻'; btn.disabled = false; }, 1500);
  });

  // History search
  document.getElementById('ai-history-search').addEventListener('input', (e) => {
    renderHistoryList(e.target.value);
  });

  // Mobile toggle
  document.getElementById('ai-mobile-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const panel = btn.dataset.panel;
    document.querySelectorAll('#ai-mobile-toggle button').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('ai-chat-panel').classList.toggle('mobile-hidden', panel === 'history');
    document.getElementById('ai-input-area').classList.toggle('mobile-hidden', panel === 'history');
    document.getElementById('ai-history-panel').classList.toggle('mobile-visible', panel === 'history');
  });

  // Pre-load
  loadSheetData().catch(() => {});
  loadConversations();
}

function handleKeyShortcut(e) {
  if (e.key === 'm' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    toggleVoice();
  }
}

async function handleSend() {
  const input = document.getElementById('ai-input');
  const chatArea = document.getElementById('ai-chat-area');
  const text = input.value.trim();
  if (!text || isStreaming) return;

  const welcome = chatArea.querySelector('.ai-welcome');
  if (welcome) welcome.remove();

  renderMessage('user', text, chatArea);
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('ai-send').disabled = true;

  const isNewConversation = conversationHistory.length === 0;
  conversationHistory.push({ role: 'user', content: text, timestamp: new Date().toISOString() });

  renderLoading(chatArea);
  isStreaming = true;

  let streamingWrapper = null;
  let streamingBubble = null;

  try {
    const sheetData = await loadSheetData();
    const loadingText = document.querySelector('.chat-loading-text');
    if (loadingText) loadingText.textContent = 'Thinking...';

    abortController = new AbortController();

    const onChunk = (_chunk, accumulated) => {
      if (!streamingBubble) {
        removeLoading();
        streamingWrapper = document.createElement('div');
        streamingWrapper.className = 'chat-message chat-assistant';
        const avatar = document.createElement('div');
        avatar.className = 'chat-avatar';
        avatar.textContent = 'C';
        streamingBubble = document.createElement('div');
        streamingBubble.className = 'chat-bubble';
        streamingWrapper.appendChild(avatar);
        streamingWrapper.appendChild(streamingBubble);
        chatArea.appendChild(streamingWrapper);
      }
      // Strip complete and partial action blocks so raw JSON never shows
      const displayText = accumulated
        .replace(/:::ACTION[\s\S]*?:::/g, '')
        .replace(/:::ACTION[\s\S]*$/, '')
        .trim();
      if (displayText) {
        streamingBubble.innerHTML = renderMarkdown(displayText);
        chatArea.scrollTop = chatArea.scrollHeight;
      }
    };

    const response = await callClaudeStream(conversationHistory, sheetData, text, abortController.signal, null, onChunk);

    // Replace live streaming bubble with the final rendered message
    if (streamingWrapper) { streamingWrapper.remove(); streamingWrapper = null; streamingBubble = null; }
    removeLoading();

    const { cleanText, actions } = parseActions(response);

    // Speak summary immediately BEFORE rendering — don't wait for DOM
    if (isTTSEnabled() && isAutoSpeakEnabled()) {
      const earlyVoice = extractVoiceTextFromString(cleanText) || cleanTextForSpeech(cleanText);
      if (earlyVoice) speak(earlyVoice);
    }

    renderMessage('assistant', cleanText, chatArea);
    conversationHistory.push({ role: 'assistant', content: response, timestamp: new Date().toISOString() });

    actions.forEach(action => renderConfirmationCard(action, chatArea));

    await saveConversation(isNewConversation);
  } catch (err) {
    if (streamingWrapper) { streamingWrapper.remove(); streamingWrapper = null; streamingBubble = null; }
    removeLoading();
    // Roll back orphaned user message so the next turn starts clean
    if (conversationHistory.length > 0 && conversationHistory[conversationHistory.length - 1].role === 'user') {
      conversationHistory.pop();
    }
    if (err.name === 'AbortError') return;
    renderMessage('assistant',
      `**Error:** ${err.message}\n\nMake sure your Google Sheet connection is working (check Setup page) and your API key is configured.`,
      chatArea
    );
  } finally {
    isStreaming = false;
  }
}

export function cleanupAdminAIAssistant() {
  if (abortController) abortController.abort();
  stopTTS();
  document.removeEventListener('keydown', handleKeyShortcut);
  isStreaming = false;
}
