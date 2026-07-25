# Analyzer "Create PDF" → auto-attach to the record

Every Analyzer board and brief (`/admin/forecast`) can be exported to a
Recast-branded PDF with the **Create PDF** button. That export is now filed
**automatically onto the record it describes** — the opportunity, event,
partner, **or contact** — in addition to downloading a local copy. No extra
click, no manual "upload to the record" step.

| Analyzer mode | Attaches to | Keyed on | Drive folder |
| --- | --- | --- | --- |
| Opportunity | that opportunity | `opportunity_id` (`opp_*`) | customer name |
| Event | that event | `event_id` (`evt_*`) | event title |
| Partner | that partner | `partner_id` (`p_*`) | partner display name |
| **Contact** | **that contact** | **`contact_id` (`pct_*`)** | **contact name** |

The attached PDF then appears in that record's **Documents** panel the next
time it is opened — the Opportunity / Event edit modals, the Partner Detail
page, and (new — see below) the **Edit Contact** modal.

---

## Why this needed a new capability for contacts

Opportunities, events and partners already had a drag-and-drop, Drive-backed
**Documents** panel (`js/components/documents-panel.js`). Contacts did not — so
before this change there was nowhere for a contact's Account Intelligence Brief
to be filed. The same panel is now mounted on the **Edit Contact** modal
(`js/views/admin-partner-detail.js` → `openContactModal`), giving contacts the
full capability the other three entities have: **upload, list, open, and
remove** files. Saved contacts load their list in the background; a brand-new,
unsaved contact shows a *"Save this contact first to attach documents"* note
because there is no `contact_id` to key on yet.

## Entity-agnostic by design — no backend change

The Apps Script file store (the `Opportunity_Documents` sheet) keys every
attachment by **one id string and never inspects its prefix**
(`doUploadFile` / `doListFiles` / `doDeleteFile` in `apps-script/Code.gs`). So
all four entity types attach and list through the **exact same call**, even
though every entity shares the single backing sheet. **Adding contacts required
no Apps Script change.**

> **Separation is enforced by `fileStoreKey()`.** The store keys on one untyped
> string and `doListFiles` matches it with a loose `==`, so two records of
> different types that share an id value would share a document list. Ids this
> app generates carry a type prefix (`opp_` / `evt_` / `p_` / `pct_`) and cannot
> collide, but rows seeded before that convention can: partners numbered `1`–`9`
> and events `1`–`8` overlap. Partner and event attachments are therefore keyed
> through `fileStoreKey()`
> ([FILE_STORE_KEYS.md](FILE_STORE_KEYS.md)), which qualifies a bare id and
> leaves a prefixed one untouched. Attachments filed before that are moved
> across by the one-time **Setup → Attachment Keys** repair.

## The flow

```
  Analyzer "Create PDF" (any of the 4 modes)
        │
        ▼
  build{Forecast,EventAnalysis,PartnerAnalysis,ContactBrief}Pdf(...)  → Blob
        │
        ▼
  downloadBlob(blob, filename)               ← FIRST, never waits on Drive
        │
        ▼
  autoAttachAnalyzerPdf({ entityId, contextName, filename, blob, recordNoun })
        │   (admin-forecast.js — best-effort wrapper, 120s bound)
        ▼
  attachAnalyzerPdf(...)                     ← js/utils/analyzer-pdf-attach.js
    blobToBase64()                           ← FileReader (map-pdf-builder.js)
    fileApiRequest({ action:'uploadFile',    ← Apps Script upload, no headers
                     opportunityId: entityId,   (file-api.js)
                     customerName: contextName,
                     mimeType:'application/pdf', ... })
    resolveDriveUrl(response)                ← shared resolver (file-api.js)
        │
        ▼
  truthful toast
```

### Best-effort contract (the download never breaks)

`autoAttachAnalyzerPdf()` **never throws**, and — since the ordering fix — the
download genuinely never waits on it: every handler calls `downloadBlob()`
*before* awaiting the upload, so a slow or wedged Apps Script can no longer hold
the local file hostage. The upload is additionally bounded at
`ANALYZER_ATTACH_TIMEOUT_MS` (120s) so the button always reaches a verdict. The
toast tells the truth:

