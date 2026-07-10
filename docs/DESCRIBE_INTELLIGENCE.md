# Describe Intelligence V1 — AI Standardization with Preservation Rule

## What the Standardize button does

Each description entry in the Opportunity detail modal now has a **✨ Standardize** button.

When clicked, the button:

1. Sends the raw description text to Claude (claude-opus-4-7 via the Anthropic Messages API).
2. Claude classifies the description as either `meeting_recap` or `opportunity_note` and reformats it into the standardized structure for that category.
3. The standardized text is written back to the `Opportunity_Descriptions` sheet (via the Apps Script endpoint).
4. The description card updates in place — no page reload needed.
5. A colored category pill appears next to the description: **🔵 Meeting Recap** or **🟢 Opportunity Note**.

Once a description has been standardized, the **✨ Standardize** button is replaced by a small green **✓** checkmark (tooltip: "Standardized") sitting inline with the category pill. The `category` column in the sheet stores this state.

**This is restructuring, not summarization.** See the Preservation Rule section below.

---

## The Preservation Rule

This is the most important part of the feature. Read it carefully.

The AI is NOT a summarizer. It is NOT allowed to abstract, shorten, or "clean up for brevity." Its only job is to take messy free-form text and reorganize it into a consistent structure **while preserving 100% of the original information.**

### What must be preserved

Every fact, name, number, date, quote, commitment, concern, decision, question, action item, and subjective comment from the original description must appear in the standardized output.

Specific rules enforced in the AI prompt:

1. **No summarization.** If the input has three facts, the output must have all three facts.
2. **No consolidation.** Do not merge similar points. Repetition is signal.
3. **No shortening.** If the output is materially shorter than the input, information has been lost. The output should be approximately the same length or longer.
4. **Preserve specific wording** for quotes, commitments, objections, pricing, dates, and names. "committed to $150k by end of Q2" must stay as "$150k by end of Q2" — not paraphrased.
5. **Preserve ambiguity and qualifiers.** If someone "seemed hesitant but might be open," both the hesitation and the openness are preserved. The AI does not resolve ambiguity.
6. **Preserve the user's voice** in subjective commentary. Notes like "this guy is going to be a pain to work with" or "great vibes, really clicked" are preserved in a Notes section. The AI does not sanitize informal language.
7. **Never invent.** If the input doesn't mention attendees, the Attendees field says "Not specified." The AI does not guess based on context.

### Acceptable changes

- Fixing obvious typos
- Fixing obvious capitalization
- Expanding unambiguous abbreviations
- Adding structural headers and bullets around the existing content
- Reordering content to fit the template structure

### Never acceptable

- Paraphrasing
- Summarizing
- Removing content (even "off-topic" or "informal" content)
- Consolidating multiple bullets into one
- Inferring beyond what's stated
- Adding content to fill out structure
- Changing numbers, dates, or proper nouns

### How to verify the AI did its job

If a human reader can look at the original AND the standardized output and confirm that **every fact from the original appears somewhere in the output** (and nothing new was added), the AI succeeded.

If any fact was lost, merged, paraphrased into something less specific, or invented — the AI failed.

---

## The two categories

### `meeting_recap`

Used when the description documents an actual meeting, call, or live conversation with the customer. Signals: attendee names, meeting date, discussion topics, decisions made during a real-time interaction.

Standardized format:

```
**Meeting Recap — [Date if mentioned, else "Date not specified"]**

**Attendees:** [exact names and organizations as mentioned]

**Discussion Points:**
- [every topic, decision, question, or statement from the input]

**Action Items / Next Steps:**
- [every action item, with owner and deadline exactly as stated]

**Notes:**
[subjective observations, personal reactions, or context — in the user's voice]
```

### `opportunity_note`

Used for everything else: quick updates, internal thoughts, status changes, email summaries, reminders, context, follow-up notes, research findings, next steps captured asynchronously.

Standardized format:

```
**[Date if mentioned, else today's date] — [Type: Internal Note, Email Follow-up, Status Update, etc.]**

[The original content, reorganized into clear paragraphs or bullets.]

**Facts / Commitments:** [specific facts, commitments, or data points — exact wording preserved]

**Notes / Observations:** [subjective commentary in the user's voice]
```

---

## Preservation check logging

After every standardization, the AI returns a `preservation_check` field — a one-sentence self-assessment of whether it preserved all content. This is logged to the browser console with the prefix:

```
[Standardize preservation check] All input information preserved.
```

To audit AI outputs: open the browser DevTools console (F12), click ✨ Standardize on a description, and read the logged preservation check. If the AI reports removing any content, that is a failure.

---

## Manual setup steps

These steps must be completed before the Standardize button becomes functional.

### Step 1: Add the `category` column to your Google Sheet

