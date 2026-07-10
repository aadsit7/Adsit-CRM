# Known-Good Output Reference

This file describes what a successfully-rendered Recast MAP PDF looks like.
When generating a new MAP PDF, verify your output against these characteristics.
The reference implementation that produces this output is `reference_map_pdf.py`.

---

## Overall

- Letter size (8.5" × 11"), 2 pages total for a standard Type 2 document (Meeting Recap + MAP + Architecture)
- Primary Blue header bar and footer bar on every page
- Coral divider line (thin, 1.2pt) immediately below the header
- White/light background between header and footer
- No "CONFIDENTIAL" tag anywhere — these documents go to clients

## Header Bar (every page)

- Full-width Primary Blue (`#0000CC`) rectangle, 52pt tall
- Left side:
    - "Recast" in bold white 18pt
    - "Software" in cyan (`#00BFFF`) 9pt immediately to the right
- Right side:
    - Document title in bold white 11pt, right-aligned
    - Subtitle in muted blue (`#AABBEE`) 7.5pt beneath it, right-aligned
- 2–3 decorative "+" marks in Decorator Blue (`#2222DD`), 14pt bold, asymmetrically placed in the blue area

## Footer Bar (every page)

- Full-width Primary Blue rectangle, 22pt tall
- Left: "Recast Software | [Document Title]" in Muted Blue 6.5pt
- Right: Meeting date in Muted Blue 6.5pt

## Page 1 — Meeting Recap + Environment + MAP

### Section 1: Meeting Recap

- Section header bar: full-width Light Gray (`#F0F0F6`) background, ~16pt tall, "MEETING RECAP — [DATE]" in bold Primary Blue 9pt, left-padded 6pt
- Recap paragraph: Medium Gray body text, 8pt, 10.5pt line height
- Confirmed facts: 3–6 bullets using GREEN CHECKMARK (`✔`) marker, text in Medium Gray

### Section 2: Your Current Environment

- Section header bar same as above
- Three subsections with bold Dark Text headings (8.5pt):
    1. **Core Infrastructure**
    2. **Application Delivery & Configuration**
    3. **Organizational Context**
- Bullets within each subsection use semantic markers:
    - CYAN CIRCLE (`●`) for neutral infrastructure items
    - AMBER SQUARE (`■`) for constraints, concerns, approval gates
- Tool/product names appear in **bold Dark Text**, followed by em-dash and Medium Gray description
- Line spacing is tight — 9.5pt leading at 7.5pt font

### Section 3: Mutual Action Plan

- Section header bar same as above
- Short intro paragraph below the header
- Table with 5 columns:
    - Checkbox (0.22" wide, filled green `☑` for complete, light gray `☐` for open)
    - Milestone (~46% of content width)
    - Owner (~15%)
    - Target Date (~18%)
    - Status (~18%)
- Header row: Light Gray background, bold Dark Text labels
- Complete rows: Light Green (`#F0FFF0`) background
- Open rows: Alternating White and Row Tint (`#FAFAFE`) backgrounds
- Status cell color:
    - Complete → Green bold
    - In Progress → Amber bold
    - Next → Amber bold
    - Scheduled → Amber regular
    - Pending → Dark Text regular
- Row padding very tight (1.5pt top/bottom) to fit many rows on one page
- Table cell font: 7.5pt, 9.5pt leading
- All 16+ MAP rows fit on page 1 without overflow

## Page 2 — Architecture Infographic

### Intro

- Section header bar: "CURRENT ENVIRONMENT — [CLIENT NAME]"
- Brief intro paragraph in body text

### Current State

- Blue label bar (full-width Primary Blue, white bold text): "CURRENT STATE — [brief description]"
- Row 1: 5 boxes side-by-side, each 50pt tall
    - Items with active issues get amber-tinted (`#FFF8EE`) background with amber border
    - Normal items get Light Gray background with subtle border
    - Each box: bold title, two small center-aligned text lines underneath
- Row 2: 4 boxes, same styling pattern
- Friction bar: full-width amber-tinted background with amber border, "⚠ Key Friction:" in bold amber followed by bullet-separated pain points in Medium Gray

### Transition

- Cyan arrow marker (`▼ ▼ ▼`) centered, 14pt, between current state and proposed state

### Proposed State

- Blue label bar: "PROPOSED STATE — Application Workspace as the Unified Delivery Layer"
- Flow diagram row:
    - LEFT: "Applications" box (Light Gray), listing legacy apps + Setup Store + custom packages
    - ARROW: Cyan right-pointing triangle
    - CENTER: Large "APPLICATION WORKSPACE" blue box (Primary Blue background, white text, ~120pt tall) with:
        - Title in bold white
        - Italic tagline in muted blue: "Package once. Deliver everywhere."
        - 5 capability lines in white, center-aligned
    - ARROW: Cyan right-pointing triangle
    - RIGHT: 3 stacked delivery target boxes (AVD/Nerdio, Intune/SCCM, Windows 365)
- End user bar: light green background, "✔ End Users — Same experience regardless of backend changes"
- Persona row: 4 user persona boxes side-by-side
- Outcome bar: full-width green-tinted background with green border, "✔ What Changes:" in bold green followed by bullet-separated outcomes in Medium Gray

## What "Looks Professional" Means Here

- Consistent vertical rhythm — section headers all same height, bullets tightly grouped
- Color used semantically, never decoratively — green always means confirmed/complete, amber always means attention/pending
- Typography hierarchy clear — bold tool names pop out, bullets scan fast, status column is the eye's landing zone in the MAP
- No visual clutter — generous whitespace around the MAP table, infographic boxes breathe
- Architecture infographic reads left-to-right as a narrative: "here's what you have → here's what Application Workspace replaces → here's what you end up with"
- Every page has the Recast header+footer frame so the document feels like a cohesive branded artifact

## What Would Look Bad (Avoid)

- Risk Red (`#CC2222`) anywhere — this is client-facing, use Amber instead
- Bullets without semantic color (gray bullets are lifeless)
- MAP table spilling to a second page when page 2 is supposed to be architecture
- Inconsistent section header styling page-to-page
- Header bar missing or misaligned on page 2
- Footer missing date or document type
- Boxes in architecture grid with wildly different heights (should be uniform rows)
- Tool names misspelled (Avanti not Ivanti, XenApp not ZenApp, etc.)
- "Prospect" / "lead" / "deal" / "pipeline" / "close" appearing in body text
