// Tests for js/components/map-pdf-pill.js. The pill manipulates the
// DOM, so we spin up a minimal document stub rather than installing
// jsdom as a dev dep. Only the surface contracts are tested: stage
// updates, timer formatting, success/failure transitions.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stand-in just rich enough for the pill's DOM touches.
function makeFakeDoc() {
  const listeners = new Map();
  function makeEl() {
    const el = {
      id: '',
      className: '',
      children: [],
      classList: {
        _set: new Set(),
        add(...cs) { cs.forEach(c => this._set.add(c)); },
        remove(...cs) { cs.forEach(c => this._set.delete(c)); },
        contains(c) { return this._set.has(c); },
      },
      _text: '',
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(v) {
        this._html = String(v);
        // Populate the trivial "child query" handles the pill code reaches for.
        this._stage = { textContent: '' };
        this._elapsed = { textContent: '' };
        this._icon = { classList: { add() {}, remove() {} }, innerHTML: '' };
        // The progress fill only exists when the template rendered a bar —
        // mirroring the real DOM, where querySelector returns null otherwise.
        this._fill = this._html.includes('randy-map-pill__progress-fill')
          ? { style: { width: '' } }
          : null;
      },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      setAttribute() {},
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child) { this.children.unshift(child); return child; },
      querySelector(sel) {
        // Most specific first: '__progress-fill' also contains '__progress'.
        if (sel.includes('__progress-fill')) return this._fill || null;
        if (sel.includes('__stage'))   return this._stage   || { textContent: '' };
        if (sel.includes('__elapsed')) return this._elapsed || { textContent: '' };
        if (sel.includes('__icon'))    return this._icon    || { classList: { add() {}, remove() {} }, innerHTML: '' };
        return null;
      },
      get firstChild() { return this.children[0] || null; },
      remove() {},
    };
    return el;
  }
  return {
    _map: new Map(),
    createElement: () => makeEl(),
    getElementById(id) { return this._map.get(id) || null; },
    body: makeEl(),
    _register(id, el) { this._map.set(id, el); },
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
}

globalThis.document = makeFakeDoc();

// Stub a #randy-root that getStackHost() will find.
const randyRoot = globalThis.document.createElement();
randyRoot.id = 'randy-root';
globalThis.document._register('randy-root', randyRoot);

const {
  createPill, updatePillStage, setPillProgress, markPillSuccess, markPillFailure,
  destroyPill, formatElapsed, easedProgress, livePillCount,
} = await import('../js/components/map-pdf-pill.js');

// Read the bar's painted position back off the fake fill element.
function fillPct(pill) {
  return pill.fillEl ? parseFloat(pill.fillEl.style.width) : null;
}

// ── formatElapsed is pure ────────────────────────────────────
test('formatElapsed: 0ms → "0:00"',     () => assert.equal(formatElapsed(0),       '0:00'));
test('formatElapsed: 8.9s → "0:08"',    () => assert.equal(formatElapsed(8900),    '0:08'));
test('formatElapsed: 9.0s → "0:09"',    () => assert.equal(formatElapsed(9000),    '0:09'));
test('formatElapsed: 59s → "0:59"',     () => assert.equal(formatElapsed(59_500),  '0:59'));
test('formatElapsed: 60s → "1:00"',     () => assert.equal(formatElapsed(60_000),  '1:00'));
test('formatElapsed: 83s → "1:23"',     () => assert.equal(formatElapsed(83_000),  '1:23'));
test('formatElapsed: clamps negative', () => assert.equal(formatElapsed(-1000),   '0:00'));

// ── createPill returns a usable handle ───────────────────────
test('createPill returns {el, id, stageEl, elapsedEl}', () => {
  const pill = createPill('Hello…');
  assert.ok(pill.el);
  assert.match(String(pill.id), /^map-pill-/);
  // Cleanup so the interval doesn't leak across tests.
  destroyPill(pill);
});

