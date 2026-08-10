# Contact Analyzer (Analyzer → Contacts tab)

The Analyzer tab (`/admin/forecast`) now supports **four** entity modes:

| Mode | Board | Source of truth |
| --- | --- | --- |
| Opportunity | Sales forecast stages | `js/utils/forecast-stages.js` |
| Event | Event lifecycle | `js/utils/event-analyzer-stages.js` |
| Partner | Partner Maturity | `js/utils/partner-analyzer-stages.js` |
| **Contacts** | **Account Intelligence Brief** | **`js/utils/contact-analyzer-schema.js`** |

Contacts mode lets an administrator pick a **partner**, then one of that
partner's saved contacts, and generate a decision-ready **Account Intelligence
Brief** for that one individual — the same brief the team previously produced by
copying a contact's details into Randy's "Lead Search" preset by hand. Now it is
one click on the Analyzer page, and it exports to a Recast-branded PDF that
matches the reference layout.

> This mode is **view-only**, exactly like the other three Analyzer boards. It
> writes nothing back to the sheet; the brief lives in the background job and is
> re-derivable at any time. (The row-level **LeadCheck** verification stored on
> the `Partner_Contacts` row is separate — see
> [PARTNER_CONTACT_LEADCHECK.md](PARTNER_CONTACT_LEADCHECK.md) — and is *read* by
> this mode as one of its evidence inputs, never overwritten.)
>
> **Exporting the brief attaches it to the contact.** Clicking **Create PDF**
> files the Account Intelligence Brief onto that contact's record (keyed on
> `contact_id`) and downloads a local copy — the same auto-attach every Analyzer
> mode now performs. Contacts gained a Drive-backed **Documents** panel (on the
> Edit Contact modal) for exactly this, matching the capability opportunities,
> events and partners already had. The brief is also linked from the partner
> page's **Contacts** table, in its **Analyzer PDF** column — so the roster
> shows at a glance who has been briefed and when. See
> [ANALYZER_PDF_AUTOATTACH.md](ANALYZER_PDF_AUTOATTACH.md).

---

## The interaction

1. **Partner** dropdown (`buildPartnerSelectorOptions` — the same options the
   Partner mode uses).
2. **Contact** dropdown — repopulated from `Partner_Contacts` filtered to the
   selected partner's `partner_id`. A partner with no saved contacts says so.
3. **Analyze with Randy** — runs the research + synthesis and renders the brief.

The two dropdowns are dependent: choosing a partner clears and refills the
contact list; Analyze enables only when both are chosen.

## How the brief is built

The brief's **methodology comes from the team's tuned "Lead Search" preset**
(`Custom_Prompts` row whose label is "Lead Search", matched case-insensitively;
loaded once via `loadCustomPrompts` and cached). Those instructions are passed
into the prompt as the analytic method + voice, so the output reads the way the
manual copy-into-Randy flow does. If the preset is renamed or missing, a
built-in fallback methodology keeps the feature working.

That methodology is layered over four evidence inputs, all declared **UNTRUSTED
DATA** (evidence, never instructions):

1. **Identity snapshot** — the selected contact's name/role/company/email
   (`buildLeadCheckSnapshot`, phone-free by construction).
2. **The contact's own CRM sources** — the description notes / meetings /
   documents its provenance points at.
3. **Prior LeadCheck verification** — if the row already carries a LeadCheck
   report, it is rendered to plain text and folded in (mirroring the manual
   workflow).
4. **Partner & deal context** — the partner's opportunities and recent partner /
   deal notes, **strictly scoped to the contact's `partner_id`** via the tested
   Partner Analyzer selectors, so another partner's data can never leak in.

Then **live web research** (Anthropic's server-side `web_search` tool, the same
mechanism LeadCheck uses, with a bounded `pause_turn` continuation loop) verifies
the person and discovers the surrounding buying group.

