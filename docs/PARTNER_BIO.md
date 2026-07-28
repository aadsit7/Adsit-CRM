# Partner Bio — researched company profile on the partner page

Every partner's detail page carries an **Analyze** button beside the partner's
name. It researches that company on a fixed list of authoritative public
sources (Anthropic's server-side `web_search` tool) and fills a **Partner Bio**
drop-down section: a profile grid — including live links to the company's
website and LinkedIn page — plus three narrative blocks (*What they do*, *How
Recast brings value*, *Why partner*).

**The profile grid.** Nine facts as label-above-value cells: three to a row on
a full-width panel, two on a narrow one, stacked on a phone. The column count
follows the *panel's* width via a container query, because the panel is the
viewport minus a sidebar that collapses on phones and widens at one breakpoint.
A wordy value (an employee count carrying its source and date, a long industry
line) is clamped to two lines with the full text as its tooltip, so one long
answer cannot stretch the row it sits in. **Copy** is never clamped.

This replaced a full-width Field/Detail table, where nine one-line facts cost
nine tall rows and — `table-layout: fixed` sizes columns from the header row,
which carried no width — half the page went to an empty label column.

This is the complement to the Partner Analyzer, not a replacement for it. The
Analyzer scores **our** relationship from **our** CRM notes; the Bio describes
**their** company from the **public record**. Nothing in the Bio panel comes
from the CRM.

## What the user sees

| State | Hero button | Section |
| --- | --- | --- |
| never researched | **Analyze** | empty state explaining what Analyze does |
| researching | **Analyzing…** (disabled) | previous content, if any |
| researched | **Re-analyze** | profile grid + blocks, `researched <date>` in the header |

The section header repeats the same Analyze button and adds **Copy**, which
puts the profile on the clipboard as markdown in exactly the structure the
research brief specifies (`partnerBioToMarkdown`) — ready to paste into a deal
note or an email.

Clicking the section header collapses or expands it; the choice survives the
full-page re-renders this view performs after every mutation.

**Non-blocking progress.** A run is fire-and-forget: it drives a floating Randy
pill in the global body-fixed stack (`createPill`), so the user can switch tabs
or open another partner while the research continues. Only one bio run happens
at a time (`bioRunInFlight`), the button state is restored on re-render, and
the result is written back by `partner_id` regardless of where the user
navigated. The pill's hard timeout is raised to 20 minutes because a real
research pass legitimately runs for minutes across several rounds.

## The research contract

The methodology lives in `js/utils/partner-bio-prompts.js`, carried verbatim so
the output is the same whether it runs here or by hand.

**Authoritative sources, in priority order.** Crunchbase, LinkedIn, SEC EDGAR,
Bloomberg, Hoovers, Glassdoor, CRN, Channel Futures, ISG, Google News.

"Search exclusively these websites" is enforced by the **API**, not by asking
the model nicely: the `web_search` tool is declared with `allowed_domains` set
to exactly those hosts, so anything else is unreachable for the call. A query
that returns nothing therefore means the answer is not on the authoritative
sources — which is what turns an unverifiable field into an honest `NA`.

**Protocols the prompt states and the parser backs up:**

1. **Cross-reference validation** — every data point confirmed across at least
   three sources; on conflict, prefer SEC filings, then Bloomberg, then
   LinkedIn.
2. **Accuracy threshold** — anything not verifiable to that standard is `NA`.
   Employee counts carry their source and date.
3. **Partner fit classification** — SI · MSP · SI/MSP Hybrid · ISV/Technology
   Partner · OEM · Other, from what the company actually does.
4. **Value tailoring** — Recast's value proposition applied to *this*
   company's operating model and partner category.
5. **Partnership rationale** — why partnering makes sense given their business
   direction, growth and market position.
6. **Competency self-assessment** — an 8-10 rating plus how many sources
   confirmed each data point.
7. **Plain language** — no jargon, no emojis, no decorative symbols.

**The CRM row is a search seed, never a finding.** The prompt passes only
`display_name`, `partner_type`, `region`, `hq_location` and `tier`, explicitly
framed as a starting point: if the sources contradict a seed value the sources
win, and if they cannot confirm it the field is `NA` even when the seed looks
plausible. Credentials, usernames and password hashes never reach the prompt
(enforced by `tests/partner-bio-prompts.test.mjs`).

## The parser enforces correctness, not the model

`js/utils/partner-bio-schema.js` validates every field of the reply:

- unknown, blank, `n/a`, and echoed template placeholders (`[Verified name]`)
  all collapse to the literal **`NA`** the research brief requires;
- **URLs must parse** and use http(s) or they become `NA` — a broken link in
  the grid is worse than an honest `NA`. The LinkedIn field additionally has
  to be a `linkedin.com` URL, and the website field must *not* be a LinkedIn or
  Crunchbase page (those are profiles *of* the company, not its site);
- the **partner fit category** is canonicalized to the allowed set, so the
  badge can never render a label the brief does not define; anything
  unrecognized lands on `Other`;
- **emoji and decorative symbols are stripped** everywhere;
- the **competency rating** is clamped to the 8-10 band and rounded to one
  decimal; a missing rating stays `null` and renders as `NA` rather than
  becoming an invented 8;
- every string and list is length-bounded, which also keeps a stored bio a few
  kilobytes — comfortably inside one Google Sheets cell.

A reply cut off at the token limit is repaired rather than discarded (shared
`extractJsonObject`). A reply with **no** JSON at all throws. A profile that
comes back entirely `NA` is treated as a failed run and never overwrites a
previous good one.

## Storage

`Partner_Bios`, one row per partner, created on first save
(`ensureSheetWithHeaders`) — older spreadsheets simply have no such tab, and
the partner page reads it with a `.catch(() => [])` so its absence can never
break the page.

```
partner_id · partner_name · company_name · industry · website · linkedin_url ·
headquarters · employee_count · partner_fit_category · competency_rating ·
verification_level · bio_json · researched_at · updated_at
```

The flat columns exist so the spreadsheet is readable on its own; `bio_json`
is the source of truth the app re-renders from. A row whose JSON was
hand-edited into something unparseable still yields the profile fields from its
flat columns rather than nothing.

Re-analysis **replaces** the partner's row (`updateRowById` on `partner_id`),
so the tab always shows the current profile rather than a pile of historical
passes. If the research succeeds but the write fails — demo mode, no OAuth
token, a Sheets error — the profile is kept in a session cache and rendered
with a banner saying it was not saved, instead of being silently lost.

## Files

| File | Role |
| --- | --- |
| `js/utils/partner-bio-prompts.js` | The research brief: sources, Recast value proposition, protocols, JSON schema, and the `allowed_domains` list |
| `js/utils/partner-bio-schema.js` | Strict parser, markdown renderer, and the `Partner_Bios` row contract |
| `js/utils/partner-bio-client.js` | Messages API call with `web_search` + the `pause_turn` continuation loop |
| `js/views/admin-partner-detail.js` | Hero button, the collapsible section, the run orchestration and the save |
| `css/partner-bio.css` | Panel and button styling (including the profile grid's column breakpoints) |
| `tests/partner-bio-schema.test.mjs` | Parser, NA discipline, URL rejection, storage round-trip |
| `tests/partner-bio-prompts.test.mjs` | Source list, protocols, seed framing, no secrets |
| `tests/partner-bio-client.test.mjs` | Request shape (pinned tool version + allowlist), pause_turn loop, error paths |

## Model

`claude-opus-5` with the `web_search_20260209` tool. That tool version filters
search results before they reach the context window, which is what makes a
ten-domain sweep affordable in one call; it requires a current Opus, hence the
model choice here differs from the older analyzer clients in this repo.
