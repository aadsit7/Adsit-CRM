# Randy → MAP PDF Generation

Randy produces Recast-branded Mutual Action Plan PDFs by voice command.
The end-to-end flow lives entirely in the browser and reuses the
existing Google Drive upload path the Opportunity modal already uses.

---

## Architecture

```
  Voice "create a MAP PDF for ANICO"
        │
        ▼
  Randy.detectMapPdfIntent()        ┐
  getOpportunityDescription()       │  unchanged from V1
  (pulls Opportunity_Descriptions)  ┘
        │
        ▼
  requestMapPdfJson()                ← standard Messages API, no Skills,
  (ai.js)                             no Files API, no code_execution
        │  structured JSON
        ▼
  buildMapPdf(json, opportunity)     ← jsPDF + jspdf-autotable
  (map-pdf-builder.js)                in the browser — returns Blob
        │  Blob (application/pdf)
        ▼
  blobToBase64()                     ← readAsDataURL, strip prefix
        │
        ▼
  fileApiRequest({ action:'uploadFile', … })
  (admin-opportunities.js, exported)  ← same Apps Script endpoint
        │                              used by the existing drag-drop
        ▼                              dropzone on the Opp modal
  Google Apps Script → Google Drive
        │  { file: { doc_id, file_name, drive_url, date_added } }
        ▼
  Randy renders success card with "View in Drive" button
  + injects row into the open Opportunity modal's Documents list
```

No backend, no server proxy, no shared credentials beyond what the
browser already holds (the user's Anthropic key and the Apps Script
deployment URL baked into `CONFIG.FILE_API_URL`).

---

## JSON schema Claude returns

`requestMapPdfJson()` hard-codes this schema inline in the prompt so
the model knows exactly what to produce. The browser PDF builder
expects this exact shape — if you change either side, update both:

```json
{
  "customer_name": "American National Insurance Company",
  "document_date": "April 22, 2026",
  "meeting_recap": [
    { "label": "Total Users",          "detail": "~4,000 confirmed on the call" },
    { "label": "Pricing delivered",    "detail": "Tiered pricing + Application Workspace overview sent March 6" },
    { "label": "Biweekly cadence",     "detail": "Recurring work-back meetings starting April 2, 2026" }
  ],
  "current_environment": {
    "infrastructure": [
      { "name": "Citrix XenApp / XenDesktop", "subline": "~900 daily users License expires EOY 2026" },
      { "name": "NetScaler",                  "subline": "Load balancing, SSO Replacement pending" },
      { "name": "SCCM / ConfigMgr",           "subline": "" }
    ],
    "current_state_pain":              [ "…3-5 plain-string bullets…" ],
    "stakeholders_and_decision_process":[ "…3-5 plain-string bullets…" ]
  },
  "mutual_action_plan": [
    { "phase": "Discovery", "action": "…", "owner": "Recast",   "due_date": "2026-04-29", "status": "Complete" },
    { "phase": "POC Setup", "action": "…", "owner": "Customer", "due_date": "2026-05-13", "status": "In Progress" }
  ]
}
```

Rules enforced by the prompt:

- `mutual_action_plan` has 12-16 rows covering Discovery → POC Setup →
  Validation → Business Case → Decision → Rollout.
- Each `status` is one of `Complete | In Progress | Pending | Blocked | Not Started`.
- Dates are ISO `YYYY-MM-DD`.
- `document_date` is the current description date in `Month DD, YYYY` format.
- `meeting_recap` is 4-7 `{label, detail}` objects — skim-readable, not
  narrative paragraphs. `label` is a 2-5 word bolded title; `detail` is
  a single concise sentence.
- `current_environment.infrastructure` is 6-10 `{name, subline}` objects.
  `subline` may be empty when the source content does not support a
  specific detail (user counts, license info, etc.).
- **Grounding rules** live in the prompt: every fact must be traceable
  to the source description. The model prefers empty sublines or
  shorter MAPs over invented specifics (license dates, user counts,
  employee names, tool names not in the source).

