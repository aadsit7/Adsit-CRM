---
name: recast-map-pdf
description: Use this skill whenever the user asks to generate, create, or update a Mutual Action Plan (MAP) PDF, a Meeting Recap PDF, a Biweekly Work-Back Update PDF, or a Pre-Meeting Agenda PDF for a Recast Software sales or partner engagement. Trigger phrases include "create a MAP", "generate a mutual action plan", "create a meeting recap PDF", "build a MAP PDF", "new MAP", "update the MAP", "create a biweekly update", "pre-meeting agenda PDF", and any variation referencing Recast meeting documentation. This skill produces polished, client-safe, branded PDFs shared directly with customers and partners — either during the meeting or immediately after. Always use this skill in preference to generic PDF generation when the context involves Recast meeting documentation, customer engagement summaries, or mutual action planning.
---

# Recast MAP & Meeting Documentation PDF Skill

This skill generates polished, Recast-branded PDFs that document meetings with customers and partners. These documents are client-facing — they are shared directly with the other team, either on-screen during the meeting or immediately after. They build trust, demonstrate professionalism, and ensure both sides leave with a clear, shared understanding of what was discussed, decided, and what happens next.

## How to Use This Skill

**CRITICAL:** Every time you generate a PDF with this skill, you MUST read and adapt the reference ReportLab script at `reference_map_pdf.py` in this skill folder. That script contains the exact layout, colors, spacing, and component patterns proven to produce professional output. Never reinvent the layout from scratch. Copy the script, adapt the content blocks to the specific meeting, and execute it.

**Your job:**
1. Analyze the transcript or content provided by the user
2. Apply the P.C.P. Model internally (see below) — never show this framework to the client
3. Determine the document type (see Document Types below)
4. Run both verification checklists
5. Adapt `reference_map_pdf.py` with the content and execute it to produce the final PDF
6. Save to `/tmp/` or the output directory and return the file path for download

---

## The P.C.P. Model — Internal Analytical Lens

Apply this framework silently during analysis. It sharpens what you capture and how you organize it — but it never appears as a visible section or label in the customer-facing PDF.

**Perception — "What do they believe about the situation?"**
Identifies how each party perceives the problem, the solution, and the path forward. Ensures the document accurately reflects each side's stated position without distortion.
- Extraction signals: Statements of belief, assumptions stated as fact, emotional language, skepticism or enthusiasm, objections framed as questions, comparisons to alternatives or status quo.
- How it shapes the output: Ensures the environment and discussion sections faithfully represent each party's perspective. Pain points, goals, and concerns are captured with the nuance and weight they were given — not flattened into generic summaries.

**Context — "What environment shapes what feels normal to them?"**
Identifies the organizational, technical, and business environment driving decisions.
- Extraction signals: References to internal processes, approval chains, budget cycles, team structure, existing tools, compliance requirements, strategic initiatives, competitive pressures, timelines driven by external factors.
- How it shapes the output: Populates the environment section and organizational context. Ensures action items and the mutual action plan reflect real organizational constraints and approval gates (e.g., "Pending Risk Management review" not just "Follow up").

**Permission — "What is the final 'yes' that turns intention into action?"**
Identifies how close the conversation got to concrete commitments and what gates remain.
- Extraction signals: Forward-leaning language, commitments with names and dates, requests for proposals or introductions, hedging ("we'd need to..."), explicit approvals or deferrals, buying signals or stall signals.
- How it shapes the output: Drives the Mutual Action Plan. Strong permission signals become confirmed milestones. Weak or missing permission signals become pending items. The complete approval chain (each gate the customer described) is captured in sequence.

---

## Document Types

The document structure adapts based on deal stage. The user may also explicitly request a specific type. When in doubt, ask.

### Type 1: Meeting Recap (Early Stage — Discovery, Demo)
Use after initial calls when there's no established action plan yet.

**Page 1 Sections:**
1. Meeting Recap (date, summary, confirmed details)
2. Discussion Summary (topic-by-topic, semantic bullets)
3. Key Decisions & Agreements
4. Action Items (both sides, with owners and timing)
5. Proposed Agenda for Next Meeting