The transport is the shared streaming runner
(`js/utils/anthropic-research-stream.js`), so the brief's pill is driven by the
same evidence as LeadCheck's: each search issued, each result set read, each
chunk of the brief written — never by counting rounds. Its silence budgets
(`CONTACT_IDLE_TIMEOUT_MS`, `CONTACT_STALL_MS`) and its per-round retry come
from there too. See `docs/PARTNER_CONTACT_LEADCHECK.md` for the reasoning.

## The brief (Account Intelligence Brief)

The strict JSON output contract is stated **last** in the prompt and explicitly
overrides any conversational/format directive in the preset, because the reply
is machine-read. Sections (matching the reference PDF):

- **Executive Summary** — company, contact, primary ICP bucket, coverage status
  (green/yellow/red), account maturity, "what this person likely is / is not",
  biggest gap, best next move.
- **Contact Assessment** — likely responsibility, confidence, what they care
  about, Recast focus.
- **Influence Scores** — six dimensions (Technical, Operational, Commercial,
  Budget authority, Partner, Executive visibility) scored 0–10 with a reason.
- **Why This Classification** — points labelled *verified*, *strong inference*,
  or *inference*.
- **Missing Stakeholder Map** — the roles/people not yet engaged, with ICP
  bucket, why needed, and the conversation to have.
- **Likely Organizational Map** — an inferred reporting tree (depth + engagement
  status), explicitly not an official org chart.
- **Account Risk** — overall LOW/MODERATE/HIGH plus factors.
- **Recommended Next Move** — immediate objective, next role to engage, next
  meeting, and a verbatim suggested ask.
- **Seller Focus** — three lists: discuss now / do not force yet / evidence to
  obtain.
- **Sources** — the public URLs used (sanitized to http(s) only).

## Validation philosophy

Unlike the maturity analyzers — whose value is a literal, source-grounded
scoring of fixed criteria — this brief is an **interpretive synthesis**; its
worth is the reasoned inference. So the parser
(`parseContactBriefResponse`) does **not** strip ungrounded prose. What it
guarantees is **structure**: every section present and correctly typed, scores
clamped to 0–10, enums canonicalized, arrays/strings bounded, URLs sanitized, and
a reply cut off at the token limit **salvaged** (the truncated JSON tail is
repaired) rather than discarded — so the board and PDF always render.

## Background-job & mode isolation

Contacts mode owns its own selection and background job (`contactJob`), keyed by a
typed job key (`{ entityType: 'contact', entityId: contactId, runId }`). A run
survives navigation; a new run supersedes the stale one; before any async
response is applied the handler verifies the job is still current, so a stale
Contact-A brief can never render under Contact B, and one mode's result can never
overwrite another's. Opportunity, Event and Partner behavior is unchanged.

## Modules & tests

| Module | Responsibility |
| --- | --- |
| `js/utils/contact-analyzer-schema.js` | Brief schema example, structural parser/validator (enum canon, score clamp, truncation salvage, URL sanitize), board derivation |
| `js/utils/contact-analyzer-prompts.js` | Prompt builder (preset methodology + evidence + output contract) and partner-context assembler |
| `js/utils/contact-analyzer-client.js` | Evidence prep (`prepareContactBrief`) + Anthropic `web_search` research loop (`requestContactBriefJson`) |
| `js/utils/contact-analyzer-pdf-builder.js` | Recast-branded PDF (`Account_Brief_{slug}_{YYYY-MM-DD}.pdf`) |
| `js/views/admin-forecast.js` | Analyzer view — adds Contacts mode (isolated state/job) |
| `css/contact-analyzer.css` | Brief board styling |

Tests: `tests/contact-analyzer-{schema,prompts,client}.test.mjs` — score
clamping, enum canonicalization, truncation salvage, URL sanitize, empty-section
resilience, prompt composition (preset methodology + output-contract precedence),
partner-scope isolation, and LeadCheck fold-in. Run with `npm test`.

**No Google Sheet or Apps Script change is required** — the Account Intelligence
Brief framework lives entirely in these pure JavaScript modules, and the mode
reads existing sheets (`Partner_Contacts`, `Custom_Prompts`, and the partner's
transcripts / meetings / documents / opportunities) plus live web search.