Parsing is tolerant: even though the prompt says "no markdown fences",
`parseMapJsonResponse()` strips ```` ```json … ``` ```` fences and
trims leading/trailing prose before `JSON.parse()`. It also handles the
**legacy flat-string form** for `meeting_recap` and `infrastructure` —
strings are promoted to `{ label: '', detail: string }` and
`{ name: string, subline: '' }` respectively so V1-shaped responses
don't crash the renderer.

---

## Filename pattern

`MAP_${slug(customer_name)}_${YYYY-MM-DD}.pdf`

- `slug()` replaces whitespace with `_`, drops non-alphanumerics,
  collapses repeated underscores, trims to 60 chars.
- Date is `document_date` from the JSON, coerced to `YYYY-MM-DD`.
- Example: `MAP_American_National_Insurance_Company_2026-04-22.pdf`

---

## Progress pill

Non-blocking overlay inside the Randy window (bottom-right), stacked
if multiple generations are in flight:

| Stage                    | Trigger                               |
|--------------------------|---------------------------------------|
| `Reading description…`   | pill created                          |
| `Reading description…`   | `requestMapPdfJson()` request fired   |
| `Building PDF…`          | JSON parsed successfully              |
| `Saving to Drive…`       | Drive upload started                  |
| `Saved to {customer}` ✓  | upload succeeded (fades after 3s)     |
| `Failed — see card`      | any error (fades after 5s)            |

- Elapsed timer counts every second from creation: `0:00` → `1:23`.
- At 2:30 the spinner goes amber and the stage switches to
  "Taking longer than expected… still trying".
- Hard failure at 4:00 with `Timed out after 4 minutes`.

Multiple pills stack with 8px gap; pills opt back into pointer events
so the user can interact with them (hover to keep on-screen, etc.).

---

## Voice lines

| Moment  | Phrasing                                                                                         |
|---------|--------------------------------------------------------------------------------------------------|
| Intro   | "On it, boss. Generating the MAP PDF for {customer} now — this will take a few seconds."         |
| Success | "Saved to {customer}, boss. The MAP PDF is in the opportunity's documents — link's in the chat." |
| Failure | "{error-specific}. I couldn't generate the MAP PDF for {customer}, boss. Details are in the chat." |

TTS-before-DOM ordering is preserved: `speakText(...)` fires before
`renderMessage(...)`. Speech only plays when Randy is idle
(ACTIVE_LISTENING / PASSIVE) — if the user started a new task during
generation, the card still appears in the chat, silently.

---

## Success card

Rendered inline in the Randy chat on upload success:

- Left-border accent in Recast green (`#0F7A3F`).
- Title row: green checkmark icon + "MAP PDF Saved".
- Customer name subline.
- Filename in monospace mute.
- Primary CTA: "View in Drive" — opens `drive_url` in a new tab.
- Secondary link: "Open the opportunity to see all its documents →"
  navigates to `/admin/opportunities` and opens the edit modal.

## Failure card

- Left-border accent in amber (`#CC8800`).
- Title row: warning triangle + "Couldn't generate MAP PDF — {customer}".
- User-friendly one-line summary that varies by error code
  (`MAP_JSON_INVALID` / `MAP_JSON_SCHEMA` / `MAP_JSON_API_ERROR` /
  timeout / network / Drive upload).
- Collapsible "Show technical details" with the raw error message.
- "Try again" button — re-runs the whole flow against the same
  opportunity.

---

## Troubleshooting

**"Claude's response didn't parse as the expected JSON"** — usually a
transient model hiccup. Retry. If persistent, check the source
description for extremely unusual content that might be confusing
the schema extraction.

**"Claude's JSON is missing required fields"** — same symptom, same
fix: retry. Each retry uses fresh model inference, so flakes are rare
after one successful retry.

**"API key looks invalid"** — the stored Anthropic key returned 401.
Re-enter it on the Setup page.

**"Drive wouldn't take the upload"** — the Apps Script endpoint
returned an error. Most common cause: the opportunity doesn't yet have
an `opportunity_id` (it was never saved). Save the opportunity first,
then retry.

**"That took too long, boss"** — 2-minute timeout. Usually Anthropic
load. Retry.

**Card appears but no voice** — Randy was mid-task when the flow
finished. The card is still usable; voice is intentionally suppressed
in non-idle states to avoid talking over other speech.

---

## Files involved