// ── Randy's face is the persistent identity badge on every pill ──
test('createPill includes the Randy avatar badge by default', () => {
  const pill = createPill('Working…');
  assert.match(pill.el.innerHTML, /randy-map-pill__avatar/);
  assert.match(pill.el.innerHTML, /assets\/randy-avatar\.png/);
  destroyPill(pill);
});

test('createPill omits the avatar when { avatar: false }', () => {
  const pill = createPill('Working…', { avatar: false });
  assert.ok(!pill.el.innerHTML.includes('randy-map-pill__avatar'));
  destroyPill(pill);
});

test('createPill accepts a custom avatar URL', () => {
  const pill = createPill('Working…', { avatar: 'assets/other.png' });
  assert.match(pill.el.innerHTML, /assets\/other\.png/);
  destroyPill(pill);
});

// ── updatePillStage swaps stage text ─────────────────────────
test('updatePillStage sets stageEl.textContent', () => {
  const pill = createPill('Stage A');
  updatePillStage(pill, 'Stage B');
  assert.equal(pill.stageEl.textContent, 'Stage B');
  destroyPill(pill);
});

// ── markPillSuccess settles the pill and sets final text ─────
test('markPillSuccess settles pill, sets stage + elapsed text', () => {
  const pill = createPill('Working…');
  markPillSuccess(pill, 'Saved to Acme');
  assert.equal(pill.settled, true);
  assert.equal(pill.stageEl.textContent, 'Saved to Acme');
  assert.match(pill.elapsedEl.textContent, /✓$/);
  // Another call is a no-op
  markPillSuccess(pill, 'ignored');
  assert.equal(pill.stageEl.textContent, 'Saved to Acme');
});

// ── markPillFailure settles the pill and sets error text ─────
test('markPillFailure settles pill with error copy', () => {
  const pill = createPill('Working…');
  markPillFailure(pill, 'Something broke');
  assert.equal(pill.settled, true);
  assert.equal(pill.stageEl.textContent, 'Something broke');
});

// ── updatePillStage is a no-op once settled ─────────────────
test('updatePillStage ignores settled pills', () => {
  const pill = createPill('Working…');
  markPillSuccess(pill, 'Done');
  updatePillStage(pill, 'shouldNotAppear');
  assert.equal(pill.stageEl.textContent, 'Done');
});

// ── The give-up timer is per-caller, and measures SILENCE ────
// It used to measure total elapsed time, which raced the work itself: a
// LeadCheck run is allowed 6 rounds x 4 minutes, so a healthy run routinely
// blew past a 4-minute budget, went SETTLED, and swallowed the "verified" that
// landed moments later. A duration proves nothing; silence does — so the timer
// now fires only when the job has said nothing for the whole budget.
test('createPill accepts a per-caller give-up budget', async () => {
  const pill = createPill('Long job…', { hardTimeoutMs: 60 });
  // Past the custom budget, well short of the default.
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(pill.settled, true, 'the custom budget should have fired');
  assert.match(pill.stageEl.textContent, /^No progress for \d+ minute/);
  destroyPill(pill);
});

// This is the regression that made the reported bug possible: a job that is
// visibly alive must never be declared timed out, no matter how long it runs.
test('progress keeps a job alive indefinitely past its budget', async () => {
  const pill = createPill('Round 1…', { hardTimeoutMs: 400 });
  // Speak up more often than the budget, for longer than the budget.
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 200));
    updatePillStage(pill, `Round ${i + 2}…`);
  }
  assert.equal(pill.settled, false, 'a job reporting progress must never time out');
  markPillSuccess(pill, 'Verified');
  assert.equal(pill.stageEl.textContent, 'Verified');
});

test('setPillProgress also counts as proof of life', async () => {
  const pill = createPill('Working…', { hardTimeoutMs: 400, progress: { steps: 6 } });
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 200));
    setPillProgress(pill, i, 6);
  }
  assert.equal(pill.settled, false);
  destroyPill(pill);
});

