// ============================================================
// AI preset provider (Anthropic ↔ Kimi) — routing + wiring tests
// ============================================================
// The feature: each Randy preset carries a `provider` (anthropic | kimi).
// When a preset is active, callClaudeStream routes to that backend —
// Anthropic direct-from-browser (existing) or Kimi via the Apps Script
// proxy (action: 'kimiChat'). Anthropic stays the default.
//
// ai.js and ai-providers.js import cleanly under Node (see _setup.mjs), so
// the routing is exercised for real by mocking globalThis.fetch. The DOM /
// speech modules (randy.js, admin-setup.js) and Apps Script / sheets schema
// are locked with source assertions, matching randy-preset-menu.test.mjs.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AI_PROVIDERS, DEFAULT_AI_PROVIDER, normalizeProvider, providerLabel,
} from '../js/utils/ai-providers.js';
import { CONFIG } from '../js/config.js';

const ai = await import('../js/utils/ai.js');

// ── helpers ────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
function setRuntimeConfig(obj) {
  globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify(obj));
}
// Minimal, valid sheetData for the non-simple context path.
function emptySheetData() {
  return {
    partners: [], opportunities: [], events: [], meetingIndex: [],
    transcriptIndex: [], oppDescriptionIndex: [], fullOppDescriptions: [],
    fullTranscripts: [],
  };
}
// Fake Anthropic SSE stream that emits one text delta then closes.
function fakeAnthropicStream(text) {
  const encoder = new TextEncoder();
  const frames = [
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`,
  ];
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < frames.length
          ? { value: encoder.encode(frames[i++]), done: false }
          : { value: undefined, done: true }),
        releaseLock: () => {},
      }),
    },
  };
}

// ── 1. Provider constants / normalization ──────────────────────────

test('DEFAULT_AI_PROVIDER is anthropic and both backends are offered', () => {
  assert.equal(DEFAULT_AI_PROVIDER, 'anthropic');
  const ids = AI_PROVIDERS.map(p => p.id);
  assert.deepEqual(ids, ['anthropic', 'kimi']);
});

test('normalizeProvider defaults anything unknown/empty/legacy to anthropic', () => {
  assert.equal(normalizeProvider('kimi'), 'kimi');
  assert.equal(normalizeProvider('KIMI'), 'kimi');
  assert.equal(normalizeProvider('  Kimi '), 'kimi');
  assert.equal(normalizeProvider('anthropic'), 'anthropic');
  assert.equal(normalizeProvider(''), 'anthropic');
  assert.equal(normalizeProvider(undefined), 'anthropic');
  assert.equal(normalizeProvider(null), 'anthropic');
  assert.equal(normalizeProvider('gpt-4'), 'anthropic');
  assert.equal(providerLabel('kimi'), 'Kimi');
  assert.equal(providerLabel('anythingelse'), 'Anthropic');
});

// ── 2. Kimi routing goes through the Apps Script proxy ─────────────

test('a kimi preset routes to the Apps Script proxy with an OpenAI-style payload', async () => {
  setRuntimeConfig({}); // deliberately NO Anthropic key — kimi must not need it
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'KIMI REPLY' }) };
  };

  const chunks = [];
  try {
    const out = await ai.callClaudeStream(
      [{ role: 'user', content: 'hi' }],
      emptySheetData(),
      'hi',                       // greeting → "simple" tier (no data corpus)
      null,
      'BASE SYSTEM PROMPT',
      (chunk) => chunks.push(chunk),
      { provider: 'kimi', label: 'Deal Analyst', instructions: 'Be terse.' },
    );
    assert.equal(out, 'KIMI REPLY');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Routed to the proxy — NOT to Anthropic.
  assert.equal(captured.url, CONFIG.FILE_API_URL);
  assert.ok(!String(captured.url).includes('api.anthropic.com'));

  const body = JSON.parse(captured.opts.body);
  assert.equal(body.action, 'kimiChat');
  assert.equal(body.model, 'kimi-k3');
  // kimi-k3 locks its sampling params (temperature fixed at 1.0) and requires
  // them to be omitted, so the client must send NO temperature at all.
  assert.ok(!('temperature' in body), 'kimi-k3 payload must omit temperature');
  assert.equal(body.max_tokens, 800); // simple tier budget
  assert.ok(Array.isArray(body.messages));
  // OpenAI shape: a leading system message carrying the base prompt + the
  // active-mode block, then the user turn.
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.includes('BASE SYSTEM PROMPT'));
  assert.ok(body.messages[0].content.includes('Be terse.'));
  assert.equal(body.messages[body.messages.length - 1].role, 'user');

  // Single-shot delivery preserves the streaming contract.
  assert.deepEqual(chunks, ['KIMI REPLY']);
});

test('kimi payload embeds the sheet DATA CONTEXT for non-simple queries', async () => {
  setRuntimeConfig({});
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ ok: true, text: 'ok' }) };
  };
  try {
    await ai.callClaudeStream(
      [{ role: 'user', content: 'give me the full pipeline status and revenue summary' }],
      emptySheetData(),
      'give me the full pipeline status and revenue summary',
      null,
      'SYS',
      () => {},
      { provider: 'kimi', label: 'Analyzer', instructions: 'Analyze.' },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  const body = JSON.parse(captured.opts.body);
  const userTurn = body.messages[body.messages.length - 1].content;
  assert.ok(userTurn.includes('DATA CONTEXT'), 'the data corpus must be inlined for Kimi');
  assert.ok(body.max_tokens >= 4000, 'non-simple query gets a larger token budget');
});

// ── 3. Default / Anthropic routing is unchanged ────────────────────

test('no preset (or an anthropic preset) still calls Anthropic directly', async () => {
  setRuntimeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(url); return fakeAnthropicStream('CLAUDE REPLY'); };

  const chunks = [];
  try {
    const out = await ai.callClaudeStream(
      [{ role: 'user', content: 'hi' }], emptySheetData(), 'hi', null, 'SYS',
      (c) => chunks.push(c),
      { provider: 'anthropic', label: 'Partner', instructions: 'x' },
    );
    assert.equal(out, 'CLAUDE REPLY');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen[0].includes('api.anthropic.com'), 'anthropic preset must hit the Anthropic API');
  assert.deepEqual(chunks, ['CLAUDE REPLY']);
});

test('callKimiStream is exported for the routing dispatch', () => {
  assert.equal(typeof ai.callKimiStream, 'function');
});

// ── 4. Persistence: Custom_Prompts carries a provider column ───────

test('sheets.js persists and normalizes the provider column', async () => {
  const src = await readFile(new URL('../js/sheets.js', import.meta.url), 'utf8');
  assert.ok(
    /SHEET_CUSTOM_PROMPTS\]:\s*\['prompt_id',\s*'label',\s*'icon',\s*'instructions',\s*'created_at',\s*'provider'\]/.test(src),
    'Custom_Prompts header must include a provider column',
  );
  assert.ok(
    /saveCustomPrompt\(promptId, label, icon, instructions, provider\)/.test(src),
    'saveCustomPrompt must accept a provider argument',
  );
  assert.ok(/normalizeProvider\(provider\)/.test(src), 'saved provider must be normalized');
  assert.ok(
    /rows\.map\(r => \(\{ \.\.\.r, provider: normalizeProvider\(r\.provider\) \}\)\)/.test(src),
    'loadCustomPrompts must normalize the provider on read',
  );
  assert.ok(/normalizeProvider\(p\.provider\)/.test(src), 'reorder must persist the provider');
});

// ── 5. Randy carries the active preset's provider into activeMode ──

test('randy.js includes provider in the activeMode it passes to callClaudeStream', async () => {
  const src = await readFile(new URL('../js/components/randy.js', import.meta.url), 'utf8');
  assert.ok(/provider:\s*activePreset\.provider/.test(src),
    'activeMode must carry activePreset.provider');
});

// ── 6. Setup view renders the provider slider and saves it ─────────

test('admin-setup.js renders a provider slider and persists the choice', async () => {
  const src = await readFile(new URL('../js/views/admin-setup.js', import.meta.url), 'utf8');
  assert.ok(/from '\.\.\/utils\/ai-providers\.js'/.test(src), 'setup imports the provider module');
  assert.ok(/function buildProviderSlider\(/.test(src), 'setup builds a provider slider');
  assert.ok(/class:\s*'provider-slider'/.test(src), 'the slider uses the provider-slider class');
  assert.ok(/const provider = providerSlider\.get\(\)/.test(src), 'save reads the slider value');
  // The id is generated up front for new presets (see admin-setup.js —
  // guessing the label as the id afterwards created duplicate rows), so the
  // call passes promptId rather than `preset.prompt_id || null`.
  assert.ok(
    /saveCustomPrompt\(promptId, label, icon, instructions, provider\)/.test(src),
    'save passes the provider to saveCustomPrompt',
  );
});

test('the provider-slider has styles in components.css', async () => {
  const css = await readFile(new URL('../css/components.css', import.meta.url), 'utf8');
  assert.ok(/\.provider-slider\s*\{/.test(css), 'provider-slider must be styled');
  assert.ok(/\.provider-slider__opt\.is-active/.test(css), 'active option must have a thumb style');
});

// ── 7. Apps Script proxy contract ──────────────────────────────────

test('Apps Script exposes the kimiChat proxy and reports Kimi presence', async () => {
  const src = await readFile(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.ok(/KIMI_API_KEY = PropertiesService/.test(src), 'reads the KIMI_API_KEY property');
  assert.ok(/action === 'kimiChat'/.test(src), 'dispatches the kimiChat action');
  assert.ok(/function doKimiChat\(payload\)/.test(src), 'defines doKimiChat');
  assert.ok(/api\.moonshot\.ai\/v1\/chat\/completions/.test(src), 'calls the Moonshot endpoint');
  assert.ok(/hasKimiKey:\s*!!KIMI_API_KEY/.test(src), 'getConfig reports hasKimiKey');
});