### Type 2: Meeting Recap & Mutual Action Plan (Mid Stage — Technical Validation, POC Planning) **[MOST COMMON]**
Use once both teams have aligned on a structured path forward with milestones and dates.

**Page 1 Sections:**
1. Meeting Recap (date, summary, confirmed key facts as green bullets)
2. Your Current Environment (validated architecture — see Environment Section below)
3. Mutual Action Plan (living checklist — see MAP Section below)

**Page 2:**
4. Systems Architecture Infographic — Current State (diagram of customer's infrastructure)
5. Proposed Application Workspace Architecture (diagram showing how AW maps into their environment)

### Type 3: Biweekly Work-Back Meeting Update
Use for recurring cadence meetings once a MAP is established. The MAP is the standing anchor.

**Page 1 Sections:**
1. Meeting Recap (date, brief summary of what was covered)
2. Mutual Action Plan (updated — statuses moved forward, new items added, completed items checked off)
3. Blockers & Open Items (anything stalled or needing a decision from someone not on the call)
4. Decisions Made Today

**Page 2 (if needed):** Updated architecture diagrams (only if changes were discussed)

### Type 4: Pre-Meeting Agenda
Use before a call to structure the conversation and share with the client.

**Single Page:**
1. Today's Agenda (bulleted topics)
2. Confirmed Details (key facts both sides have validated)
3. Current Environment or Discussion Topics (depending on stage)
4. Suggested Next Steps or Proposed Milestones

---

## The Mutual Action Plan (MAP) — Core Component

The MAP is a living checklist that carries forward across every meeting from the point it's established. It is the accountability mechanism for the engagement.

### MAP Table Structure

| Column | Content |
|---|---|
| Checkbox | ☑ (green, completed) or ☐ (gray, open) |
| Milestone | What needs to happen — bold for major gates |
| Owner | Who is responsible — "Recast", "[Customer] (Name)", "Both teams", etc. |
| Target Date | Specific date or relative timing ("Post-ARB approval") |
| Status | Complete, In Progress, Next, Scheduled, Pending |

### Status Definitions

| Status | Color | Meaning |
|---|---|---|
| Complete | Green `#0F7A3F` | Done. Checked off. |
| In Progress | Amber `#CC8800` | Actively being worked on right now |
| Next | Amber `#CC8800` | The immediate next action to take |
| Scheduled | Amber `#CC8800` | Date confirmed, not yet occurred |
| Pending | Dark Text `#1A1A2E` | Waiting on a prior milestone to complete |

### MAP Sequencing Rules

1. **Capture the customer's complete approval chain.** Every gate the customer describes must be a separate row. If they say "we need to go through risk management, then the ARB, then get budget approval" — that's three rows, in that order.
2. **Budget/pricing approval and POC are separate steps.** In most enterprise deals, budget approval happens before the POC starts. The POC validates the technology. Final purchase decision comes after the POC. Do not combine these.
3. **The standard end-of-deal sequence is:** ...Budget approval → POC kickoff → POC validation → Final purchase decision → Production rollout → Recast onboarding & customer success.
4. **Biweekly meetings are milestones.** Include them in the MAP with confirmed dates so both sides see the cadence.
5. **Scheduling constraints** (vacations, DR tests, holidays) should be noted only if they directly conflict with a scheduled milestone. Do not add notes about events that don't affect any listed date.
6. **New milestones can be added** as conversations reveal additional gates. The MAP grows.
7. **Completed items stay in the MAP** — they provide a visual record of progress and build momentum.

---

## The Environment Section — Reusable Component

Once validated, the customer's environment section appears on every document going forward. It gets updated when new information is confirmed — never silently changed without verification.

### Structure (Three Subsections)

**Core Infrastructure** — The major platforms and tools in their environment. Each as a cyan bullet with the tool name bolded, followed by a brief description and relevant metrics.

**Application Delivery & Configuration** — How apps are currently packaged, delivered, and configured. Legacy tools, virtualization layers, and the specific applications that need to migrate.

**Organizational Context** — Office locations, data center topology, approval processes, licensing constraints, and any external dependencies (like a separate team making a decision that blocks this team).

### Environment Accuracy Rules

1. **Use the customer's exact terminology.** If they say "Avanti," write "Avanti" — not "Ivanti" because you think that's what they meant. If unsure, flag it to the user before generating.
2. **Distinguish between current state and future state.** If FSLogix is not deployed yet but is the planned future tool, say "anticipated as replacement when moving to AVD" — do not list it as a current tool.
3. **Separate tools that are separate.** If RES Workspace Manager and their profile management tool are different products, list them as different bullets. Do not combine.
4. **Spell product names correctly.** XenApp, not ZenApp. ConfigMgr, not Config Manager. Double-check against the transcript.

---

## Systems Architecture Infographic (Page 2)

When the document type calls for it, page 2 contains a visual architecture diagram. This is built with ReportLab Tables styled as colored boxes with arrows showing data flow.

### Current State Diagram Layout
- Blue label bar: "CURRENT STATE — [Brief Description]"
- Row 1: 4–5 management/delivery platform boxes (light gray background, amber background for items with issues)
- Row 2: 3–4 supporting tool boxes (same styling)
- Amber friction bar at bottom: "⚠ Key Friction: [bullet-separated pain points]"

### Proposed State Diagram Layout
- Cyan arrow transition (▼ ▼ ▼) between current and proposed
- Blue label bar: "PROPOSED STATE — Application Workspace as the Unified Delivery Layer"
- Flow diagram: Applications → (arrow) → Application Workspace (large blue box with capabilities listed) → (arrow) → Delivery Targets (stacked boxes)
- End user bar: 3–4 user persona boxes showing consistent experience
- Green outcome bar: "✔ What Changes: [bullet-separated outcomes]"

### Infographic Rules
1. Application Workspace capabilities listed in the blue box must map to the customer's specific pain points. If they need RES replacement, list "Custom Actions (replaces RES)." If they need app attach for non-persistent VDI, list "On-Demand Install / App Attach."
2. Delivery targets must reflect their actual environment. Don't list Windows 365 if they've never mentioned it unless it's a natural expansion path.
3. The amber friction bar and green outcome bar are mirrors. Every friction point should have a corresponding outcome in the proposed state.

---

## Analysis Process (Internal — Never Shown in Output)

### Step 1: Speaker Identification
- When transcripts lack speaker labels, use conversational flow, question/answer patterns, and role indicators to distinguish participants.
- Identify by name when available. Otherwise use role labels: "Recast Team" vs. "[Company Name] Team."
- Note any new participants not seen in previous calls.

### Step 2: Full Transcript Reasoning
- Walk through chronologically. Identify every significant topic, decision, agreement, disagreement, and open question.
- Do not limit coverage. If the call covered 10 topics, capture all 10.
- Pay special attention to the customer's exact words for tool names, process names, and approval gates.

### Step 3: P.C.P. Signal Extraction (Internal Only)
- Use Perception signals to ensure accurate representation of each party's views.
- Use Context signals to capture environment and constraints.
- Use Permission signals to correctly classify items in the MAP as "agreed," "in progress," or "pending."

### Step 4: Cross-Reference Previous Documents
- When previous call transcripts or documents are in context, compare what was captured before against what was said on this call.
- Flag any corrections (spelling, tool names, factual errors) to the user before generating.
- Update the environment section and MAP to reflect the latest confirmed state.

### Step 5: Accuracy Verification Checklist (MANDATORY)
Before generating the PDF, verify:
- [ ] Every tool/product name matches the customer's exact spoken terminology
- [ ] Current-state tools are not confused with future-state plans
- [ ] Approval gates are listed in the sequence the customer described
- [ ] User counts and metrics match what was confirmed on the call
- [ ] No dates or scheduling notes reference events that don't conflict with listed milestones
- [ ] Every milestone owner is correct (Recast vs. customer vs. both)
- [ ] No information was inferred — every claim traces to the transcript

### Step 6: Client-Safe Filtering Checklist (MANDATORY)
Before generating the PDF, scan for and remove:
- [ ] Internal deal stage assessments or win probability signals
- [ ] References to a customer contact's manager, internal politics, or org chart dynamics
- [ ] Verbal approvals that the contact shared informally (keep these for the user, not the PDF)
- [ ] Competitive intelligence or references to competitor pricing
- [ ] Any language that positions one party as "the seller" and the other as "the buyer"
- [ ] Sales terminology: "prospect," "lead," "pipeline," "close," "deal," "objection," "blocker"
- [ ] The PCP framework labels or any meta-commentary about the analysis process

**Important:** When you remove internal intelligence from the PDF, tell the user what you removed and why — so they can track it separately.

---

## Brand Constants (Recast Software)

| Token | Hex | Usage |
|---|---|---|
| Primary Blue | `#0000CC` | Header bar, footer bar, section headers |
| Accent Cyan | `#00BFFF` | Bullet markers, highlights, "+" decorative elements |
| White | `#FFFFFF` | Text on blue backgrounds, card backgrounds |
| Dark Text | `#1A1A2E` | Headlines, bold labels on light backgrounds |
| Medium Gray | `#4A4A5A` | Body text, descriptions |
| Muted Blue | `#AABBEE` | Footer text on blue backgrounds |
| Light Gray | `#F0F0F6` | Section header backgrounds |
| Green | `#0F7A3F` | Confirmed decisions, completed milestones, checkmarks |
| Warn Amber | `#CC8800` | Open questions, items pending confirmation |
| Coral | `#E07050` | Decorative divider (max one per page, use sparingly) |
| Decorator Blue | `#2222DD` | "+" symbols on blue header surfaces |

**Do NOT use Risk Red (`#CC2222`) in customer-facing output.** Red signals internal urgency and reads as alarming to a client. Use Amber for items needing attention.

**Font:** Helvetica / Helvetica-Bold (built into ReportLab — no install needed).

---

## PDF Layout Structure

### Header Bar
- Full-width Primary Blue rectangle, 52pt height
- Left: "Recast" (white bold 18pt) + "Software" (cyan 9pt)
- Right: Document title (white bold 11pt), subtitle with client name and date (muted blue 7.5pt)
- 2–3 decorative "+" symbols in Decorator Blue, asymmetrically placed
- Coral divider line (1.2pt) below the header

### Content Area
- Letter size (8.5" × 11")
- Margins: 0.6" left/right
- Top margin: 0.82" (below header)
- Bottom margin: 0.50" (above footer)

### Section Headers
- Full-width Light Gray background bar, 16pt height
- Text in Primary Blue, Helvetica-Bold 9pt
- 6pt left padding

### Semantic Bullets
- Cyan `●` — Standard discussion points, facts, neutral items
- Green `✔` — Confirmed agreements, completed items, positive outcomes
- Amber `⚠` — Items pending, needing follow-up, constraints
- Action `▶` — Next steps, action items

### Footer Bar
- Full-width Primary Blue rectangle, 22pt height
- Left: "Recast Software | [Document Type]" in Muted Blue 6.5pt
- Right: Date in Muted Blue
- **No "CONFIDENTIAL" tag** — this document is shared with clients

---

## Page Budget Rules

1. **Target: 2 pages.** Page 1 is the recap + MAP. Page 2 is the architecture infographic.
2. **Never sacrifice completeness to force fewer pages.** If the MAP has 16 rows, let it breathe.
3. **If content runs long,** tighten spacing first (reduce leading, spaceBefore/After on bullets, table row padding) before adding a page.
4. **Pre-meeting agendas should be 1 page** whenever possible.
5. **Dense calls with many topics may justify a clean 3-pager.** This is acceptable but not the default.

---

## Tone & Voice Rules for Customer-Facing Output

1. **Collaborative, not transactional.** The document frames the meeting as a shared working session between two teams — not a sales pitch being evaluated. Never use words like "prospect," "lead," "pipeline," "close," "deal," "objection," "blocker," or any internal sales terminology.
2. **Balanced attribution.** Both sides' contributions, concerns, and commitments are represented equally.
3. **Professional warmth.** Polished and organized, but not cold. It should feel like a thoughtful colleague summarized the meeting.
4. **No internal commentary.** Never include deal stage assessments, win probability signals, competitive intelligence notes, or anything the Recast rep would want but the client should not see.
5. **Factual precision.** Every statement is traceable to the transcript. For ambiguous items, use amber markers and neutral language: "To be confirmed" not "Unclear."

---

## Behavioral Rules

1. **Identical structure within each document type, every time.** Sections and their order are fixed for each type. Consistent formatting builds recognition and trust.
2. **Show only the final polished PDF.** Never include reasoning steps, PCP labels, or meta-commentary in the output.
3. **Thoroughness over brevity.** If it was discussed, it's in the document. Missing a topic the client raised is a critical failure.
4. **Bullets, not paragraphs.** Maximum clarity in minimum space. Each line delivers a complete thought.
5. **Explicit over implicit.** If a detail wasn't stated — title, company, timeline, owner — label it clearly rather than guessing.
6. **Accuracy over speed.** Run both verification checklists before presenting. Flag corrections to the user before generating. Getting a product name wrong in a client-facing document undermines everything else.
7. **Separate internal intelligence from client-facing content.** When you identify information that's valuable for the Recast team but inappropriate for the client document, remove it from the PDF and explicitly tell the user what you removed and why.

---

## Edge Cases

- **Multiple unnamed speakers:** Distinguish by role and context. Label as "[Company] Team" vs. "Recast Team."
- **Conflicting information:** Note neutrally with amber marker. If a tool name is unclear, flag it to the user before generating.
- **Vague commitments:** Capture as stated in the MAP with appropriate status. "Timing: To be discussed."
- **Off-topic tangents:** Exclude unless they resulted in action items, decisions, or revealed environment details.
- **Technical gaps / inaudible sections:** Note in the recap: "Note: Portions of the recording were inaudible."
- **Very short calls:** Still produce all applicable sections. If a section has no content, include a one-line note.
- **Non-sales calls (partner syncs, onboarding, support):** Adapt document title naturally but maintain the same structural patterns.
- **Multiple transcripts provided at once:** Analyze all calls chronologically. Build a single document that synthesizes the complete picture. Flag any contradictions between calls.
- **User asks to send document to client:** Run the client-safe filtering checklist one more time. Flag anything you'd reconsider. Confirm the document is ready.

---

## Workflow Summary

```
Transcript(s) In
    → Speaker Identification
    → Full Transcript Analysis
    → Silent P.C.P. Signal Extraction (internal only)
    → Cross-Reference Previous Documents (if available)
    → Determine Document Type
    → Accuracy Verification Checklist
    → Client-Safe Filtering Checklist
    → Read reference_map_pdf.py in this skill folder
    → Adapt content into the reference script's structure
    → Execute the script to produce the branded PDF
    → Return the PDF file path for download
        ├── Page 1: Recap + Environment + Mutual Action Plan
        └── Page 2: Architecture Infographic (Current → Proposed)
```

The P.C.P. Model is the engine. The MAP is the backbone. The Recast brand is the frame. The client sees a polished, collaborative document that makes them think: "These people are organized and they listened."

---

## Honesty & Accuracy Guardrails

When you are unsure or don't have reliable information, say so clearly. Never fabricate sources, citations, statistics, quotes, or URLs. If information is outside the transcript, state that explicitly rather than guessing. Distinguish clearly between what the transcript confirms, what is likely based on context, and what is speculation. Prefer being honest and incomplete over sounding confident and wrong. If a meeting transcript is ambiguous on a material fact (a tool name, a date, an owner), ask the user for clarification before generating the PDF.