// A timeout is a GUESS that the job died. Any later word from the caller is
// better evidence, so it must win — otherwise the pill's last word to the user
// is a failure that never happened.
test('a late success revives and corrects a timed-out pill', async () => {
  const pill = createPill('Analyzing…', { hardTimeoutMs: 60 });
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(pill.settledBy, 'timeout', 'precondition: the timer settled it');

  markPillSuccess(pill, 'Identity & role verified');
  assert.equal(pill.stageEl.textContent, 'Identity & role verified');
  assert.equal(pill.settledBy, 'success');
});

test('a late failure also corrects a timed-out pill', async () => {
  const pill = createPill('Analyzing…', { hardTimeoutMs: 60 });
  await new Promise(r => setTimeout(r, 1300));
  markPillFailure(pill, 'Analysis failed');
  assert.equal(pill.stageEl.textContent, 'Analysis failed');
  assert.equal(pill.settledBy, 'failure');
});

test('a stage update revives a timed-out pill and resumes it', async () => {
  const pill = createPill('Analyzing…', { hardTimeoutMs: 60 });
  await new Promise(r => setTimeout(r, 1300));
  updatePillStage(pill, 'Verifying… (round 3)');
  assert.equal(pill.settled, false, 'the job proved it is alive');
  assert.equal(pill.stageEl.textContent, 'Verifying… (round 3)');
  destroyPill(pill);
});

// Settling stops the once-a-second ticker, so a revived pill has to restart
// it — otherwise its clock freezes and it can never park again, which would be
// a worse lie than the timeout it just replaced.
test('a revived pill keeps ticking and can park again', async () => {
  const pill = createPill('Analyzing…', { hardTimeoutMs: 60 });
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(pill.settledBy, 'timeout');

  updatePillStage(pill, 'Verifying…');
  assert.ok(pill.tickHandle, 'the heartbeat must be running again');

  // Silent again past the budget → parks a second time.
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(pill.settledBy, 'timeout', 'a revived pill still watches for silence');
  destroyPill(pill);
});

// …but a DELIBERATE settle is final. Success/failure/dismiss are the caller's
// own verdict, not a guess, so nothing may overwrite them.
test('a deliberately settled pill is never revived', () => {
  const done = createPill('Working…');
  markPillSuccess(done, 'Done');
  updatePillStage(done, 'nope');
  markPillFailure(done, 'nope');
  assert.equal(done.stageEl.textContent, 'Done');

  const dismissed = createPill('Working…');
  destroyPill(dismissed);
  markPillSuccess(dismissed, 'nope');
  assert.equal(dismissed.settledBy, 'dismiss');
});

test('a generous budget leaves a long-running pill alive and updatable', async () => {
  const pill = createPill('Researching…', { hardTimeoutMs: 20 * 60_000 });
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(pill.settled, false, 'must not self-fail inside its budget');
  updatePillStage(pill, 'Round 2');
  assert.equal(pill.stageEl.textContent, 'Round 2');
  markPillSuccess(pill, 'Brief ready');
  assert.equal(pill.stageEl.textContent, 'Brief ready', 'success must still land');
  destroyPill(pill);
});

test('an absent / invalid hardTimeoutMs falls back to the default', async () => {
  for (const options of [{}, { hardTimeoutMs: 0 }, { hardTimeoutMs: -1 }, { hardTimeoutMs: 'soon' }]) {
    const pill = createPill('Working…', options);
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(pill.settled, false, `${JSON.stringify(options)} should use the generous default`);
    destroyPill(pill);
  }
});

// ── Progress bar ─────────────────────────────────────────────
// The bar is opt-in so every existing caller renders exactly as before.
test('no bar is rendered unless the caller asks for one', () => {
  const plain = createPill('Working…');
  assert.ok(!plain.el.innerHTML.includes('randy-map-pill__progress'), 'no bar by default');
  assert.equal(plain.fillEl, null);
  // Progress calls on a barless pill are harmless — they still signal liveness.
  setPillProgress(plain, 2, 4);
  assert.equal(plain.settled, false);
  destroyPill(plain);

  const withBar = createPill('Working…', { progress: true });
  assert.match(withBar.el.innerHTML, /randy-map-pill__progress-fill/);
  destroyPill(withBar);
});

