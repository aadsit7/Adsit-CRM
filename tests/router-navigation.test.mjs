// Tests for the SPA router's rapid-navigation behavior (js/router.js).
//
// Renders are async — every view awaits at least one sheet read before it
// fills the container — so a second navigation can arrive while the previous
// route's render is still in flight. The router serializes hash handling
// (latest-wins) so a superseded render can never stomp the newer view's DOM
// or leave the WRONG cleanup registered for the next navigation. These tests
// lock that in by driving two overlapping navigations and asserting the
// slower, superseded render never lands.

import './_setup.mjs'; // shims localStorage + document for the module imports
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../js/config.js';

// ---- Browser-environment shims ----
//
// The router needs: window.location.hash (writes fire hashchange, async like
// a real browser), window.addEventListener/dispatchEvent, CustomEvent,
// document.getElementById('view-container'), and document.title.

function setupBrowser() {
  const listeners = new Map(); // type -> Set<fn>
  let hash = '';
  globalThis.window = {
    location: {
      get hash() { return hash; },
      set hash(v) {
        const next = String(v).startsWith('#') ? String(v) : `#${v}`;
        if (next === hash) return;
        hash = next;
        // Browsers fire hashchange as a task after the assignment; a
        // microtask keeps tests deterministic without timers.
        queueMicrotask(() => {
          for (const fn of listeners.get('hashchange') || []) fn();
        });
      },
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
    dispatchEvent: () => true,
  };
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  }

  const container = { innerHTML: '' };
  globalThis.document.getElementById = (id) => (id === 'view-container' ? container : null);
  if (!('title' in globalThis.document)) globalThis.document.title = '';

  localStorage.clear();
  // A session so the auth guard doesn't bounce everything to /login. The
  // test routes live outside /admin and /partner, so the role guards let
  // either role through.
  localStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify({ username: 'tester', is_admin: false }));

  return { container, flush: () => new Promise((r) => setTimeout(r, 0)) };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// router.js keeps module-level route + queue state, so each test imports a
// fresh copy via a cache-busting query.
let importSeq = 0;
async function freshRouter() {
  importSeq += 1;
  return import(`../js/router.js?fresh=${importSeq}`);
}

test('a slow render superseded mid-flight never overwrites the newer view', async () => {
  const { container, flush } = setupBrowser();
  const { addRoute, initRouter, navigate } = await freshRouter();

  const gate = deferred();
  const cleanups = [];
  addRoute('/slow', {
    render: async (c) => {
      c.innerHTML = 'slow-skeleton';
      await gate.promise;          // data fetch in flight…
      c.innerHTML = 'slow-late';   // …then the late fill
    },
    cleanup: () => cleanups.push('slow'),
  });
  addRoute('/fast', {
    render: async (c) => { c.innerHTML = 'fast'; },
    cleanup: () => cleanups.push('fast'),
  });

  window.location.hash = '/slow';
  initRouter();
  await flush();
  assert.equal(container.innerHTML, 'slow-skeleton', 'slow render started');

  // Navigate away while /slow is still awaiting its data.
  navigate('/fast');
  await flush();
  assert.equal(container.innerHTML, 'slow-skeleton', 'fast waits for the in-flight render');

  // The slow data arrives: its render completes (late fill included), then
  // its cleanup runs, then /fast renders — serialized, so /fast lands last.
  gate.resolve();
  await flush(); await flush();
  assert.equal(container.innerHTML, 'fast', 'the newer view owns the DOM');
  assert.deepEqual(cleanups, ['slow'], 'the superseded view was cleaned up exactly once');

  // The NEXT navigation must tear down /fast — proving the router did not
  // leave the superseded /slow cleanup registered as current.
  navigate('/slow');
  gate.resolve();
  await flush(); await flush();
  assert.deepEqual(cleanups, ['slow', 'fast'], 'the displayed view is the one cleaned up next');
});

test('hops superseded while queued are skipped — only the newest queued route renders', async () => {
  const { container, flush } = setupBrowser();
  const { addRoute, initRouter, navigate } = await freshRouter();

  const gate = deferred();
  const renders = [];
  addRoute('/a', {
    render: async (c) => { renders.push('a'); c.innerHTML = 'a'; await gate.promise; },
    cleanup: () => {},
  });
  addRoute('/b', { render: async (c) => { renders.push('b'); c.innerHTML = 'b'; }, cleanup: () => {} });
  addRoute('/c', { render: async (c) => { renders.push('c'); c.innerHTML = 'c'; }, cleanup: () => {} });

  window.location.hash = '/a';
  initRouter();
  await flush();

  // Two more navigations queue up behind the in-flight /a render.
  navigate('/b');
  await flush();
  navigate('/c');
  await flush();

  gate.resolve();
  await flush(); await flush();

  assert.deepEqual(renders, ['a', 'c'], 'the intermediate /b hop was skipped');
  assert.equal(container.innerHTML, 'c');
});
