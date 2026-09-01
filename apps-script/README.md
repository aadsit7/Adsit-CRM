# Apps Script backend — reference copy

`Code.gs` is the **versioned reference copy** of the Google Apps Script web
app that backs both the Partner Portal (this repo) and the Events Playbook.
The live script runs at script.google.com — GitHub does not deploy it.

## How to ship a change

1. Edit `Code.gs` here (or ask Claude to), so the change is versioned.
2. Open the Apps Script project, select all existing code, and paste the
   whole file over it.
3. Confirm the **Drive API** advanced service is enabled
   (Editor → Services — it should already be there).
4. Redeploy: **Deploy → Manage deployments → Edit (pencil) →
   Version: New version → Deploy.** The `/exec` URL stays the same, so
   nothing changes in the portal or playbook config.

## Access control

The deployment stays "Anyone" (a static site cannot hold a secret), but the
portal-only actions — `getConfig`, `uploadFile`, `listFiles`, `deleteFile`,
`analyzeDocument`, `updateDescription`, `kimiChat` — now require the
signed-in admin's Google OAuth access token, which `requirePortalAdmin_`
verifies against Google's tokeninfo endpoint and the `PORTAL_ADMIN_EMAILS`
list (keep it in step with `ADMIN_EMAILS` in `js/config.js`). The portal
attaches the token automatically (see `js/utils/file-api.js`). Before this
gate, ANY anonymous caller who knew the public `/exec` URL could read the
Anthropic key and write/delete Drive files and sheet rows. The Events
Playbook actions are deliberately NOT gated — that external tool has no
Google sign-in and carries its own event-password model.

**Redeploy required:** until the new `Code.gs` is pasted and redeployed,
the old backend still answers unauthenticated. (The rollout is safe in
either order: the old backend ignores the extra token field, and the new
backend rejects tokenless calls with a clear "reload the portal" message.)

## What the script serves

| Action | Used by | Purpose |
|---|---|---|
| `uploadFile` / `listFiles` / `deleteFile` | Portal | Drive-backed document attachments |
| `analyzeDocument` | Portal (Opportunities) | Generic document → formatted HTML description |
| `analyzeDocument` + `analysisType: 'attendee_list'` | Portal (Events) | Deterministic attendee extraction + title classification; returns HTML card(s) + structured contacts |
| `updateDescription` | Portal | Standardize button (Describe Intelligence) |
| `getConfig` | Portal | Serves the Anthropic key from Script Properties |
| `categorizeLeads` | Playbook | Classifies lead lists with the "Event Lead Categorizer" persona |
| `listEvents` / `openEvent` | Playbook | Event picker + server-side password gate |
| `saveEventContacts` / `listEventContacts` | Playbook | Per-event target list in the `Event_Contacts` tab |
| `savePlaybook` / `loadPlaybook` | Playbook | Per-event playbook state in the `Event_Playbook` tab |
| `analyzePlaybookNotes` | Playbook | AI pass: which playbook activities the event's notes show as complete |

Secrets: the Anthropic key lives in **Script Properties**
(`ANTHROPIC_API_KEY`), never in this file. The spreadsheet and Drive folder
IDs at the top of `Code.gs` are identifiers, not secrets.

## `Event_Playbook` tab contract

`savePlaybook` / `loadPlaybook` own the **`Event_Playbook`** tab the same way
`saveEventContacts` owns `Event_Contacts` — the sheet is created on first save
with this header row, one row per event:

| Column | Meaning |
|---|---|
| `event_id` | The event's stable key (matches `Events.event_id`) |
| `event_title` | Display title (convenience) |
| `stages_json` | The serialized board — a JSON array of `{ key, gate, note, acts:[{ x, o, dt, d }] }`, exactly as the workspace's `pbSerialize()` produces it |
| `updated_at` | ISO timestamp of the last save |

- `savePlaybook` upserts the event's row (replace-in-place; other events'
  rows are never touched), guarded by a script lock.
- `loadPlaybook` returns the keyed shape the workspace's `pbMergeSaved`
  expects: `{ ok, stages: { <stageKey>: { note, acts:[{ i, o, dt, d }] } } }`.
- `analyzePlaybookNotes` reads the event's `Event_Descriptions` notes and asks
  Claude which still-unchecked activities those notes show as complete
  (accuracy-first — it only ever suggests checks, never unchecks).
- The CRM **Event Analyzer** reads `Event_Playbook` through the authenticated
  Sheets client as an *optional* evidence source; it degrades gracefully (a
  non-fatal coverage notice) when the tab is absent or unreadable, so the
  analyzer never depends on it.

> ⚠️ **These three actions are new in this `Code.gs`.** The live Apps Script
> deployment will not serve `savePlaybook` / `loadPlaybook` /
> `analyzePlaybookNotes` (or auto-create the `Event_Playbook` tab) until you
> **manually redeploy** using the steps above. Until then the standalone
> workspace's saves are no-ops and the Event Analyzer simply shows its
> coverage notice — every other evidence source still works.