test('the step form paints completed/total and the fraction form paints exactly', () => {
  const pill = createPill('Working…', { progress: { steps: 4, stepMs: 60_000 } });
  setPillProgress(pill, 1, 4);
  assert.equal(fillPct(pill), 25, 'one of four rounds done');
  setPillProgress(pill, 3, 4);
  assert.equal(fillPct(pill), 75);
  destroyPill(pill);

  const frac = createPill('Working…', { progress: true });
  setPillProgress(frac, 0.85);
  assert.equal(fillPct(frac), 85);
  destroyPill(frac);
});

// The span form exists for jobs whose steps are real but whose TOTAL is not
// knowable — how many web searches an analysis needs is decided while it runs.
// step/total would have to invent a denominator; from/to states only what is
// actually known: where we are, and the next checkpoint we may creep toward.
test('the span form paints `from` and creeps only toward `to`', async () => {
  const pill = createPill('Working…', { progress: { steps: 1, stepMs: 60_000 } });

  setPillProgress(pill, { from: 0.28, to: 0.37, stepMs: 40 });
  assert.equal(fillPct(pill), 28);

  // Long enough for several time constants of creep — it must approach the
  // next checkpoint without ever passing it.
  await new Promise(r => setTimeout(r, 1200));
  const crept = fillPct(pill);
  assert.ok(crept > 28, `the bar should creep while a step runs, sat at ${crept}`);
  assert.ok(crept < 37, `the creep must never reach the next checkpoint, hit ${crept}`);

  // A later checkpoint below where the bar already sits cannot rewind it.
  setPillProgress(pill, { from: 0.1, to: 0.2, stepMs: 40 });
  assert.ok(fillPct(pill) >= crept, 'the bar never slides backwards');

  destroyPill(pill);
});

test('the span form counts as proof of life', async () => {
  const pill = createPill('Working…', { hardTimeoutMs: 400, progress: { steps: 1 } });
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 200));
    setPillProgress(pill, { from: i / 10, to: (i + 1) / 10, stepMs: 20_000 });
  }
  assert.equal(pill.settled, false);
  destroyPill(pill);
});

// A zero-width span is "sit exactly here" (a retry, a saving hold). The bar
// must not drift while nothing is running.
// A streaming caller re-reports the same span every couple of hundred
// characters. Each repeat must NOT restart the easing clock, or the bar sits
// at `from` for the whole step — the frozen bar this all exists to fix.
test('re-reporting the same span keeps the creep going', async () => {
  const pill = createPill('Working…', { progress: { steps: 1, stepMs: 60_000 } });
  setPillProgress(pill, { from: 0.3, to: 0.45, stepMs: 60 });
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 100));
    setPillProgress(pill, { from: 0.3, to: 0.45, stepMs: 60 });
  }
  const crept = fillPct(pill);
  assert.ok(crept > 31, `chatty repeats must not pin the bar at its floor, sat at ${crept}`);
  assert.ok(crept < 45);
  destroyPill(pill);
});

test('a zero-width span holds the bar still', async () => {
  const pill = createPill('Working…', { progress: { steps: 1, stepMs: 10 } });
  setPillProgress(pill, { from: 0.5, to: 0.5, stepMs: 10 });
  assert.equal(fillPct(pill), 50);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(fillPct(pill), 50);
  destroyPill(pill);
});

test('progress is clamped to 0..1 and never moves backwards', () => {
  const pill = createPill('Working…', { progress: true });
  setPillProgress(pill, 0.6);
  setPillProgress(pill, 0.2);
  assert.equal(fillPct(pill), 60, 'a lower value must not un-do visible progress');
  setPillProgress(pill, 42);
  assert.equal(fillPct(pill), 100, 'clamped to the top');
  destroyPill(pill);
});

