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

Secrets: the Anthropic key lives in **Script Properties**
(`ANTHROPIC_API_KEY`), never in this file. The spreadsheet and Drive folder
IDs at the top of `Code.gs` are identifiers, not secrets.
