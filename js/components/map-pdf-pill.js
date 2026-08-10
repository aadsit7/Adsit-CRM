// ============================================================
// Background-job Progress Pill
// ============================================================
// A small overlay that shows "what's happening right now" while a long
// LLM job runs. Pills stack, so every concurrently running job (three
// contacts being analyzed at once, say) gets its own row with its own
// label, its own progress bar and its own clock.
//
// The pill is the ONLY thing the user watches once they navigate away
// from the page that started the job, so its single hardest requirement
// is that it never lies: it must not claim failure for work that is
// still running, and it must always report the real outcome when it
// lands. Everything below follows from that.
//
// Public API (pure functions — no module-level singleton):
//   createPill(stage, options)    → pill
//     options.label               — entity name shown above the stage line
//     options.global              — use the body-fixed global stack (default)
//     options.scopeContainer      — legacy: anchor inside a specific element
//     options.progress            — true, or { steps, stepMs } to render a
//                                   determinate progress bar (see below)
//     options.hardTimeoutMs       — how long the pill tolerates NO PROGRESS
//                                   before giving up (default STALL_TIMEOUT_MS)
//   updatePillStage(pill, text)   — swap the stage text (counts as progress)
//   setPillProgress(pill, …)      — move the bar (counts as progress)
//   markPillSuccess(pill, text)   — green tick, hold 3s, fade out
//   markPillFailure(pill, text)   — amber warning, hold 5s, fade out
//   destroyPill(pill)             — immediate remove
//   livePillCount()               — how many jobs are still unsettled
//
// Also exported for tests:
//   formatElapsed(ms)             — "0:08", "1:23", etc.
//   easedProgress(...)            — the in-step easing curve
// ============================================================

// ── Why the give-up timer measures SILENCE, not duration ────────────────
// It used to measure total elapsed time, which made it a stopwatch racing the
// work itself: a LeadCheck run is allowed six research rounds of up to four
// minutes each (24 minutes), so a perfectly healthy run blew through a
// four-minute budget as a matter of routine. Once it fired the pill was
// SETTLED, which turns every later stage update and the final "ready" into a
// no-op — so the user watched a job report failure and then never report the
// success that actually happened moments later.
//
// A duration is not evidence of a problem; SILENCE is. Every caller drives its
// pill from an onProgress/stage callback, so a job that is alive says so. The
// timer therefore resets on every updatePillStage / setPillProgress call and
// only fires when nothing has been heard for the whole budget — which catches a
// genuinely wedged job without ever contradicting a healthy one.
const WARN_THRESHOLD_MS  = 150_000;  // 2:30 of silence — amber "taking longer…"
const STALL_TIMEOUT_MS   = 600_000;  // 10:00 of silence — give up

// The default has to clear the longest single uninterrupted network step in the
// app, or the timer fires on work that is merely slow rather than stuck. The
// longest is the attachment scan's per-file analyze call at 300s, so 600s
// leaves a full 2x margin. Callers may still pass their own budget.
function resolveStallTimeout(options) {
  const ms = Number(options && options.hardTimeoutMs);
  return Number.isFinite(ms) && ms > 0 ? ms : STALL_TIMEOUT_MS;
}

// Every pill is a background thing Randy is doing (analyzing, scanning,
// building a PDF), so each one wears Randy's face as its persistent identity
// badge — the "Randy icon" the user watches to know work is still progressing
// even after they navigate to another tab. Resolved relative to the document
// (index.html at the site root), matching every other `assets/…` reference.
const RANDY_AVATAR_SRC = 'assets/randy-avatar.png';

// ── Live-job registry ───────────────────────────────────────────────────
// Every unsettled pill is a job still holding an in-flight fetch. Navigating
// between views cannot touch them (the router only swaps #view-container and
// no view's cleanup aborts an analysis), but a reload or a closed tab kills
// every fetch in the page — so the registry backs an unload guard that asks
// before the user throws the work away. It is also what livePillCount()
// reports for tests and callers.
const livePills = new Set();
let unloadGuardInstalled = false;

