// Regression tests for the dedicated Randy page's preset selection menu.
//
// The feature: the Randy page (views/admin-randy-page.js) shows a preset
// <select> as a header above the docked chat. Choosing a preset drives the
// SAME activePresetId state the widget's built-in Mode dropdown uses, so
// Randy responds with that preset's custom instructions.
//
// randy.js is not importable under Node (module-level speech-synthesis /
// deep DOM import graph), so — matching randy-voice-controls.test.mjs and
// randy-html-marker.test.mjs — we lock the contract with source assertions.
// If a future edit breaks a wiring point, the matching case here fails.

import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const randySrc = await readFile(new URL('../js/components/randy.js', import.meta.url), 'utf8');
const pageSrc = await readFile(new URL('../js/views/admin-randy-page.js', import.meta.url), 'utf8');
const cssSrc = await readFile(new URL('../css/randy.css', import.meta.url), 'utf8');

test('randy.js exposes a public preset API for the Randy page', () => {
  for (const sym of [
    'export function getRandyPresets',
    'export function getActiveRandyPresetId',
    'export function setActiveRandyPreset',
    'export function ensureRandyPresetsLoaded',
    'export const RANDY_PRESET_COLORS',
  ]) {
    assert.ok(randySrc.includes(sym), `randy.js must ${sym}`);
  }
});

test('setActiveRandyPreset routes through the shared selectPreset state', () => {
  // The page must not maintain its own copy of the active preset — it must
  // drive selectPreset so the response path (activeMode) sees the change.
  const m = randySrc.match(/export function setActiveRandyPreset\([^)]*\)\s*{([^}]*)}/);
  assert.ok(m, 'setActiveRandyPreset must be defined');
  assert.ok(/selectPreset\(/.test(m[1]),
    'setActiveRandyPreset must call selectPreset so Randy uses the preset instructions');
});

test('preset changes notify external menus so the page select re-syncs', () => {
  assert.ok(randySrc.includes("new CustomEvent('randy-preset-changed')"),
    'a randy-preset-changed event must be dispatched');
  // selectPreset (the mutation point) must notify after re-rendering.
  assert.ok(/renderPresets\(\);\s*notifyPresetChange\(\);/.test(randySrc),
    'selectPreset must call notifyPresetChange() after renderPresets()');
});

test('the Randy page renders a preset <select> menu wired to the preset API', () => {
  assert.ok(/from '\.\.\/components\/randy\.js'/.test(pageSrc), 'page imports randy.js');
  for (const sym of ['getRandyPresets', 'getActiveRandyPresetId', 'setActiveRandyPreset',
    'ensureRandyPresetsLoaded', 'RANDY_PRESET_COLORS']) {
    assert.ok(pageSrc.includes(sym), `page must import/use ${sym}`);
  }
  assert.ok(pageSrc.includes("createElement('select')"), 'page must build a <select>');
  assert.ok(pageSrc.includes("'randy-preset-select'"), 'the select must carry the expected id');
});

test('selecting a preset on the page applies it (change → setActiveRandyPreset)', () => {
  assert.ok(/addEventListener\('change'[\s\S]*?setActiveRandyPreset\(/.test(pageSrc),
    'the select change handler must call setActiveRandyPreset');
});

test('the page keeps the menu in sync and cleans up its listeners', () => {
  assert.ok(pageSrc.includes("addEventListener('randy-preset-changed'"),
    'page must listen for randy-preset-changed');
  assert.ok(pageSrc.includes("removeEventListener('randy-preset-changed'"),
    'cleanup must detach the randy-preset-changed listener');
});

test('the docked widget mounts in its own host so the header can sit above it', () => {
  assert.ok(pageSrc.includes('randy-page__widget-host'), 'page must create a widget host');
  assert.ok(/dockRandy\(widgetHost\)/.test(pageSrc), 'the widget must dock into that host');
});

test('CSS provides the preset bar and hides the redundant Mode pill while docked', () => {
  assert.ok(cssSrc.includes('.randy-preset-bar'), 'preset bar styles must exist');
  assert.ok(cssSrc.includes('.randy-page__widget-host'), 'widget host styles must exist');
  assert.ok(/\.randy--docked\s+\.randy-btn-wrap--mode\s*{[^}]*display:\s*none/.test(cssSrc),
    'the small Mode pill must be hidden while docked (the header replaces it)');
});
