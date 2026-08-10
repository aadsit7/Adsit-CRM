// ============================================================
// research-progress — the bar may never claim more than happened
// ============================================================
// This mapper is the whole reason the analyze bar is trustworthy, so the tests
// are about what it must never do: overshoot, go backwards, finish on its own,
// or go quiet while the run is alive.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createResearchProgress,
  researchFraction,
  writeFraction,
  researchFailureText,
} from '../js/utils/research-progress.js';

// ── The curves ──────────────────────────────────────────────────────

test('research fills on real searches and can never finish the bar alone', () => {
  assert.equal(researchFraction(0), 0);
  // Every search moves it visibly, the early ones most.
  const one = researchFraction(1);
  const two = researchFraction(2);
  const three = researchFraction(3);
  const four = researchFraction(4);
  assert.ok(one > 0.1 && one < 0.2, `first search should be a visible step, got ${one}`);
  assert.ok(two > one && three > two && four > three);
  assert.ok(four - three < two - one, 'later searches move the bar less');
  // No number of searches completes it — only the answer does. Searching for
  // ever asymptotes at the ceiling and can never reach the writing band.
  assert.ok(researchFraction(50) <= 0.7);
  assert.ok(researchFraction(500) <= 0.7);
  assert.ok(researchFraction(500) < writeFraction(0));
});

test('writing fills the rest without ever reaching the end', () => {
  assert.ok(writeFraction(0) >= 0.7);
  assert.ok(writeFraction(5000) > writeFraction(1000));
  assert.ok(writeFraction(1_000_000) < 0.96, 'the last slice belongs to saving and the real result');
});

// ── The reducer ─────────────────────────────────────────────────────

function drive(events) {
  const progress = createResearchProgress();
  return events.map(e => progress.apply(e)).filter(Boolean);
}

test('a run reports a rising bar with a stage line for each real step', () => {
  const painted = drive([
    { type: 'round', round: 1, maxRounds: 6 },
    { type: 'narration', round: 1, chars: 200 },
    { type: 'search', round: 1, search: 1, query: 'Kris Huff Insight' },
    { type: 'results', round: 1, search: 1, sources: 6 },
    { type: 'search', round: 1, search: 2, query: 'Kris Huff LinkedIn Chandler' },
    { type: 'results', round: 1, search: 2, sources: 4 },
    { type: 'writing', round: 1, chars: 400 },
    { type: 'writing', round: 1, chars: 4000 },
  ]);

  const froms = painted.map(p => p.from);
  assert.deepEqual(froms, [...froms].sort((a, b) => a - b), 'the bar never slides backwards');
  assert.ok(froms[froms.length - 1] > froms[0]);

  const stages = painted.map(p => p.stage);
  assert.ok(stages.some(s => s.includes('Kris Huff Insight')), 'the user is told what is being searched for');
  assert.ok(stages.some(s => s.includes('6 results')), 'and how much came back');
  assert.ok(stages.some(s => s === 'Writing the verdict…'));

  // Each paint gives the pill a checkpoint it may creep toward, never past.
  for (const p of painted) {
    assert.ok(p.to >= p.from, 'a span always points forward');
    assert.ok(p.to <= 1);
    assert.ok(p.stepMs > 0);
    assert.equal(p.percent, Math.round(p.from * 100));
  }
});

test('a one-round run leaves the bar well past the first sixth', () => {
  // The old round-based bar could not exceed 1/6 on a single-round run, which
  // is exactly what made a healthy analysis look stuck.
  const painted = drive([
    { type: 'round', round: 1, maxRounds: 6 },
    { type: 'search', round: 1, search: 1, query: 'a' },
    { type: 'results', round: 1, search: 1, sources: 5 },
    { type: 'search', round: 1, search: 2, query: 'b' },
    { type: 'results', round: 1, search: 2, sources: 5 },
    { type: 'search', round: 1, search: 3, query: 'c' },
    { type: 'writing', round: 1, chars: 3000 },
  ]);
  assert.ok(painted[painted.length - 1].from > 0.8, 'a finished-writing run sits near the end');
});

test('a continuation does not rewind the bar the earlier searches earned', () => {
  const progress = createResearchProgress();
  progress.apply({ type: 'round', round: 1 });
  progress.apply({ type: 'search', round: 1, search: 1, query: 'a' });
  const afterSearch = progress.apply({ type: 'search', round: 1, search: 2, query: 'b' });
  const afterPause = progress.apply({ type: 'round', round: 2 });
  assert.ok(afterPause.from >= afterSearch.from);
  assert.match(afterPause.stage, /pass 2/);
});

test('a retry holds the bar still and says why', () => {
  const progress = createResearchProgress();
  progress.apply({ type: 'round', round: 1 });
  const before = progress.apply({ type: 'search', round: 1, search: 1, query: 'a' });
  const retry = progress.apply({ type: 'retry', round: 1, attempt: 1, delayMs: 6000, status: 429 });
  assert.equal(retry.from, before.from, 'a retry undoes the current round — it must not look like progress');
  assert.equal(retry.to, before.from, 'and it must not creep while nothing is running');
  assert.match(retry.stage, /Rate limited/);
  assert.match(retry.stage, /6s/);

  const busy = createResearchProgress().apply({ type: 'retry', round: 1, delayMs: 2000, status: 529 });
  assert.match(busy.stage, /busy/);
});

test('heartbeats and pauses are not progress', () => {
  const progress = createResearchProgress();
  progress.apply({ type: 'round', round: 1 });
  assert.equal(progress.apply({ type: 'heartbeat', round: 1 }), null);
  assert.equal(progress.apply({ type: 'pause', round: 1, searches: 2 }), null);
  assert.equal(progress.apply(null), null);
  assert.equal(progress.apply({ type: 'something_new' }), null);
});

test('narration moves the words but not the bar', () => {
  const progress = createResearchProgress();
  const start = progress.apply({ type: 'round', round: 1 });
  const narrate = progress.apply({ type: 'narration', round: 1, chars: 300 });
  assert.equal(narrate.from, start.from, 'thinking aloud finishes nothing');
  assert.ok(narrate.stage.length > 0);
});

test('saving parks the bar just short of done', () => {
  const progress = createResearchProgress();
  progress.apply({ type: 'round', round: 1 });
  const saving = progress.saving('Saving…');
  assert.equal(saving.stage, 'Saving…');
  assert.ok(saving.from >= 0.9 && saving.from < 1, 'only the real result finishes the bar');
});

// ── Failure wording ─────────────────────────────────────────────────

test('failure text tells the user which kind of failure it was', () => {
  assert.match(researchFailureText({ status: 429 }), /Rate limited/);
  assert.match(researchFailureText({ status: 529 }), /busy/);
  assert.match(researchFailureText({ status: 500 }), /busy/);
  assert.match(researchFailureText({ status: 401 }), /API key/);
  assert.match(researchFailureText({ code: 'RESEARCH_STREAM_TRUNCATED' }), /Connection/);
  assert.match(researchFailureText({ code: 'RESEARCH_ROUNDS_EXHAUSTED' }), /ran long/);
  assert.match(researchFailureText({ name: 'TimeoutError' }), /Timed out/);
  assert.match(researchFailureText(new Error('API key not set. Configure it on the Setup page')), /API key/);
  assert.equal(researchFailureText(new Error('something odd')), 'Analysis failed');
  assert.equal(researchFailureText(null), 'Analysis failed');
});
