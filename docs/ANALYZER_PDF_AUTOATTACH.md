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
all four entity types attach and list through the **exact same call**, and the
distinct id prefixes (`opp_` / `evt_` / `p_` / `pct_`) guarantee a file keyed on
one record can never cross-list under another — even though every entity shares
the single backing sheet. **Adding contacts required no Apps Script change.**

## The flow

```
  Analyzer "Create PDF" (any of the 4 modes)
        │
        ▼
  build{Forecast,EventAnalysis,PartnerAnalysis,ContactBrief}Pdf(...)  → Blob
        │
        ▼
  autoAttachAnalyzerPdf({ entityId, contextName, filename, blob, recordNoun })
        │   (admin-forecast.js — best-effort wrapper)
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
  downloadBlob(blob, filename)   +   truthful toast
```

### Best-effort contract (the download never breaks)

`autoAttachAnalyzerPdf()` **never throws**. If Drive is unreachable it returns a
status the caller folds into the toast, and the local download still happens —
so "Create PDF" always produces a file. The toast tells the truth:

- attached + downloaded → *"PDF attached to the {record} and downloaded"*
- attach failed → *"PDF downloaded, but couldn't attach it to the {record}. Try again."*

A well-formed run always has an id; the missing-id branch is a defensive guard,
never a silent false "attached".

## Modules

| Module | Responsibility |
| --- | --- |
| `js/utils/analyzer-pdf-attach.js` | `attachAnalyzerPdf()` — entity-agnostic upload + `ANALYZER_ENTITY_KEYS` mapping |
| `js/utils/file-api.js` | `fileApiRequest()` + the shared `resolveDriveUrl()` (promoted here as the canonical home) |
| `js/views/admin-forecast.js` | `autoAttachAnalyzerPdf()` best-effort wrapper + truthful toast, wired into all 4 "Create PDF" handlers |
| `js/views/admin-partner-detail.js` | Documents panel on the Edit Contact modal (contact file capability) |
| `js/components/documents-panel.js` | The reused, entity-agnostic Documents panel (unchanged) |

Tests: `tests/analyzer-pdf-attach.test.mjs` — input validation, the exact
upload wire shape, the entity-agnostic contract across `opp_/evt_/p_/pct_`
ids, Drive-URL resolution (and a graceful no-URL response), folder fallback,
and the documented entity → id-field mapping. Run with `npm test`.