test('success fills the bar; failure leaves it where the work stopped', () => {
  const ok = createPill('Working…', { progress: { steps: 4 } });
  setPillProgress(ok, 1, 4);
  markPillSuccess(ok, 'Done');
  assert.equal(fillPct(ok), 100);

  const bad = createPill('Working…', { progress: { steps: 4 } });
  setPillProgress(bad, 1, 4);
  markPillFailure(bad, 'Broke');
  assert.equal(fillPct(bad), 25, 'a failed job did not secretly finish');
});

// The eased crawl between two real checkpoints is what stops a multi-minute
// round from looking frozen. Its one hard rule: it may never reach the next
// checkpoint, because that would claim progress the job has not reported.
test('easedProgress advances but never reaches the next checkpoint', () => {
  const base = 0.5, span = 0.25, stepMs = 60_000; // step 3 of 6, next is 0.75
  const at = (ms) => easedProgress(base, span, ms, stepMs);
  assert.equal(at(0), base, 'starts exactly at the reported checkpoint');
  assert.ok(at(10_000) > at(0), 'moves forward');
  assert.ok(at(60_000) > at(10_000), 'keeps moving');
  // Even at an absurd multiple of the time constant it stays short of 0.75.
  assert.ok(at(10 * 60_000) < base + span, 'never reaches the next checkpoint');
  assert.ok(at(10 * 60_000) <= base + span * 0.9 + 1e-9, 'stays under the ease ceiling');
});

test('easedProgress is inert without a span or a time constant', () => {
  assert.equal(easedProgress(0.5, 0, 10_000, 60_000), 0.5);
  assert.equal(easedProgress(0.5, 0.25, 10_000, 0), 0.5);
  assert.equal(easedProgress(0.5, 0.25, 0, 60_000), 0.5);
});

// ── Live-job registry ────────────────────────────────────────
// Backs the unload guard: a reload or a closed tab kills every in-flight
// fetch, so the app has to know when work is outstanding.
test('livePillCount tracks unsettled jobs only', () => {
  const before = livePillCount();
  const a = createPill('A…');
  const b = createPill('B…');
  assert.equal(livePillCount(), before + 2);
  markPillSuccess(a, 'done');
  assert.equal(livePillCount(), before + 1, 'a settled job is no longer outstanding');
  destroyPill(b);
  assert.equal(livePillCount(), before, 'a dismissed job is no longer outstanding');
});

// ── The live region is the stage text, not the whole pill ────
// role=status on the pill made the ticking clock re-announce label + stage +
// elapsed once per second for the entire run.
test('the pill announces only its stage, and hides the ticking clock from AT', () => {
  const pill = createPill('Reading the notes…', { label: 'Acme' });
  assert.match(pill.el.innerHTML, /__stage" role="status" aria-live="polite"/);
  assert.match(pill.el.innerHTML, /__elapsed" aria-hidden="true"/);
  destroyPill(pill);
});

// ── A pill can always be dismissed ───────────────────────────
// With a caller-supplied budget the wait before a stuck pill self-settles can
// be long, so there has to be a way out that doesn't require starting another
// run of the same kind.
test('clicking a pill destroys it', () => {
  const clicks = [];
  const realCreate = globalThis.document.createElement;
  globalThis.document.createElement = () => {
    const e = realCreate();
    e.style = {};
    e.addEventListener = (ev, fn) => { if (ev === 'click') clicks.push(fn); };
    return e;
  };
  try {
    const pill = createPill('Working…');
    assert.equal(clicks.length, 1, 'a click handler should be wired');
    clicks[0]();
    assert.equal(pill.settled, true, 'dismiss should settle the pill');
    assert.equal(pill.tickHandle, null, 'dismiss should clear the ticker');
  } finally {
    globalThis.document.createElement = realCreate;
  }
});
