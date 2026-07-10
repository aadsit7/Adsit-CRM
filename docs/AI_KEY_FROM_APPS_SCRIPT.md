# AI Assistant key — managed from Apps Script

The Anthropic API key that powers the AI Assistant (Randy), the MAP/Timeline
PDF generators, and document analysis is **no longer pasted into the Setup
page**. Instead it lives as a **Script Property** on the Google Apps Script
web app, and the portal reads it automatically on load.

## What the portal does now

On a cold load, an admin session calls the Apps Script with
`{ action: 'getConfig' }`. The Apps Script returns the `ANTHROPIC_API_KEY`
Script Property, and the portal caches it in the browser so every existing
AI feature picks it up with no change. See:

- `js/utils/file-api.js` → `syncAiKeyFromBackend()`
- `js/app.js` (calls it on startup for admins)
- `js/views/admin-setup.js` (Setup page now shows a read-only status row
  instead of an input)

## One-time Apps Script change (required)

The portal now expects your Apps Script to answer a new `getConfig` action.
You already store the key as a Script Property — this just exposes it to the
app. **Add** the following to your existing Apps Script; do **not** delete
any of your current `uploadFile` / `listFiles` / `deleteFile` /
`analyzeDocument` / `updateDescription` handlers.

### Step 1 — confirm the Script Property exists

Apps Script editor → **Project Settings** (gear icon) → **Script Properties**:

```
Property: ANTHROPIC_API_KEY
Value:    sk-ant-api03-...your key...
```

### Step 2 — add the handler function

Paste this function anywhere in the script (e.g. at the bottom):

```javascript
function handleGetConfig() {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || '';
  return { ok: true, anthropicApiKey: key };
}
```

### Step 3 — add one line to your `doPost` router

Find your `doPost(e)` function where it reads `payload.action` and routes to
the other handlers. Add this branch alongside the existing ones (the exact
`ContentService` wrapper below matches how your other actions return JSON):

```javascript
if (action === 'getConfig') {
  return ContentService
    .createTextOutput(JSON.stringify(handleGetConfig()))
    .setMimeType(ContentService.MimeType.JSON);
}
```

### Step 4 — redeploy

**Deploy → Manage deployments → Edit (pencil) → Version: New version →
Deploy.** The web app URL stays the same, so no config change is needed in
the portal. Reload the portal and open **Setup** — the "AI Assistant API
Key" row should read *"✓ Connected — key loaded from Apps Script"*.

## Security note

The Apps Script web app is deployed as "Anyone can access" so the static
site can call it without a login. That means `getConfig` returns the key to
any caller who knows the web-app URL. This is the **same exposure level as
before** — previously the key was pasted into the browser and sent on every
Anthropic request from the client — so this change does not make the key
more exposed. If you later want the key to never reach the browser at all,
that's a larger change: route the Anthropic calls *through* the Apps Script
(a proxy) instead of returning the key. That would remove client-side
streaming and touch several files, so it's out of scope for this change.