- attached + downloaded → *"PDF attached to the {record} and downloaded"*
- attach failed → *"PDF downloaded, but couldn't attach it to the {record}. Try again."*

A well-formed run always has an id; the missing-id branch is a defensive guard,
never a silent false "attached".

### Naming: the CRM row wins

The Drive folder (`contextName`) and the filename both come from the **CRM
record**, falling back to the model's echo only if the row has no name. The
model can rephrase a customer or partner name, and using its version would file
the export into a folder that matches no other document for that record. The
PDF's printed header keeps its own fallback chain, so nothing about the
document's appearance changed.

### An export is never evidence

Because these PDFs land in the same file store as real uploads, everything that
reads attachments **as evidence** must skip them —
`isAnalyzerExportPdf()` / `withoutAnalyzerExports()` in
`js/utils/analyzer-export-files.js` are the single definition of "a file the
Analyzer wrote". Two consumers apply it:

| Consumer | Why it matters |
| --- | --- |
| `runForecast()` (Opportunity Analyzer) | An unfiltered export is OCR'd into a fresh, today-dated note and then scored on the next run under the prompt's "most recent note wins" rule — the Analyzer grading its own homework, compounding an early misread instead of correcting it. |
| `handleScanContacts()` (partner contact scan) | A Partner Analysis PDF contains the **likely** org chart. The attendee pipeline would read those inferred people back as if the file were a real attendee list, promoting guesses into verified `Partner_Contacts` rows. |

Places that merely **list** files — the Documents panels on the opportunity,
event, partner and contact records — are deliberately unfiltered: seeing the
brief filed there is the whole point of the feature.

## Modules

| Module | Responsibility |
| --- | --- |
| `js/utils/analyzer-pdf-attach.js` | `attachAnalyzerPdf()` — entity-agnostic upload + `ANALYZER_ENTITY_KEYS` mapping |
| `js/utils/analyzer-export-files.js` | What the Analyzer's own filenames look like: `isAnalyzerExportPdf()` / `withoutAnalyzerExports()` (evidence hygiene) and `indexContactAnalyzerPdfs()` / `findContactAnalyzerPdf()` (the contact-brief link) |
| `js/utils/file-api.js` | `fileApiRequest()` + the shared `resolveDriveUrl()` (promoted here as the canonical home) |
| `js/views/admin-forecast.js` | `autoAttachAnalyzerPdf()` best-effort wrapper + truthful toast, wired into all 4 "Create PDF" handlers |
| `js/views/admin-partner-detail.js` | Documents panel on the Edit Contact modal (contact file capability) + the Contacts table's **Analyzer PDF** column |
| `js/components/documents-panel.js` | The reused, entity-agnostic Documents panel (unchanged) |

## Finding a contact's brief from a list

The partner Contacts table links every contact to their brief (see
[PARTNER_CONTACTS.md](PARTNER_CONTACTS.md)). It resolves those links from **one
cached read** of the `Opportunity_Documents` sheet
(`CONFIG.SHEET_OPPORTUNITY_DOCUMENTS`) rather than an Apps Script `listFiles`
per contact — the sheet lives in the same spreadsheet the portal already reads,
so a 40-contact roster costs one request instead of forty. The lookup key is the
contact's `contact_id`: exactly the key the attach wrote and the Documents panel
lists by, so a link can never be an inference from a name.

Tests:

- `tests/analyzer-pdf-attach.test.mjs` — input validation, the exact upload wire
  shape, the entity-agnostic contract across `opp_/evt_/p_/pct_` ids, Drive-URL
  resolution (and a graceful no-URL response), folder fallback, and the
  documented entity → id-field mapping.
- `tests/analyzer-export-files.test.mjs` — the filename matchers pinned against
  all four builders, that a user's own upload is never mistaken for an export,
  and the contact-brief index (entity keying, newest-wins, no cross-entity leak).
- `tests/partner-contacts-analyzer-pdf-column.test.mjs` — the Contacts table's
  column contract and the link/dash/unlinked states of the cell.

Run with `npm test`.
