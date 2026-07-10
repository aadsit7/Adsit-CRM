// ============================================
// MAP PDF Intent Detection
// ============================================
// Detects when the user is asking Randy to generate a Mutual Action Plan
// (MAP) / meeting recap PDF for an opportunity, and pulls the opportunity
// hint out of the sentence so we know which deal to pull from the sheet.
//
// This is a narrow, pattern-matched intent — deliberately restricted to
// verb-phrase triggers so we don't false-positive on stray words like
// "map" in "show me on a map". When a user is more elliptical, the
// triggered flag can still fire with a null opportunityHint, in which
// case Randy will ask "which opportunity, man?".
//
// Pure function, no side effects — easy to unit test.

// Verb-phrase triggers. Each entry must match a reasonable English sentence
// form; we compile them all into one regex for speed.
//
// Note: the word "map" is overloaded, so triggers that could false-positive
// (e.g. a bare "map") are intentionally absent. Every pattern below pairs
// "map" (or "mutual action plan" / "meeting recap") with a creation verb
// or the "pdf" noun marker.
const TRIGGER_PATTERNS = [
  // create/generate/build a MAP (with or without PDF)
  /\b(?:create|generate|build)\s+(?:a|the)\s+map(?:\s+pdf)?\b/i,
  // "create map pdf" (no article)
  /\b(?:create|generate|build)\s+map\s+pdf\b/i,
  // make a/me a MAP pdf (PDF required — "make a map" alone is ambiguous)
  /\bmake(?:\s+me)?\s+(?:a|the)\s+map\s+pdf\b/i,
  // new MAP / new MAP PDF
  /\bnew\s+map(?:\s+pdf)?\b/i,
  // update the MAP / update MAP PDF
  /\bupdate\s+(?:a\s+|the\s+)?map(?:\s+pdf)?\b/i,
  // mutual action plan (with or without "pdf")
  /\b(?:create|generate|build|make|new|update(?:\s+the)?)\s+(?:a\s+|the\s+)?mutual\s+action\s+plan(?:\s+pdf)?\b/i,
  // bare "mutual action plan pdf" / "meeting recap pdf" forms
  /\bmutual\s+action\s+plan\s+pdf\b/i,
  /\bmeeting\s+recap\s+pdf\b/i,
];

// Words that commonly trail an opportunity hint and should be stripped so
// "ANICO opportunity" → "ANICO" and "Fabrikam deal" → "Fabrikam".
const TRAILING_QUALIFIERS = /\s+(?:opportunity|opportunities|deal|deals|account|accounts|map|mutual\s+action\s+plan|pdf|now|please|boss|thanks)\s*$/i;

function stripTrailingQualifiers(s) {
  let out = s;
  // Strip qualifiers iteratively — "ANICO opportunity now please" → "ANICO"
  for (let i = 0; i < 4; i++) {
    const next = out.replace(TRAILING_QUALIFIERS, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function cleanHint(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // Drop leading articles / fillers
  s = s.replace(/^(the|a|an|my|our)\s+/i, '');
  // Drop trailing punctuation
  s = s.replace(/[.?!,;:]+$/g, '').trim();
  s = stripTrailingQualifiers(s);
  if (!s) return null;
  // If all that's left is a qualifier we'd strip, bail out.
  if (/^(?:opportunity|deal|account|map|pdf)$/i.test(s)) return null;
  return s;
}

// Given the user's message, look for "for X" / "on X" clauses that name
// the opportunity. Returns the extracted hint or null.
function extractOpportunityHint(message) {
  // Prefer the LAST such clause in the sentence — if the user says
  // "create a MAP PDF — the one for ANICO", the "for ANICO" is the hint.
  const patterns = [
    /\b(?:for|on)\s+(?:the\s+)?([^.?!,;:]+?)(?=[.?!,;:]|$)/gi,
    /\babout\s+(?:the\s+)?([^.?!,;:]+?)(?=[.?!,;:]|$)/gi,
  ];
  let lastMatch = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(message)) !== null) {
      lastMatch = m[1];
    }
  }
  return cleanHint(lastMatch);
}

/**
 * Detect whether the user is asking for a MAP PDF and, if so, what
 * opportunity they named.
 *
 * @param {string} userMessage
 * @returns {{ triggered: boolean, opportunityHint: string | null }}
 */
export function detectMapPdfIntent(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') {
    return { triggered: false, opportunityHint: null };
  }
  const msg = userMessage.trim();
  const matched = TRIGGER_PATTERNS.some(re => re.test(msg));
  if (!matched) return { triggered: false, opportunityHint: null };
  return { triggered: true, opportunityHint: extractOpportunityHint(msg) };
}