1. Open your Google Sheet.
2. Go to the **Opportunity_Descriptions** tab.
3. Click on the header of the first empty column after the existing columns (currently column G, after `created_at` in column F).
4. Type `category` as the column header.
5. Save. Existing rows will remain unclassified until their Standardize buttons are clicked.

The sheet header row should now be:
```
description_id | opportunity_id | deal_name | description_date | description_text | created_at | category
```

### Step 2: Add the Apps Script handler

Open your Apps Script web app and add the following function:

```javascript
function handleUpdateDescription(payload) {
  const { opportunityId, descriptionId, category, standardizedText } = payload;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Opportunity_Descriptions');
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const idCol = header.indexOf('description_id');
  const textCol = header.indexOf('description_text');
  const categoryCol = header.indexOf('category');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === descriptionId) {
      sheet.getRange(i + 1, textCol + 1).setValue(standardizedText);
      sheet.getRange(i + 1, categoryCol + 1).setValue(category);
      return { ok: true, descriptionId };
    }
  }
  return { ok: false, error: 'description not found' };
}
```

Then in your main `doPost` router, add:

```javascript
if (action === 'updateDescription') {
  return ContentService
    .createTextOutput(JSON.stringify(handleUpdateDescription(payload)))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Deploy a new version of the Apps Script web app after making this change.

---

## How to manually test

1. Open any Opportunity in the Partner Portal.
2. Click the **⋯** or the opportunity row to open the Details modal.
3. Scroll to the **Descriptions** section.
4. Click **✨ Standardize** on any description entry.
5. Wait for the spinner to finish (usually 5–15 seconds).
6. Confirm the description text has been reformatted AND that all the original facts are present.
7. Open DevTools console and check the `[Standardize preservation check]` log line.
8. Confirm a colored pill (🔵 Meeting Recap or 🟢 Opportunity Note) now appears next to the entry.
9. Open the `Opportunity_Descriptions` Google Sheet tab and confirm the `category` column now has a value for that row.

---

---

## How MAP PDF generation uses standardized structure (V2)

Once descriptions are standardized, the MAP PDF generator in `js/utils/ai.js` (`buildMapJsonPrompt` and `buildMapJsonPromptFromMultiple`) uses the `category` field and section structure to produce higher-quality output.

### Detection

A description is considered standardized if its `category` column in the `Opportunity_Descriptions` sheet is non-empty (`meeting_recap` or `opportunity_note`). The data loader already reads this field — no additional fetching is required. Descriptions without a `category` are treated as legacy free-form notes and handled by the same fallback path as today.

### What the MAP generator now tells Claude

Five directives are injected between the opportunity metadata block and the source content in every MAP generation prompt:

1. **Category awareness** — `meeting_recap` entries are primary customer-facing source material; `opportunity_note` entries are supplementary internal context; uncategorized entries are legacy notes.

2. **Section awareness** — for standardized entries, Claude reads from the specific section most likely to hold a given piece of information rather than scanning the full text as a blob.

3. **Voice separation** — the `Notes` (meeting_recap) and `Notes / Observations` (opportunity_note) sections hold the user's subjective commentary. These are excluded from customer-facing MAP sections (meeting recap bullets, stakeholders, what_changes) but may inform the mutual_action_plan.

4. **Chronological weighting** — when two standardized descriptions contradict, the more recent one wins. Earlier data is preserved as historical context only when materially relevant.

5. **Commitment tracking** — "Action Items / Next Steps" from meeting_recaps and "Facts / Commitments" from opportunity_notes are aggregated chronologically in the mutual_action_plan, with unaddressed commitments flagged.

### Fallback behavior

When all descriptions for an opportunity are unclassified, the MAP generator still works — the same directives are included but a fallback note tells Claude to treat all content as legacy free-form notes and extract what it can. Output is no worse than the pre-V2 baseline.

### Source block labelling

Each description entry in the prompt now carries a category label in its date header:

```
--- DATE: 2026-04-15 | CATEGORY: meeting_recap ---
[Attendees, Discussion Points, …]

--- DATE: 2026-04-10 | CATEGORY: opportunity_note ---
[Internal note content…]

--- DATE: 2026-03-28 | CATEGORY: unclassified ---
[Legacy free-form text…]
```

This makes temporal conflict resolution transparent to Claude and improves synthesis quality when multiple entries exist.

---

## Future suggestions (not implemented in V1)

- **Bulk standardize:** A "Standardize All" button that processes every unclassified description for an opportunity in sequence.
- **Preview mode:** Show the standardized text in a diff view before overwriting, so Aaron can reject bad outputs without the content being written to the sheet.
- **Undo / version history:** The current design relies on the Preservation Rule as the safety net. A "restore original" feature would require storing the pre-standardization text separately.
- **Filter by category:** A filter in the Descriptions section to show only `meeting_recap` or only `opportunity_note` entries.
- **Standardize from the Edit modal:** Currently only available in the Details modal. Could be added to the Edit modal for in-flight descriptions.