function onBeforeUnload(event) {
  if (!livePills.size) return undefined;
  // Modern browsers ignore custom text and show their own wording; assigning
  // returnValue (and preventDefault) is what actually triggers the prompt.
  event.preventDefault();
  event.returnValue = '';
  return '';
}

function installUnloadGuard() {
  if (unloadGuardInstalled) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('beforeunload', onBeforeUnload);
  unloadGuardInstalled = true;
}

function trackPill(pill)   { livePills.add(pill); installUnloadGuard(); }
function untrackPill(pill) { livePills.delete(pill); }

/** How many jobs are still running (unsettled pills). */
export function livePillCount() { return livePills.size; }

// Body-fixed global stack — created lazily, sits at viewport bottom-right.
// All background jobs (click flows and Randy's voice flow) use this so pills
// are visible regardless of which panel, modal or view is open.
function getGlobalPillHost() {
  if (typeof document === 'undefined') return null;
  let host = document.getElementById('map-pdf-global-pill-stack');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'map-pdf-global-pill-stack';
  document.body.appendChild(host);
  return host;
}

// Legacy scoped stack — kept for backwards compatibility. Pass a container
// element and a stack is created (or reused) inside it.
function getScopedPillHost(scopeContainer) {
  if (typeof document === 'undefined') return null;
  let scoped = scopeContainer.querySelector('.randy-map-pill-stack--scoped');
  if (scoped) return scoped;
  scoped = document.createElement('div');
  scoped.className = 'randy-map-pill-stack randy-map-pill-stack--scoped';
  scopeContainer.appendChild(scoped);
  return scoped;
}

// Randy's existing in-panel stack — kept so Randy's own pill (when not
// using the global option) continues to work unchanged.
function getRandyPillHost() {
  if (typeof document === 'undefined') return null;
  let host = document.getElementById('randy-map-pill-stack');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'randy-map-pill-stack';
  host.className = 'randy-map-pill-stack';
  const parent = document.getElementById('randy-root') || document.body;
  parent.appendChild(host);
  return host;
}

function getStackHost(options = {}) {
  if (options.scopeContainer && typeof options.scopeContainer === 'object') {
    return getScopedPillHost(options.scopeContainer);
  }
  if (options.global !== false) {
    return getGlobalPillHost();
  }
  return getRandyPillHost();
}

export function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

// ── In-step easing ──────────────────────────────────────────────────────
// The only progress facts a job actually has are its checkpoints: "round 3 of
// 6 has started". Painting those alone leaves the bar frozen for the minutes a
// research round takes, which reads as "stuck" — the exact impression this
// whole change exists to remove. So between two real checkpoints the bar
// creeps forward on an exponential-decay curve: fast at first, slower the
// longer the step runs, and asymptotically approaching — never reaching — the
// next checkpoint.
//
// That keeps it honest in the only way that matters: the bar can never show
// more progress than the job has actually reported. It says "this step is
// taking a while", never "the next step is done".
//
// `stepMs` is the time constant, not a deadline: at t = stepMs the step is
// ~63% consumed, at 3x ~95%. EASE_CEILING caps the crawl short of the boundary
// so a real checkpoint is always a visible jump.
const EASE_CEILING = 0.9;

export function easedProgress(base, span, elapsedMs, stepMs) {
  if (!(span > 0) || !(stepMs > 0) || !(elapsedMs > 0)) return base;
  const consumed = 1 - Math.exp(-elapsedMs / stepMs);
  return base + span * EASE_CEILING * consumed;
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function spinnerSvg() {
  // Single rotating arc — CSS handles the spin via .randy-map-pill__spinner
  return `
    <svg viewBox="0 0 24 24" class="randy-map-pill__spinner-svg" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke-width="2.5" fill="none" stroke="currentColor" stroke-opacity="0.25"/>
      <path d="M21 12a9 9 0 0 0-9-9" stroke-width="2.5" fill="none" stroke="currentColor" stroke-linecap="round"/>
    </svg>`;
}

function checkSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function warnSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="currentColor" opacity="0.18"/><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.5" r="1.1" fill="currentColor"/></svg>`;
}