| Path                                              | Purpose |
|---------------------------------------------------|---------|
| `js/utils/map-pdf-intent.js`                      | Voice intent detection (unchanged) |
| `js/utils/ai.js` → `requestMapPdfJson()`          | Messages-API call returning structured JSON |
| `js/utils/ai.js` → `getOpportunityDescription()`  | Opportunity lookup + description history (unchanged) |
| `js/utils/map-pdf-builder.js`                     | `buildMapPdf()`, `mapFilename()`, `blobToBase64()` |
| `js/components/map-pdf-pill.js`                   | Progress pill lifecycle helpers |
| `js/components/randy.js`                          | Intent routing, success/failure cards, retry wiring |
| `js/views/admin-opportunities.js`                 | `fileApiRequest` (exported), `addFileToActiveDocsPanel` (exported), refactored `buildDocumentsPanel` returning `{panel, addFile, refresh}` |
| `css/randy.css`                                   | Pill + card styling |
| `css/components.css`                              | `.document-row--just-added` flash |
| `tests/*.test.mjs`                                | `node:test` suite |

### Deprecated but retained

| Path                                     | State | Why kept |
|------------------------------------------|-------|----------|
| `skills/recast-map-pdf/SKILL.md`         | Dormant | Visual reference for the approved PDF layout |
| `skills/recast-map-pdf/reference_map_pdf.py` | Dormant | ReportLab template the jsPDF builder mirrors |
| `skills/recast-map-pdf/example_output_reference.md` | Dormant | Approval reference |
| `scripts/upload_recast_map_skill.mjs`    | Deprecated — header comment | In case a future operator wants to revive a Skills-based flow behind a server proxy |
| `js/config/skill_config.js`              | Empty stub | Import-compat shim; safe to delete once no imports reference it |

---

## V2 roadmap (not in this PR)

- Document types beyond MAP: meeting recap, biweekly update, pre-meeting agenda.
- Persist a structured document record in `Partner_Documents` (currently Apps Script owns all upload metadata).
- "Regenerate" button on the success card (today: delete the old file, re-trigger).
- Visual refinement: logo-in-PDF (requires shipping a logo asset with the static site).

---

## V1.1 layout polish (this PR)

Shipped under `feat(map-pdf):`. Functional behaviour unchanged — the
voice flow, intent detection, opportunity match, Drive upload, filename
pattern, success/failure cards and progress pill all work exactly as in
V1. Only the rendered PDF is different.

- **Compact header band.** Page 1 header collapsed from ~180pt to
  ~80pt: Recast wordmark left, "Meeting Recap & Mutual Action Plan" +
  "Recast + {Customer} | {Date}" stacked right, coral divider below.
  Page 1 now has space for all three sections without cramping.
- **Blue heading bars.** Section titles render as solid Recast-blue
  background bars with white text (replaces the V1 underlined text that
  read like broken hyperlinks).
- **Richer meeting recap.** Bullets are `{label, detail}` — bolded
  title, concise detail — instead of long narrative sentences.
- **Customer-specific infrastructure.** Infrastructure bullets are
  `{name, subline}` — tool name in bold, context detail underneath in
  muted type when present.
- **8-layer architecture page.** The generic 3-box Page 3 diagram is
  replaced with a customer-specific transformation story:
  1. "Current Environment — {Customer}" blue heading + intro
  2. 6-10 box grid of the customer's real tools (from
     `current_environment.infrastructure`)
  3. Amber "Key Friction" callout (from `current_state_pain`)
  4. Down-pointing triangle transition
  5. "Proposed State — Application Workspace…" blue heading
  6. Three-column diagram: Applications → APPLICATION WORKSPACE → Targets
  7. End Users persona row (4 boxes)
  8. Green "What Changes" outcome callout
- **Grounding rules in the prompt.** Explicit instructions prevent the
  model from inventing license dates, user counts, employee names, or
  tool names not in the source description.
- **Removed** the V1 "Tailored for {Customer}" footer text on Page 3 —
  the green callout is now the natural conclusion.

---

## V1.5 — click-driven "Generate MAP" button

