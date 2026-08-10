// ============================================================
// Research progress model — runner events → what the pill should say
// ============================================================
// One place decides how an `anthropic-research-stream` event turns into a
// stage line and a bar position, so the LeadCheck pill and the contact-brief
// pill describe the same work in the same words, and so the mapping can be
// tested without a DOM or a network.
//
// ── The honesty rule ────────────────────────────────────────────────
// The bar may never claim more than the run has actually done. That rules out
// the obvious shape — "assume ~8 searches, fill 1/8 per search" — because a
// run that needs twelve would sail past 100% and sit there, which is the exact
// lie the old max-rounds bar told in the other direction.
//
// So research fills on a decaying curve toward a ceiling it never reaches:
// every real search moves the bar a visible, honest amount, the early ones move
// it most, and no number of searches can finish the bar on its own. Only the
// answer arriving does that. Same idea as the pill's own in-step easing, one
// level up: unknown totals are reported as "more done than before", never as a
// percentage of a total nobody knows.
//
// Pure functions + a small reducer. No DOM, no network.
// ============================================================

// Research (searching + reading) owns the bar up to this mark; writing the
// answer owns the rest. A run's shape is roughly "research for a while, then
// write one large JSON", so the split reflects where the time actually goes.
const RESEARCH_CEILING = 0.70;
// Time constant in searches: the first search is worth ~16%, the fourth takes
// the bar past halfway, and it flattens after that instead of running out.
const SEARCH_SCALE = 4;

const WRITE_START = 0.72;
const WRITE_CEILING = 0.95; // the last 5% belongs to saving + the real result
const WRITE_SCALE = 5000;   // characters; a full report is several thousand

// How long a step is expected to take, used only to size the pill's creep
// between two real checkpoints — never to decide that a step is done.
const SEARCH_STEP_MS = 20_000;
const WRITE_STEP_MS = 8_000;
const START_STEP_MS = 25_000;

// Where the bar sits once the run has started but has nothing to report yet.
const STARTED = 0.04;

export function researchFraction(searches) {
  const n = Math.max(0, Number(searches) || 0);
  return RESEARCH_CEILING * (1 - Math.exp(-n / SEARCH_SCALE));
}

export function writeFraction(chars) {
  const n = Math.max(0, Number(chars) || 0);
  return WRITE_START + (WRITE_CEILING - WRITE_START) * (1 - Math.exp(-n / WRITE_SCALE));
}

function truncate(text, max) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A retry is the one pause the user should be told the reason for — "rate
// limited, back in 6s" is a different feeling to a bar that stopped.
function retryStage({ status, delayMs }) {
  const secs = Math.max(1, Math.round((Number(delayMs) || 0) / 1000));
  if (status === 429) return `Rate limited — retrying in ${secs}s…`;
  if (status >= 500 || status === 529) return `Claude is busy — retrying in ${secs}s…`;
  return `Connection hiccup — retrying in ${secs}s…`;
}

/**
 * Compact, honest failure text for a settled pill.
 *
 * The toast carries the full message and is gone in seconds; the pill is what
 * the user is still looking at a minute later. "Analysis failed" tells them to
 * go and check the contact record — which is wasted effort when the real
 * answer is "the API was busy, press it again".
 */
export function researchFailureText(err) {
  const status = Number(err && err.status) || 0;
  const code = String((err && err.code) || '');
  const message = String((err && err.message) || '');

  if (status === 429) return 'Rate limited — try again shortly';
  if (status === 529 || status >= 500) return 'Claude was busy — try again';
  if (status === 401 || status === 403) return 'API key rejected — check Setup';
  if (code === 'RESEARCH_STREAM_TRUNCATED') return 'Connection dropped — try again';
  if (code === 'RESEARCH_ROUNDS_EXHAUSTED') return 'Research ran long — try again';
  if (err && err.name === 'TimeoutError') return 'Timed out — try again';
  if (/API key/i.test(message)) return 'No API key — check Setup';
  if (/cut off/i.test(message)) return 'Answer was cut off — try again';
  return 'Analysis failed';
}

