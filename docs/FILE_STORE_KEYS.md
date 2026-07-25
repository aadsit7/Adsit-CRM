# Attachment keys — one namespace, kept collision-free

Every attachment in the portal — opportunity, event, partner and contact —
lives in **one** Drive-backed store: the `Opportunity_Documents` sheet, written
by the Apps Script `uploadFile` action and read by `listFiles`.

That store keys each row by a **single untyped string** in its
`opportunity_id` column, and `doListFiles` matches it with a loose `==`:

```js
// apps-script/Code.gs
sheet.appendRow([docId, payload.opportunityId, customerName, /* … */]);
…
if (data[i][1] == opportunityId) { /* this row belongs to that key */ }
```

Nothing in the row records which *kind* of record it belongs to. So two records
of different types that share an id value share a document list.

## The collision

Ids the app generates carry a type prefix and cannot collide:

| Entity | Generated id | Where |
| --- | --- | --- |
| Opportunity | `opp_…` | `uuid('opp')` |
| Event | `evt_…` | `uuid('evt')` |
| Partner | `p_…` | `uuid('p')` |
| Contact | `pct_…` | `uuid('pct')` |

Records seeded **before** that convention are numbered from 1. In this
spreadsheet partners run `1`–`9` and events `1`–`8`, so seven ids are claimed by
both a partner and an event. Two were cross-listing for real:

| Key | Partner | Event | The file |
| --- | --- | --- | --- |
| `4` | Insight | Roundtable #2 — Boardroom briefing | Insight's GTM analysis, also visible on the event |
| `7` | Qualcomm | Roundtable #2 — Healthcare | the event's attendee PDF, also visible on Qualcomm |

## The fix: qualify the key, not the record

`js/utils/file-store-keys.js`:

```js
fileStoreKey('partner', '4')                → 'p_4'
fileStoreKey('event',   '4')                → 'evt_4'
fileStoreKey('partner', 'p_1aw6j73z8pfg')   → 'p_1aw6j73z8pfg'   // untouched
```

An id that already declares its type is returned **unchanged**, so every record
the app created keys exactly as it always has and its attachments stay
attached. Only legacy bare ids move. The function is idempotent, and it checks
*all four* prefixes — not just the caller's — so a mistyped call site can never
produce `p_opp_…`.

> **Why not re-key the records themselves?** Changing `partner_id` from `4` to
> `p_4` would ripple through eight sheets of foreign keys (`Opportunities`,
> `Events`, `Transcripts`, `Partner_Contacts`, `Partner_Documents`,
> `Meeting_Index`, `Event_Descriptions`, `Event_Contacts`, `Event_Playbook`),
> every saved URL, and every signed-in partner session — roughly 540 row updates
> — to fix a collision that exists in exactly one place. Qualifying the key at
> the store boundary fixes it where it lives.

### Where it is applied

Partner and event sites only; opportunity and contact ids are already prefixed
in every row, so their call sites are untouched.

| Site | File |
| --- | --- |
| Partner Documents panel | `js/views/admin-partner-detail.js` |
| Partner contact scan (`listFiles`) | `js/views/admin-partner-detail.js` |
| Event Documents panel | `js/views/admin-events.js` |
| Analyzer partner export | `js/views/admin-forecast.js` |
| Analyzer event export | `js/views/admin-forecast.js` |

## Nothing disappears in the meantime

A legacy record's existing rows are under its **bare** id, so the moment the
code asks for the qualified key they would stop being found — until the repair
below is run. Rather than leave real documents invisible on real records for an
unbounded window, the read path bridges it: for a record whose id lacks a
prefix, `listEntityDocuments` also reads the bare key and keeps the rows whose
Drive folder names *this* record (`legacyRowBelongsTo`).

That filter is the point. The bare key is precisely the bucket two records
share, so those rows cannot be handed over wholesale — doing that would *be* the
cross-listing bug. It uses the same signal the repair uses, so **the bridge and
the repair always agree about who owns what**: running the repair never appears
to move a document that was already showing.

Uploads always use the qualified key, so nothing new is ever written to a shared
bucket. Modern records skip the bridge entirely — no extra request.

## Moving the attachments already filed

**Setup → Attachment Keys** makes it permanent:

1. **Check Attachments** — read-only. Builds the plan and lists every row it
   would move, plus anything it refuses to touch. Nothing is written.
2. **Move Attachments** — re-reads and re-verifies first, then writes only the
   `opportunity_id` cell of the listed rows (`updateCells`, RAW, one batch), and
   re-reads again so the report reflects what is actually stored.

### Why the apply re-verifies

**A row number is not an identity in this sheet.** Deleting an attachment runs
`sheet.deleteRow()` in the Apps Script, which physically removes the row and
shifts every row below it up by one. Anyone removing a document from any
Documents panel — in another tab, or another admin — between Check and Move
would silently invalidate the plan's row numbers, and writing to them would
re-key *someone else's* attachment.

So `doc_id` is the identity. At apply time the plan is rebuilt, each change is
located by its `doc_id`, and the cell is written only if that row still holds
the key the plan expected. If anything moved, **nothing is written** and the
report says so. The target column is likewise derived from the sheet's own
header row rather than assumed to be `B`.

### How a row's owner is decided

The only signal in a row is `customer_name` — the Drive folder, which the
uploader copies from the record itself. So:

- folder matches exactly one of the two candidate records → that record;
- folder matches neither, but only **one** record in the whole CRM claims that
  id → that record (there is nothing to be ambiguous about). Opportunities and
  contacts are read for this check too, so an id one of *them* holds makes the
  row ambiguous rather than being assumed to be a partner's;
- anything else → **left alone and reported**. A misfiled document is worse than
  one left where it is, so the planner never guesses.

Re-running is safe: a second pass finds every row already qualified and does
nothing.

## Tests

`tests/file-store-keys.test.mjs` — key qualification and idempotency; that a
partner and an event sharing a numeric id can no longer share a bucket; that an
already-prefixed id is never re-tagged; every branch of the owner resolution,
including the ones that must stay ambiguous; plan idempotency; that the write
follows `doc_id` rather than a stale row number and refuses when a row moved,
was deleted, or was already re-keyed; that the key column is read from the
header; and that the bridge and the migration agree about ownership.