V1.5 adds a second, deliberately click-driven entry point next to the
voice flow. The existing voice pipeline is untouched: every module that
it invokes (`requestMapPdfJson`, `buildMapPdf`, `mapFilename`,
`fileApiRequest`, and the pill component) is reused by the click path
rather than forked.

### Where it lives

- A new **Generate MAP** button sits next to the existing **Copy**
  button in the Opportunity detail modal's Descriptions section header.
- Styled as the primary/featured CTA: solid Recast Primary Blue
  (`#0000CC`) with white text, so it reads as the hero action vs. the
  secondary Copy treatment.
- Clicking it activates the same checkbox selection mode that Copy
  uses. The confirming CTA dynamically swaps between **Copy Selected**
  and **Generate from Selected (N)** based on which entry button put
  the user in selection mode — a second click on the other button
  switches context without clearing already-checked boxes.

### Flow

```
  Opportunity detail modal
  User clicks "Generate MAP"
         │
         ▼
  Checkboxes appear on each description row
  User checks 1 or more
  User clicks "Generate from Selected (N)"
         │  (no confirmation dialog)
         ▼
  runOppMapPdfFromSelection()                 ← js/views/admin-opportunities.js
         │
         ▼
  Pill mounts at bottom-right of modal
  (scopeContainer = modal backdrop)
         │
         ▼
  generateMapPdfFromSelection()               ← js/utils/map-pdf-from-selection.js
         │
         ▼
  requestMapPdfJsonFromMultiple()             ← js/utils/ai.js
         │  multi-desc synthesis prompt (see below)
         ▼
  buildMapPdf(json)                            ← js/utils/map-pdf-builder.js
         │  same builder, same jsPDF pipeline
         ▼
  mapFilename(customer, today, N)              ← extended to accept sourceCount
         │  → "MAP_Greenshield_2026-04-22_3sources.pdf"
         ▼
  fileApiRequest({ action:'uploadFile', … })   ← js/utils/file-api.js (extracted)
         │
         ▼
  Apps Script → Drive
         │
         ▼
  Success card renders in the modal's Documents slot
  Documents list gets the new file prepended automatically
```

### Multi-description synthesis

When N = 1 the click flow uses `buildMapJsonPrompt` verbatim — the
exact prompt the voice flow has always used. This is a byte-identical
reuse and covered by a regression test.

When N ≥ 2, `buildMapJsonPromptFromMultiple` adds:

1. A synthesis preamble telling Claude there are N equally-weighted
   source entries and that the more recent DATE marker wins on any
   temporal conflict.
2. `--- DATE: YYYY-MM-DD ---` headers before each entry so Claude has
   unambiguous anchoring for conflict resolution.
3. Entries are sorted newest-first regardless of input order.

All grounding rules from the voice flow are preserved — the same
"NEVER invent license dates, user counts, employee names, or tool
names not in the source" directive applies to the multi-source prompt.

### Filename

`mapFilename(customer, dateISO, sourceCount)` — `sourceCount` is
optional:

| `sourceCount` | Filename                                     |
| ------------- | -------------------------------------------- |
| `null` (voice flow) | `MAP_Greenshield_2026-04-22.pdf`       |
| `1`           | `MAP_Greenshield_2026-04-22_1source.pdf`     |
| `3`           | `MAP_Greenshield_2026-04-22_3sources.pdf`    |
| `0`, `-1`, `'3'`, `1.5` | falls back to no-suffix form       |

The `null` path is identical byte-for-byte to V1 — the voice flow keeps
producing its historic filenames without any change.

### Pill anchoring

`createPill()` now accepts an optional `options.scopeContainer`. When
provided, the stack is created inside that container instead of the
global `#randy-root`. The click flow passes the modal backdrop so the
pill positions absolutely at the dialog's bottom-right and tears down
with the modal.

### Success / error cards

The success card renders in a new `.details-modal__map-card-slot`
positioned directly above the Documents list. It shows:

- Green ✓ header "MAP PDF Saved"
- Customer name line
- Monospace filename line
- Primary CTA: **View in Drive** if the Apps Script response included
  a Drive URL, **View in Documents** as a fallback that scrolls and
  highlights the freshly-added file below
- Dismiss X; auto-dismisses after 30s