/**
 * Build a stateful mapper for one run.
 *
 * Feed it every event from runResearchStream(); it returns either `null`
 * (nothing worth repainting) or `{ stage, from, to, stepMs, percent }`:
 *   • stage   — the line to show
 *   • from/to — where the bar is now and the checkpoint it may creep toward
 *   • stepMs  — how long that creep should take to mostly consume `to - from`
 *   • percent — `from` as a whole number, for compact captions
 *
 * `from` is monotonic by construction: a later event can never report less
 * progress than an earlier one.
 */
export function createResearchProgress({ startStage = 'Researching…' } = {}) {
  const state = {
    round: 0,
    searches: 0,
    chars: 0,
    shown: 0,
    writing: false,
    lastQuery: '',
    sources: 0,
  };

  const at = (fraction, to, stepMs, stage) => {
    state.shown = Math.max(state.shown, Math.min(1, Math.max(0, fraction)));
    const ceiling = Math.min(1, Math.max(state.shown, to));
    return {
      stage,
      from: state.shown,
      to: ceiling,
      stepMs,
      percent: Math.round(state.shown * 100),
    };
  };

  return {
    state,

    /** @returns {null | { stage: string, from: number, to: number, stepMs: number, percent: number }} */
    apply(event) {
      if (!event || typeof event !== 'object') return null;

      switch (event.type) {
        case 'round': {
          state.round = Number(event.round) || 1;
          if (state.round <= 1) {
            return at(STARTED, researchFraction(1), START_STEP_MS, startStage);
          }
          // A continuation is not new progress on its own — the searches it
          // has already done are. Keep the bar where they put it.
          return at(
            researchFraction(state.searches),
            researchFraction(state.searches + 1),
            START_STEP_MS,
            `Still researching — pass ${state.round}…`,
          );
        }

        case 'search': {
          state.searches = Math.max(state.searches, Number(event.search) || state.searches + 1);
          state.lastQuery = String(event.query || '');
          const stage = state.lastQuery
            ? `Searching: ${truncate(state.lastQuery, 44)}`
            : `Running web search ${state.searches}…`;
          return at(
            researchFraction(state.searches),
            researchFraction(state.searches + 1),
            SEARCH_STEP_MS,
            stage,
          );
        }

        case 'results': {
          const sources = Math.max(0, Number(event.sources) || 0);
          state.sources += sources;
          const stage = sources
            ? `Reading ${plural(sources, 'result')} · ${plural(state.searches, 'search')} so far`
            : `Reviewing results · ${plural(state.searches, 'search')} so far`;
          // Same position — results are the other half of the search that
          // already moved the bar. Only the words change.
          return at(
            researchFraction(state.searches),
            researchFraction(state.searches + 1),
            SEARCH_STEP_MS,
            stage,
          );
        }

        case 'narration': {
          // The model reasoning aloud proves it is working but finishes
          // nothing, so the bar holds and only the stage line moves.
          if (state.writing) return null;
          return at(
            state.shown,
            researchFraction(state.searches + 1),
            SEARCH_STEP_MS,
            state.searches ? 'Weighing the evidence…' : 'Reading the CRM record…',
          );
        }

        case 'writing': {
          state.writing = true;
          state.chars = Math.max(state.chars, Number(event.chars) || 0);
          return at(
            writeFraction(state.chars),
            writeFraction(state.chars + 3000),
            WRITE_STEP_MS,
            'Writing the verdict…',
          );
        }

        case 'retry':
          // Hold the bar exactly where it is: a retry undoes the current
          // round's unfinished work, and pretending otherwise either way
          // would misreport it.
          return at(state.shown, state.shown, SEARCH_STEP_MS, retryStage(event));

        case 'pause':
        case 'heartbeat':
        default:
          return null;
      }
    },

    /** The position to hold while the result is written back to the sheet. */
    saving(stage = 'Saving…') {
      return at(Math.max(state.shown, WRITE_CEILING), WRITE_CEILING, WRITE_STEP_MS, stage);
    },
  };
}