// Default time constant for one step, used when the caller enables the bar
// without sizing its steps. 90s suits a web-research round.
const DEFAULT_STEP_MS = 90_000;

function resolveProgressConfig(options) {
  const p = options && options.progress;
  if (!p) return null;
  if (p === true) return { steps: 0, stepMs: DEFAULT_STEP_MS };
  const steps  = Number(p.steps);
  const stepMs = Number(p.stepMs);
  return {
    steps:  Number.isFinite(steps) && steps > 0 ? steps : 0,
    stepMs: Number.isFinite(stepMs) && stepMs > 0 ? stepMs : DEFAULT_STEP_MS,
  };
}

export function createPill(initialStage = 'Starting…', options = {}) {
  const host = getStackHost(options);
  if (!host) return { el: null, id: null };

  const id = `map-pill-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const el = document.createElement('div');
  el.className = 'randy-map-pill randy-map-pill--active';
  el.id = id;
  // The live region is the STAGE TEXT alone (set in the template below), not
  // the whole pill. With role=status on the pill, the elapsed clock ticking
  // every second re-announced the entire pill — label, stage and time — once
  // per second for the whole run, which on a several-minute analysis buries a
  // screen-reader user. Announcing only the stage means they hear each real
  // step ("Reading documents… 2 of 5", "Analysis ready") exactly once.

  const labelHtml = options.label
    ? `<span class="randy-map-pill__label">${escapeHtml(options.label)}</span>`
    : '';

  // Randy's face leads the spinner row so the pill reads as "Randy is on it."
  // Defaults on for every pill; pass `avatar: false` to suppress, or a string
  // to point at a different image.
  const showAvatar = options.avatar !== false;
  const avatarSrc = typeof options.avatar === 'string' ? options.avatar : RANDY_AVATAR_SRC;
  const avatarHtml = showAvatar
    ? `<img class="randy-map-pill__avatar" src="${escapeHtml(avatarSrc)}" alt="Randy" width="18" height="18">`
    : '';

  // The bar is its own full-width row under the stage line. aria-hidden: the
  // stage text already announces every real checkpoint in words, so a second
  // announcement of the same fact as a percentage is pure noise on a screen
  // reader — and the eased crawl between checkpoints has nothing to say at all.
  const progressCfg = resolveProgressConfig(options);
  const progressHtml = progressCfg
    ? '<span class="randy-map-pill__progress" aria-hidden="true"><span class="randy-map-pill__progress-fill"></span></span>'
    : '';

  // When a label is present, it sits on a line of its own (flex full-width)
  // above the spinner row. flex-wrap: wrap on the pill handles the break.
  el.innerHTML = `
    ${labelHtml}${avatarHtml}<span class="randy-map-pill__icon randy-map-pill__spinner">${spinnerSvg()}</span><span class="randy-map-pill__stage" role="status" aria-live="polite">${escapeHtml(initialStage)}</span><span class="randy-map-pill__elapsed" aria-hidden="true">0:00</span>${progressHtml}
  `.trim();

  // Newest pill on top (so older ones settle below if the user kicks
  // off two generations). Gap comes from CSS.
  host.insertBefore(el, host.firstChild);


  const startedAt = Date.now();
  const pill = {
    el,
    id,
    startedAt,
    stageEl:   el.querySelector('.randy-map-pill__stage'),
    elapsedEl: el.querySelector('.randy-map-pill__elapsed'),
    iconEl:    el.querySelector('.randy-map-pill__icon'),
    fillEl:    el.querySelector('.randy-map-pill__progress-fill'),
    tickHandle: null,
    settled: false,
    // How the pill settled. Only a give-up timeout is reversible — see
    // reviveIfStalled(). 'success' | 'failure' | 'dismiss' are final.
    settledBy: null,
    // Silence clock. Reset by every updatePillStage / setPillProgress.
    lastProgressAt: startedAt,
    // Determinate-bar state, null when the caller didn't ask for a bar.
    progress: progressCfg
      ? { ...progressCfg, base: 0, span: 0, markedAt: startedAt, shown: 0 }
      : null,
  };

  if (pill.progress && !pill.progress.steps) {
    // Steps unknown → an indeterminate sweep until the caller supplies real
    // numbers, rather than a bar frozen at zero.
    if (pill.el.classList) pill.el.classList.add('randy-map-pill--indeterminate');
  }

  trackPill(pill);

  // Click to dismiss. The pill has no other exit if its work never settles —
  // and with a caller-supplied budget that wait can be long — so a stuck pill
  // would otherwise follow the user around every page until a new run of the
  // same kind replaced it. Dismissing removes only the indicator; the job is
  // owned by its caller and keeps running.
  if (typeof el.addEventListener === 'function') {
    el.style.cursor = 'pointer';
    el.setAttribute('title', 'Dismiss');
    el.addEventListener('click', () => destroyPill(pill));
  }

  pill.stallTimeoutMs = resolveStallTimeout(options);
  startTicker(pill);

  return pill;
}

// The once-a-second heartbeat: repaint the clock and the eased bar, then judge
// how long the job has been silent. Extracted from createPill because a revived
// pill needs it started again — settling stopped it, and a revived pill whose
// clock stayed frozen would be a worse lie than the timeout it replaced.
function startTicker(pill) {
  if (pill.tickHandle) return;
  pill.tickHandle = setInterval(() => {
    if (pill.settled) return;
    const now = Date.now();
    if (pill.elapsedEl) pill.elapsedEl.textContent = formatElapsed(now - pill.startedAt);
    paintEasedProgress(pill, now);

    const silentMs = now - pill.lastProgressAt;
    if (silentMs >= pill.stallTimeoutMs) {
      const mins = Math.max(1, Math.round(pill.stallTimeoutMs / 60_000));
      markPillStalled(pill, `No progress for ${mins} minute${mins === 1 ? '' : 's'}`);
      return;
    }
    if (silentMs >= WARN_THRESHOLD_MS && pill.el.classList && !pill.el.classList.contains('randy-map-pill--warn')) {
      pill.el.classList.add('randy-map-pill--warn');
      if (pill.stageEl) pill.stageEl.textContent = 'Taking longer than expected… still trying';
    }
  }, 1000);
}

// A pill settled by the give-up timer is the one settled state that is still a
// guess — the job may well be alive and about to report. Any later word from
// the caller is better evidence than the guess, so it reopens the pill instead
// of being swallowed. Deliberate settles (success / failure / dismiss) are
// final and still swallow whatever follows them.
function reviveIfStalled(pill) {
  if (!pill.settled || pill.settledBy !== 'timeout') return;
  pill.settled = false;
  pill.settledBy = null;
  // Refresh the silence clock BEFORE restarting the ticker, or the stale
  // timestamp that parked the pill would park it again on the next tick.
  pill.lastProgressAt = Date.now();
  trackPill(pill);
  if (pill.el && pill.el.classList) {
    pill.el.classList.remove('randy-map-pill--failure', 'randy-map-pill--stalled', 'randy-map-pill--warn');
    pill.el.classList.add('randy-map-pill--active');
  }
  if (pill.iconEl) {
    pill.iconEl.classList.add('randy-map-pill__spinner');
    pill.iconEl.innerHTML = spinnerSvg();
  }
  startTicker(pill);
}

// Record that the job just proved it is alive: clears the amber "taking
// longer" state and restarts the silence clock.
function noteProgress(pill) {
  pill.lastProgressAt = Date.now();
  if (pill.el && pill.el.classList) pill.el.classList.remove('randy-map-pill--warn');
}

function paintFill(pill, fraction) {
  if (!pill.progress) return;
  // Monotonic by construction: a bar that slides backwards reads as work being
  // undone, and no caller ever means that.
  const next = Math.max(pill.progress.shown, clamp01(fraction));
  pill.progress.shown = next;
  if (pill.fillEl && pill.fillEl.style) {
    pill.fillEl.style.width = `${(next * 100).toFixed(1)}%`;
  }
}

function paintEasedProgress(pill, now = Date.now()) {
  const p = pill.progress;
  // A zero span is the indeterminate case (no checkpoints yet) and the exact-
  // fraction case (a position with no onward creep) — both want the bar left
  // exactly where the caller put it.
  if (!p || !(p.span > 0)) return;
  paintFill(pill, easedProgress(p.base, p.span, now - p.markedAt, p.stepMs));
}

export function updatePillStage(pill, stageText) {
  if (!pill || !pill.el) return;
  reviveIfStalled(pill);
  if (pill.settled) return;
  noteProgress(pill);
  // Rewriting the same text still replaces the node inside an aria-live
  // region, so a caller that reports steadily ("Writing the verdict…" every
  // couple of hundred characters) would re-announce one unchanged sentence
  // dozens of times. The liveness signal above is unconditional; only the DOM
  // write is skipped.
  if (pill.stageEl && pill.stageEl.textContent !== stageText) {
    pill.stageEl.textContent = stageText;
    // The stage line is clipped with an ellipsis at the pill's 260px, so
    // anything long loses exactly the specific half worth reading. Callers keep
    // their wording short; this makes the whole line recoverable on hover.
    if (typeof pill.stageEl.setAttribute === 'function') pill.stageEl.setAttribute('title', stageText);
  }
}

/**
 * Move the progress bar, and tell the pill the job is still alive.
 *
 * Three forms:
 *   setPillProgress(pill, 0.4)        — an exact fraction; the bar sits there.
 *   setPillProgress(pill, step, total) — "step of total complete"; the bar
 *                                        moves to step/total and then creeps
 *                                        toward (step+1)/total while the step
 *                                        runs (see easedProgress).
 *   setPillProgress(pill, { from, to, stepMs })
 *                                      — an explicit span: the bar sits at
 *                                        `from` and creeps toward `to`. For
 *                                        jobs whose steps are real but whose
 *                                        TOTAL is unknowable (how many web
 *                                        searches will this take?), where
 *                                        step/total would have to invent a
 *                                        denominator. `stepMs` is optional and
 *                                        defaults to the pill's existing one.
 *
 * Safe to call on a pill created without `progress` — it still counts as a
 * liveness signal, it just has no bar to paint.
 */
export function setPillProgress(pill, value, total) {
  if (!pill || !pill.el) return;
  reviveIfStalled(pill);
  if (pill.settled) return;
  noteProgress(pill);
  if (!pill.progress) return;

  // Span form — the caller knows both ends of the current step.
  if (value && typeof value === 'object') {
    const from = clamp01(value.from);
    const to = Math.max(from, clamp01(value.to));
    const stepMs = Number(value.stepMs);
    // Re-reporting the SAME span means the same step is still running, so the
    // creep must carry on from where it is. Restarting markedAt on every such
    // call — and a streaming caller makes many — would reset the easing curve
    // each time and leave the bar pinned at `from` for as long as the step
    // keeps talking, which is precisely the frozen bar this all exists to fix.
    const sameSpan = pill.progress.base === from && pill.progress.span === (to - from);
    pill.progress.base = from;
    pill.progress.span = to - from;
    if (!sameSpan) pill.progress.markedAt = Date.now();
    if (Number.isFinite(stepMs) && stepMs > 0) pill.progress.stepMs = stepMs;
    if (pill.el.classList) pill.el.classList.remove('randy-map-pill--indeterminate');
    paintFill(pill, from);
    return;
  }

  const totalNum = Number(total);
  if (Number.isFinite(totalNum) && totalNum > 0) {
    const step = Math.max(0, Number(value) || 0);
    pill.progress.steps  = totalNum;
    pill.progress.base   = clamp01(step / totalNum);
    pill.progress.span   = clamp01((step + 1) / totalNum) - pill.progress.base;
    pill.progress.markedAt = Date.now();
    if (pill.el.classList) pill.el.classList.remove('randy-map-pill--indeterminate');
    paintFill(pill, pill.progress.base);
    return;
  }

  // Fraction form — an exact position with no onward creep.
  pill.progress.base = clamp01(value);
  pill.progress.span = 0;
  pill.progress.markedAt = Date.now();
  if (pill.el.classList) pill.el.classList.remove('randy-map-pill--indeterminate');
  paintFill(pill, pill.progress.base);
}

function settle(pill, how) {
  pill.settled = true;
  pill.settledBy = how;
  untrackPill(pill);
  if (pill.tickHandle) { clearInterval(pill.tickHandle); pill.tickHandle = null; }
}

export function markPillSuccess(pill, finalText) {
  if (!pill || !pill.el) return;
  reviveIfStalled(pill);
  if (pill.settled) return;
  settle(pill, 'success');
  const elapsed = formatElapsed(Date.now() - pill.startedAt);
  pill.el.classList.remove('randy-map-pill--active', 'randy-map-pill--warn', 'randy-map-pill--indeterminate');
  pill.el.classList.add('randy-map-pill--success');
  if (pill.iconEl) {
    pill.iconEl.classList.remove('randy-map-pill__spinner');
    pill.iconEl.innerHTML = checkSvg();
  }
  if (pill.progress) paintFill(pill, 1);
  if (pill.stageEl)   pill.stageEl.textContent = finalText || 'Saved!';
  if (pill.elapsedEl) pill.elapsedEl.textContent = `${elapsed} ✓`;
  scheduleFadeOut(pill, 3000);
}

export function markPillFailure(pill, errorText) {
  if (!pill || !pill.el) return;
  reviveIfStalled(pill);
  if (pill.settled) return;
  settle(pill, 'failure');
  pill.el.classList.remove('randy-map-pill--active', 'randy-map-pill--warn', 'randy-map-pill--indeterminate');
  pill.el.classList.add('randy-map-pill--failure');
  if (pill.iconEl) {
    pill.iconEl.classList.remove('randy-map-pill__spinner');
    pill.iconEl.innerHTML = warnSvg();
  }
  // The bar stays where it stopped — that IS the honest picture of a failure.
  if (pill.stageEl)   pill.stageEl.textContent = errorText || 'Failed — see card';
  if (pill.elapsedEl) pill.elapsedEl.textContent = '';
  scheduleFadeOut(pill, 5000);
}

// The give-up timer's own settle. Unlike success/failure it does NOT schedule a
// fade-out: the whole point is that the job may still be alive, so the pill
// stays on screen — dismissible by click — ready to be revived and corrected by
// a late result rather than disappearing on a guess.
function markPillStalled(pill, text) {
  if (!pill || !pill.el || pill.settled) return;
  settle(pill, 'timeout');
  pill.el.classList.remove('randy-map-pill--active', 'randy-map-pill--warn', 'randy-map-pill--indeterminate');
  pill.el.classList.add('randy-map-pill--failure', 'randy-map-pill--stalled');
  if (pill.iconEl) {
    pill.iconEl.classList.remove('randy-map-pill__spinner');
    pill.iconEl.innerHTML = warnSvg();
  }
  if (pill.stageEl) pill.stageEl.textContent = text;
}

export function destroyPill(pill) {
  if (!pill || !pill.el) return;
  if (pill.tickHandle) { clearInterval(pill.tickHandle); pill.tickHandle = null; }
  pill.settled = true;
  pill.settledBy = 'dismiss';
  untrackPill(pill);
  pill.el.remove();
}

function scheduleFadeOut(pill, delayMs) {
  setTimeout(() => {
    if (!pill.el) return;
    pill.el.classList.add('randy-map-pill--fading');
    // Allow the CSS transition to run before removing from the DOM.
    setTimeout(() => { try { pill.el.remove(); } catch { /* ignore */ } }, 400);
  }, delayMs);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