Failure surfaces the same visual language with amber warning chrome,
an expandable technical-details `<details>` block, and a **Try again**
button that re-runs the entire pipeline with the original selection.

### What this flow does NOT do

- No Randy involvement. Nothing is appended to Randy's chat history;
  no TTS plays.
- No confirmation dialog between click and generation.
- No intent detection — the user explicitly picked the opportunity
  (they're in its modal) and explicitly picked the descriptions (via
  checkboxes).
- No deduplication. Triggering three generations in five minutes
  produces three Drive files.

---

## Grounding Rules (V1.6)

Customer-facing documents should be accurate, not exhaustive. V1.6 tightens
the grounding contract so every fact in a generated MAP is traceable to
something the source description actually says. Sections the source
doesn't support are omitted — silently — rather than padded with
plausible-sounding filler.

### The Golden Rule

> Every fact in the generated PDF must be traceable to a specific phrase
> or sentence in the source description(s). If Claude cannot point to
> the source, it cannot include it. A shorter, accurate MAP beats a
> longer fabricated one every single time.

The prompt spells this out as the very first instruction — ahead of
any schema guidance. Claude is explicitly told:

- **NOT allowed** to infer tool names, fabricate user counts, invent
  license dates, generalize from "common enterprise patterns", or pad
  sections with likely-but-unverified content.
- **Expected** to return empty arrays for sections the source doesn't
  support and empty strings for sublines the source doesn't provide.
- **When uncertain**: leave it out. The renderer silently skips empty
  sections — an empty array is a feature, not a failure.

### How sections become conditional

The renderer applies a uniform rule: **if the content for a section is
empty, skip the section entirely — no heading bar, no placeholder, no
blank space beyond natural page flow.**

| Section                        | When it renders                                      |
|--------------------------------|------------------------------------------------------|
| Meeting Recap                  | Always. Failure to populate is a generation error.   |
| Current Environment heading    | Any of infra / pain / stakeholders is non-empty.     |
| Infrastructure sub-section     | `infrastructure` array is non-empty.                 |
| Current State Pain Points      | `current_state_pain` array is non-empty.             |
| Stakeholders & Decision Process| `stakeholders_and_decision_process` non-empty.       |
| Mutual Action Plan table       | `mutual_action_plan` array is non-empty.             |
| Page 3 — Architecture          | `infrastructure` OR `current_state_pain` non-empty.  |
| Page 3 current-state box grid  | `infrastructure` non-empty.                          |
| Page 3 Key Friction callout    | `current_state_pain` non-empty.                      |
| Page 3 End Users persona row   | `end_users_personas` non-empty.                      |
| Page 3 What Changes callout    | `what_changes` non-empty.                            |

No thresholds. No "skip only if fewer than N items" heuristics. Empty
array → skip is the only rule.

### What's guaranteed in every MAP

- `customer_name` (validated non-empty at parse time).
- Meeting Recap — at least 1 entry; an empty recap is treated as a
  generation failure and surfaces a `MAP_JSON_SCHEMA` error.
- Footer on every page: `Recast Software`, page number, and
  `Confidential — Prepared for {customer}`.

### What's conditional

Everything else. Infrastructure, pain points, stakeholders, MAP table,
Page 3 in its entirety, persona row, What Changes callout — each is
driven by what the source description supports. A MAP from a thin
description ("met with Joe, discussed pricing, sent follow-up") will
render as a clean 2-page document: Meeting Recap + MAP table, nothing
else.

### Parser — `meta.sections_rendered`

`parseMapJsonResponse()` attaches a computed summary so callers can
inspect the shape of the output without re-deriving the predicates:

```json
{
  "meta": {
    "sections_rendered": {
      "recap": true,
      "infrastructure": false,
      "pain": false,
      "stakeholders": true,
      "environment": true,
      "map_table": true,
      "architecture_page": false,
      "personas": false,
      "what_changes": false
    }
  }
}
```

This block is pure derived state — it never comes from Claude.

### Why

The portal lives inside a trust contract with customers: the
Opportunity modal is a system of record, and documents generated from
it are presented to customers as truth. A shorter MAP that says only
what the source supports is more valuable than a longer MAP that pads
with confident-sounding filler. V1.6 makes that the enforced default.
