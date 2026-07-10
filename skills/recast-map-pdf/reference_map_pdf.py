"""
RECAST MAP PDF — REFERENCE TEMPLATE
===================================
This is the authoritative layout reference for all Recast Meeting Recap / Mutual
Action Plan PDFs. When generating a new MAP PDF, COPY THIS SCRIPT AND ADAPT THE
CONTENT BLOCKS — do not rewrite the layout from scratch.

Layout components proven in production:
- Branded header bar with logo, title, subtitle, and decorative "+" marks
- Coral divider line beneath header
- Section header bars (light gray background, blue bold text)
- Semantic bullet lists (cyan / green / amber / action)
- MAP table with checkbox + milestone + owner + date + status columns
- Footer bar with document type and date
- Page 2 architecture infographic (current state → proposed state)

The content of each block is PLACEHOLDER DATA from the ANICO / American National
Insurance sample. Replace the CONTENT constants near the top with the new
meeting's data; leave the layout functions and STYLE constants alone.

Requirements:
    pip install reportlab
"""

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, Flowable,
)
from reportlab.pdfgen import canvas


# =============================================================================
# BRAND CONSTANTS — DO NOT MODIFY
# =============================================================================

PRIMARY_BLUE   = colors.HexColor("#0000CC")
ACCENT_CYAN    = colors.HexColor("#00BFFF")
WHITE          = colors.HexColor("#FFFFFF")
DARK_TEXT      = colors.HexColor("#1A1A2E")
MEDIUM_GRAY    = colors.HexColor("#4A4A5A")
MUTED_BLUE     = colors.HexColor("#AABBEE")
LIGHT_GRAY     = colors.HexColor("#F0F0F6")
ROW_TINT       = colors.HexColor("#FAFAFE")
QUOTE_BG       = colors.HexColor("#F6F8FF")
GREEN          = colors.HexColor("#0F7A3F")
GREEN_BG       = colors.HexColor("#F0FFF0")
WARN_AMBER     = colors.HexColor("#CC8800")
AMBER_BG       = colors.HexColor("#FFF8EE")
CORAL          = colors.HexColor("#E07050")
DECORATOR_BLUE = colors.HexColor("#2222DD")
BOX_BORDER     = colors.HexColor("#DDDDEE")

# Bullet markers (semantic)
BULLET_INFO    = "\u25CF"  # ● cyan — neutral
BULLET_GREEN   = "\u2714"  # ✔ green — confirmed / complete
BULLET_AMBER   = "\u25A0"  # ■ amber — pending / in-progress (matches sample)
BULLET_ACTION  = "\u25B6"  # ▶ action
CHECK_COMPLETE = "\u2611"  # ☑
CHECK_OPEN     = "\u2610"  # ☐
ARROW_DOWN     = "\u25BC"  # ▼


# =============================================================================
# PAGE LAYOUT CONSTANTS — DO NOT MODIFY
# =============================================================================

PAGE_WIDTH, PAGE_HEIGHT = letter   # 612 x 792 pt
LEFT_MARGIN   = 0.6 * inch
RIGHT_MARGIN  = 0.6 * inch
TOP_MARGIN    = 0.82 * inch        # below the header
BOTTOM_MARGIN = 0.50 * inch        # above the footer
CONTENT_WIDTH = PAGE_WIDTH - LEFT_MARGIN - RIGHT_MARGIN

HEADER_HEIGHT = 52
FOOTER_HEIGHT = 22


# =============================================================================
# CONTENT — REPLACE THIS BLOCK WITH THE NEW MEETING'S DATA
# =============================================================================

# --- Document metadata (always required) ---
DOC_TITLE        = "Meeting Recap & Mutual Action Plan"
DOC_SUBTITLE     = "Recast + American National Insurance | March 19, 2026"
CLIENT_NAME      = "American National Insurance"
MEETING_DATE     = "March 19, 2026"
OUTPUT_FILENAME  = "ANICO_Recast_MAP_3_19_26.pdf"

# --- Page 1, Section 1: Meeting Recap paragraph + confirmed facts ---
RECAP_SECTION_TITLE = f"MEETING RECAP — {MEETING_DATE.upper()}"
RECAP_PARAGRAPH = (
    "Today's session completed the technical validation with no outstanding technical "
    "questions from the ANICO team. Both teams confirmed the current environment "
    "architecture and aligned on a mutual action plan to move through Risk Management "
    "review, Architectural Review Board approval, and Proof of Concept kickoff."
)
# Confirmed facts shown as green checkmark bullets
CONFIRMED_FACTS = [
    "Total Users (Company-Wide): ~4,000 (confirmed on call)",
    "Citrix VDI / XenApp Users (Avg. Daily): ~900 (confirmed on call)",
    "Pricing delivered: Joe provided user counts Mar 6; David sent finalized tiered pricing and Application Workspace overview",
    "No outstanding technical questions — ANICO confirmed readiness to move forward",
    "Biweekly cadence established: Recurring work-back meetings starting April 2, 2026",
]

# --- Page 1, Section 2: Current Environment ---
# Three subsections: Core Infrastructure, Application Delivery & Configuration, Organizational Context
ENVIRONMENT_SECTIONS = [
    {
        "title": "Core Infrastructure",
        "bullets": [
            ("info", "**Citrix XenApp / XenDesktop** — Primary virtual app and VDI delivery (~900 avg. daily users). License expires end of 2026."),
            ("info", "**Nerdio + Azure Virtual Desktop** — Target VDI platform. Non-persistent sessions drained weekly. Pilot pending NetScaler decision."),
            ("info", "**SCCM / ConfigMgr + Microsoft Intune** — On-prem and cloud-managed Windows endpoints for ~4,000 users company-wide."),
            ("info", "**NetScaler** — Load balancing, content switching, SSO. Separate team evaluating replacement. Evaluation and approvals can proceed in parallel, but no implementation until NetScaler decision is made."),
        ],
    },
    {
        "title": "Application Delivery & Configuration",
        "bullets": [
            ("info", "**RES Workspace Manager** — Legacy app config at launch: env vars, drive mappings, registry, license files. Team seeking replacement."),
            ("info", "**Avanti (User Profile Mgmt)** — Current profile management tool. Database-backed — captures desktop settings, Office/Microsoft customizations, and folder redirection. FSLogix anticipated as replacement when moving to AVD."),
            ("info", "**AppV / ELM App Learning** — Legacy app virtualization with limited forward path."),
            ("info", "**~12 Legacy Applications** — ~6 critical. Require custom config (registry, env vars, drive maps) currently handled by RES."),
        ],
    },
    {
        "title": "Organizational Context",
        "bullets": [
            ("info",  "**Three office locations** — Texas (data center), Missouri, New York. Content distribution needs driven by data center consolidation to TX."),
            ("amber", "**Citrix universal licensing** — Overlapping cost concern if new tooling deployed before NetScaler decision finalized."),
            ("amber", "**Risk Management (separate from ARB)** — Security and legal review gate. Joe submitting paperwork; Risk Mgmt team will contact Recast directly for documentation exchange."),
            ("amber", "**Architectural Review Board** — Meets monthly (beginning of month). Provides up/down approval for POC."),
        ],
    },
]

# --- Page 1, Section 3: Mutual Action Plan ---
# Each row: (milestone, owner, target_date, status)
# Status must be one of: "Complete", "In Progress", "Next", "Scheduled", "Pending"
MAP_INTRO = "The following checklist outlines the agreed-upon milestones, owners, and target dates for both teams:"
MAP_ROWS = [
    ("Technical demonstration completed", "Recast", "Mar 5", "Complete"),
    ("User counts provided & pricing delivered", "Both teams", "Mar 6", "Complete"),
    ("Technical validation & environment review — no outstanding questions", "Both teams", "Mar 19", "Complete"),
    ("Joe to submit Risk Management paperwork — Risk Mgmt has responded; Joe completing intake form", "ANICO (Joe)", "This week", "In Progress"),
    ("Risk Mgmt team to contact Recast directly — security/legal documentation exchange", "ANICO → Recast", "Upon Joe's submission", "Next"),
    ("Recast to respond to security questionnaire & provide Trust Center documentation", "Recast", "Within 1 week of receipt", "Pending"),
    ("Risk Management review completed", "ANICO", "Before ARB submission", "Pending"),
    ("Biweekly work-back meeting #1", "Both teams", "Apr 2", "Scheduled"),
    ("Architectural Review Board submission — up/down approval for POC", "ANICO (Joe)", "First week of Apr", "Pending"),
    ("Biweekly meeting #2", "Both teams", "Apr 16", "Scheduled"),
    ("Submit for budget approval — internal business case and pricing approval", "ANICO", "Post-ARB approval", "Pending"),
    ("Proof of Concept kickoff — agent deployment, initial app set, first user group", "Both teams", "Post-budget approval", "Pending"),
    ("POC validation & expansion", "Both teams", "4–6 weeks post-kickoff", "Pending"),
    ("Final purchase decision — pending successful POC results", "ANICO", "Post-POC", "Pending"),
    ("Production rollout", "Both teams", "Post-approval", "Pending"),
    ("Recast onboarding & customer success — guided rollout, adoption tracking, and ongoing success engagement", "Recast", "Post-go-live", "Pending"),
]

# --- Page 2: Architecture Infographic ---
ARCH_INTRO_TITLE = f"CURRENT ENVIRONMENT — {CLIENT_NAME.upper()}"
ARCH_INTRO_TEXT = (
    "Based on our conversations, the following reflects your current systems "
    "architecture and the key infrastructure components involved in application delivery."
)

CURRENT_STATE_LABEL = "CURRENT STATE — Per-Platform Delivery, Multiple Dependencies"

# Row 1: 5 management/delivery platform boxes. Each box: (title, line2, line3, "normal"|"amber")
CURRENT_ROW_1 = [
    ("Citrix XenApp / XenDesktop", "~900 daily users", "License expires EOY 2026", "amber"),
    ("NetScaler",                   "Load balancing, SSO", "Replacement pending", "amber"),
    ("SCCM / ConfigMgr",           "On-prem Windows", "device management", "normal"),
    ("Microsoft Intune",           "Cloud-managed", "endpoints", "normal"),
    ("Nerdio + AVD",               "VDI pilot", "Non-persistent sessions", "normal"),
]
# Row 2: 4 supporting tool boxes
CURRENT_ROW_2 = [
    ("RES Workspace Mgr",  "Env vars, drive maps", "registry, license files", "amber"),
    ("Avanti (Profiles)",  "Database-backed UPM", "Desktop settings, folder redir", "normal"),
    ("AppV / ELM",         "Legacy app virtualization", "Limited forward path", "amber"),
    ("~12 Legacy Apps",    "~6 critical", "Require custom config", "amber"),
]

FRICTION_POINTS = [
    "Each app rebuilt per platform",
    "RES has no modern replacement path",
    "NetScaler decision blocks implementation (evaluation can proceed)",
    "Citrix license deadline creates urgency",
    "Non-persistent VDI needs app reattach every session",
    "Three office locations (TX, MO, NY) with data center in Texas",
]

PROPOSED_STATE_LABEL = "PROPOSED STATE — Application Workspace as the Unified Delivery Layer"

APPLICATIONS_BOX = {
    "title": "Applications",
    "lines": ["~12 legacy apps", "4,694+ Setup Store", "Custom packages"],
}

# The Application Workspace blue box
AW_CAPABILITIES = [
    "Smart Icons • Conditional Launch",
    "Custom Actions (replaces RES)",
    "On-Demand Install / App Attach",
    "Identity-Based • Context-Aware",
    "User Profile Mgmt (coming soon)",
]

# Delivery target boxes (right side of flow)
DELIVERY_TARGETS = [
    ("AVD / Nerdio",    "Non-persistent VDI", "~900 daily users"),
    ("Intune / SCCM",   "Physical endpoints", "Co-managed"),
    ("Windows 365",     "Cloud PCs", "Future expansion"),
]

# End user persona boxes
USER_PERSONAS = [
    ("Office Workers (TX, MO, NY)", "Standard desktops", ""),
    ("Remote / Hybrid",             "Home + travel", "VPN-aware routing"),
    ("VDI Users",                   "Non-persistent sessions", "Apps on demand"),
    ("External Users",              "Internal web apps", "Secure access"),
]

OUTCOMES = [
    "RES eliminated",
    "Per-platform packaging eliminated",
    "Citrix-to-AVD migration absorbed without user disruption",
    "Non-persistent VDI apps delivered on demand",
    "Single console for ~4,000 users across all delivery targets",
    "Content served locally from satellite servers per office location",
]


# =============================================================================
# PARAGRAPH STYLES
# =============================================================================

styles = getSampleStyleSheet()

STYLE_BODY = ParagraphStyle(
    "Body", parent=styles["Normal"],
    fontName="Helvetica", fontSize=8, leading=11,
    textColor=MEDIUM_GRAY, alignment=TA_LEFT, spaceBefore=0, spaceAfter=0,
)
STYLE_RECAP = ParagraphStyle(
    "Recap", parent=STYLE_BODY, fontSize=8, leading=10.5, spaceAfter=4,
)
STYLE_SECTION_SUB = ParagraphStyle(
    "SectionSub", parent=STYLE_BODY,
    fontName="Helvetica-Bold", fontSize=8.5, leading=11,
    textColor=DARK_TEXT, spaceBefore=3, spaceAfter=1,
)
STYLE_BULLET = ParagraphStyle(
    "Bullet", parent=STYLE_BODY, fontSize=7.5, leading=9.5,
    leftIndent=12, spaceBefore=0, spaceAfter=0,
)
STYLE_MAP_CELL = ParagraphStyle(
    "MAPCell", parent=STYLE_BODY, fontSize=7.5, leading=9.5, textColor=DARK_TEXT,
)
STYLE_MAP_CELL_COMPLETE = ParagraphStyle(
    "MAPCellComplete", parent=STYLE_MAP_CELL, textColor=MEDIUM_GRAY,
)
STYLE_INFO_INTRO = ParagraphStyle(
    "InfoIntro", parent=STYLE_BODY, fontSize=8, leading=11, spaceAfter=4,
)
STYLE_BOX_TITLE = ParagraphStyle(
    "BoxTitle", parent=STYLE_BODY,
    fontName="Helvetica-Bold", fontSize=8, leading=10,
    textColor=DARK_TEXT, alignment=TA_CENTER,
)
STYLE_BOX_LINE = ParagraphStyle(
    "BoxLine", parent=STYLE_BODY, fontSize=6.5, leading=8.5,
    textColor=MEDIUM_GRAY, alignment=TA_CENTER,
)
STYLE_AW_TITLE = ParagraphStyle(
    "AWTitle", parent=STYLE_BODY,
    fontName="Helvetica-Bold", fontSize=9.5, leading=12,
    textColor=WHITE, alignment=TA_CENTER,
)
STYLE_AW_LINE = ParagraphStyle(
    "AWLine", parent=STYLE_BODY, fontSize=7, leading=9.5,
    textColor=WHITE, alignment=TA_CENTER,
)


# =============================================================================
# HEADER / FOOTER — drawn via canvas (onPage callback)
# =============================================================================

def _draw_header_and_footer(c: canvas.Canvas, doc):
    """Draw the branded header bar at top and footer bar at bottom of every page."""
    _draw_header(c)
    _draw_footer(c)


def _draw_header(c: canvas.Canvas):
    # Primary blue header rectangle
    c.setFillColor(PRIMARY_BLUE)
    c.rect(0, PAGE_HEIGHT - HEADER_HEIGHT, PAGE_WIDTH, HEADER_HEIGHT, stroke=0, fill=1)

    # Decorative "+" marks — 3 asymmetrically placed
    c.setFillColor(DECORATOR_BLUE)
    c.setFont("Helvetica-Bold", 14)
    for x, y in [(35, PAGE_HEIGHT - 14),
                 (110, PAGE_HEIGHT - 38),
                 (PAGE_WIDTH - 180, PAGE_HEIGHT - 18)]:
        c.drawString(x, y, "+")

    # Logo: "Recast" bold white + "Software" cyan
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(LEFT_MARGIN, PAGE_HEIGHT - 32, "Recast")
    recast_w = c.stringWidth("Recast", "Helvetica-Bold", 18)
    c.setFillColor(ACCENT_CYAN)
    c.setFont("Helvetica", 9)
    c.drawString(LEFT_MARGIN + recast_w + 4, PAGE_HEIGHT - 29, "Software")

    # Right side: document title + subtitle
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 11)
    title_w = c.stringWidth(DOC_TITLE, "Helvetica-Bold", 11)
    c.drawString(PAGE_WIDTH - RIGHT_MARGIN - title_w, PAGE_HEIGHT - 22, DOC_TITLE)

    c.setFillColor(MUTED_BLUE)
    c.setFont("Helvetica", 7.5)
    sub_w = c.stringWidth(DOC_SUBTITLE, "Helvetica", 7.5)
    c.drawString(PAGE_WIDTH - RIGHT_MARGIN - sub_w, PAGE_HEIGHT - 36, DOC_SUBTITLE)

    # Coral divider line below header
    c.setStrokeColor(CORAL)
    c.setLineWidth(1.2)
    y = PAGE_HEIGHT - HEADER_HEIGHT - 4
    c.line(LEFT_MARGIN, y, PAGE_WIDTH - RIGHT_MARGIN, y)


def _draw_footer(c: canvas.Canvas):
    c.setFillColor(PRIMARY_BLUE)
    c.rect(0, 0, PAGE_WIDTH, FOOTER_HEIGHT, stroke=0, fill=1)

    c.setFillColor(MUTED_BLUE)
    c.setFont("Helvetica", 6.5)
    c.drawString(LEFT_MARGIN, 7, f"Recast Software | {DOC_TITLE}")
    date_w = c.stringWidth(MEETING_DATE, "Helvetica", 6.5)
    c.drawString(PAGE_WIDTH - RIGHT_MARGIN - date_w, 7, MEETING_DATE)


# =============================================================================
# FLOWABLE HELPERS
# =============================================================================

def section_header_bar(text: str) -> Table:
    """Full-width light gray bar with blue bold text — used as section divider."""
    cell = Paragraph(
        f'<font color="#0000CC"><b>{text}</b></font>',
        ParagraphStyle("SH", fontName="Helvetica-Bold", fontSize=9,
                       leading=11, textColor=PRIMARY_BLUE, leftIndent=0),
    )
    t = Table([[cell]], colWidths=[CONTENT_WIDTH], rowHeights=[16])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT_GRAY),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def semantic_bullet(kind: str, text: str) -> Paragraph:
    """kind ∈ {'info','green','amber','action'} — renders a colored bullet + text."""
    # Convert **bold** markdown to <b>…</b> for ReportLab
    text = _md_bold_to_html(text)
    if kind == "green":
        marker = f'<font color="#0F7A3F">{BULLET_GREEN}</font>'
    elif kind == "amber":
        marker = f'<font color="#CC8800">{BULLET_AMBER}</font>'
    elif kind == "action":
        marker = f'<font color="#00BFFF">{BULLET_ACTION}</font>'
    else:  # info
        marker = f'<font color="#00BFFF">{BULLET_INFO}</font>'
    html = f'{marker}&nbsp;&nbsp;<font color="#4A4A5A">{text}</font>'
    return Paragraph(html, STYLE_BULLET)


def _md_bold_to_html(text: str) -> str:
    """Convert **bold** segments to <b>bold</b> for ReportLab Paragraph parsing.
    Tags are nested font>b>...</b></font> so the outer font in semantic_bullet
    doesn't collide with the inner bold coloring."""
    out, i, in_bold = [], 0, False
    while i < len(text):
        if text[i:i+2] == "**":
            if in_bold:
                out.append("</b></font>")
            else:
                out.append('<font color="#1A1A2E"><b>')
            in_bold = not in_bold
            i += 2
        else:
            out.append(text[i])
            i += 1
    if in_bold:
        out.append("</b></font>")
    return "".join(out)


def build_map_table() -> Table:
    """Build the Mutual Action Plan table."""
    # Header row
    header = [
        Paragraph('<b><font color="#1A1A2E">&nbsp;</font></b>',
                  ParagraphStyle("mh", fontSize=7.5)),
        Paragraph('<b><font color="#1A1A2E">Milestone</font></b>',
                  ParagraphStyle("mh", fontSize=7.5, fontName="Helvetica-Bold")),
        Paragraph('<b><font color="#1A1A2E">Owner</font></b>',
                  ParagraphStyle("mh", fontSize=7.5, fontName="Helvetica-Bold")),
        Paragraph('<b><font color="#1A1A2E">Target Date</font></b>',
                  ParagraphStyle("mh", fontSize=7.5, fontName="Helvetica-Bold")),
        Paragraph('<b><font color="#1A1A2E">Status</font></b>',
                  ParagraphStyle("mh", fontSize=7.5, fontName="Helvetica-Bold")),
    ]

    data = [header]
    row_styles = []  # (row_index, bg_color) pairs

    for idx, (milestone, owner, date, status) in enumerate(MAP_ROWS):
        row_idx = idx + 1  # +1 for header

        # Checkbox column
        if status == "Complete":
            check = Paragraph(f'<font color="#0F7A3F">{CHECK_COMPLETE}</font>',
                              ParagraphStyle("cb", fontSize=10, alignment=TA_CENTER))
            m_style = STYLE_MAP_CELL_COMPLETE
            row_bg = GREEN_BG
        else:
            check = Paragraph(f'<font color="#AAAAAA">{CHECK_OPEN}</font>',
                              ParagraphStyle("cb", fontSize=10, alignment=TA_CENTER))
            m_style = STYLE_MAP_CELL
            row_bg = ROW_TINT if idx % 2 == 1 else WHITE

        # Status pill color
        status_color = {
            "Complete":    "#0F7A3F",
            "In Progress": "#CC8800",
            "Next":        "#CC8800",
            "Scheduled":   "#CC8800",
            "Pending":     "#1A1A2E",
        }.get(status, "#1A1A2E")
        status_weight = "b" if status in ("Complete", "In Progress", "Next") else ""
        status_html = f'<{status_weight}><font color="{status_color}">{status}</font></{status_weight}>' \
                      if status_weight else f'<font color="{status_color}">{status}</font>'

        data.append([
            check,
            Paragraph(milestone, m_style),
            Paragraph(owner, m_style),
            Paragraph(date, m_style),
            Paragraph(status_html, STYLE_MAP_CELL),
        ])
        row_styles.append((row_idx, row_bg))

    # Column widths: checkbox 0.22" | milestone 40% | owner 14% | date 18% | status 12%
    col_widths = [0.22 * inch,
                  CONTENT_WIDTH * 0.46,
                  CONTENT_WIDTH * 0.15,
                  CONTENT_WIDTH * 0.18,
                  CONTENT_WIDTH * 0.18]

    t = Table(data, colWidths=col_widths, repeatRows=1)

    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), LIGHT_GRAY),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, BOX_BORDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, BOX_BORDER),
    ]
    for row_idx, bg in row_styles:
        style_cmds.append(("BACKGROUND", (0, row_idx), (-1, row_idx), bg))
    t.setStyle(TableStyle(style_cmds))
    return t


# =============================================================================
# PAGE 2 INFOGRAPHIC — box helpers
# =============================================================================

def make_infra_box(title: str, line2: str, line3: str, tone: str = "normal") -> Table:
    """A box for the current-state architecture grid. tone ∈ {'normal','amber'}."""
    bg = AMBER_BG if tone == "amber" else LIGHT_GRAY
    border_col = WARN_AMBER if tone == "amber" else BOX_BORDER
    lines = [Paragraph(title, STYLE_BOX_TITLE)]
    if line2:
        lines.append(Paragraph(line2, STYLE_BOX_LINE))
    if line3:
        lines.append(Paragraph(line3, STYLE_BOX_LINE))
    inner = Table([[l] for l in lines], colWidths=["*"])
    inner.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    t = Table([[inner]], colWidths=["*"], rowHeights=[50])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.5, border_col),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def make_label_bar(text: str, bg_color: colors.Color, text_color: colors.Color = WHITE,
                   bold: bool = True) -> Table:
    style = ParagraphStyle("lb", fontName="Helvetica-Bold" if bold else "Helvetica",
                           fontSize=8.5, textColor=text_color, alignment=TA_CENTER, leading=10)
    t = Table([[Paragraph(text, style)]], colWidths=[CONTENT_WIDTH], rowHeights=[18])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg_color),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def make_row_of_boxes(boxes: list) -> Table:
    """Given a list of (title, l2, l3, tone) tuples, return a horizontal row."""
    cells = [make_infra_box(*b) for b in boxes]
    n = len(cells)
    col_w = CONTENT_WIDTH / n
    t = Table([cells], colWidths=[col_w] * n)
    t.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def make_friction_bar(points: list) -> Table:
    joined = " • ".join(points)
    text = f'<font color="#CC8800"><b>\u26A0 Key Friction:</b></font> <font color="#4A4A5A">{joined}</font>'
    para = Paragraph(text, ParagraphStyle("fb", fontSize=7.5, leading=10, alignment=TA_LEFT))
    t = Table([[para]], colWidths=[CONTENT_WIDTH])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), AMBER_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, WARN_AMBER),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def make_outcome_bar(points: list) -> Table:
    joined = " • ".join(points)
    text = f'<font color="#0F7A3F"><b>\u2714 What Changes:</b></font> <font color="#4A4A5A">{joined}</font>'
    para = Paragraph(text, ParagraphStyle("ob", fontSize=7.5, leading=10, alignment=TA_LEFT))
    t = Table([[para]], colWidths=[CONTENT_WIDTH])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, GREEN),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def make_arrow_transition() -> Table:
    text = f'<font color="#00BFFF">{ARROW_DOWN}  {ARROW_DOWN}  {ARROW_DOWN}</font>'
    para = Paragraph(text, ParagraphStyle("arr", fontSize=14, leading=16, alignment=TA_CENTER))
    t = Table([[para]], colWidths=[CONTENT_WIDTH], rowHeights=[20])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    return t


def make_aw_flow_row() -> Table:
    """Applications → Application Workspace (blue box) → Delivery Targets."""
    # Left: Applications box (light gray)
    apps_lines = [Paragraph(f'<b>{APPLICATIONS_BOX["title"]}</b>', STYLE_BOX_TITLE)]
    for l in APPLICATIONS_BOX["lines"]:
        apps_lines.append(Paragraph(l, STYLE_BOX_LINE))
    apps_box = Table([[x] for x in apps_lines], colWidths=["*"])
    apps_outer = Table([[apps_box]], colWidths=["*"], rowHeights=[90])
    apps_outer.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT_GRAY),
        ("BOX", (0, 0), (-1, -1), 0.5, BOX_BORDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))

    # Center arrow
    arrow_l = Paragraph(f'<font color="#00BFFF"><b>&#9654;</b></font>',
                        ParagraphStyle("arl", fontSize=16, alignment=TA_CENTER))

    # Middle: Application Workspace blue box
    aw_title = Paragraph(
        '<font color="#FFFFFF"><b>APPLICATION WORKSPACE</b></font>',
        ParagraphStyle("awt", fontName="Helvetica-Bold", fontSize=10,
                       alignment=TA_CENTER, leading=12, textColor=WHITE),
    )
    aw_tag = Paragraph(
        '<font color="#AABBEE"><i>Package once. Deliver everywhere.</i></font>',
        ParagraphStyle("awtg", fontSize=7.5, alignment=TA_CENTER, leading=10),
    )
    aw_lines = [[aw_title], [aw_tag]]
    for cap in AW_CAPABILITIES:
        aw_lines.append([Paragraph(f'<font color="#FFFFFF">{cap}</font>',
                                   ParagraphStyle("awl", fontSize=7, alignment=TA_CENTER, leading=9))])

    aw_inner = Table(aw_lines, colWidths=["*"])
    aw_inner.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    aw_outer = Table([[aw_inner]], colWidths=["*"], rowHeights=[120])
    aw_outer.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PRIMARY_BLUE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))

    arrow_r = Paragraph(f'<font color="#00BFFF"><b>&#9654;</b></font>',
                        ParagraphStyle("arr2", fontSize=16, alignment=TA_CENTER))

    # Right: Delivery targets (stacked boxes)
    target_rows = []
    for (t1, t2, t3) in DELIVERY_TARGETS:
        lines = [Paragraph(f'<b>{t1}</b>', STYLE_BOX_TITLE)]
        lines.append(Paragraph(t2, STYLE_BOX_LINE))
        if t3:
            lines.append(Paragraph(t3, STYLE_BOX_LINE))
        inner = Table([[l] for l in lines], colWidths=["*"])
        outer = Table([[inner]], colWidths=["*"], rowHeights=[36])
        outer.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), LIGHT_GRAY),
            ("BOX", (0, 0), (-1, -1), 0.5, BOX_BORDER),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ]))
        target_rows.append([outer])

    targets_stack = Table(target_rows, colWidths=["*"])
    targets_stack.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))

    # Full row: apps | arrow | AW | arrow | targets
    #   widths: 22%   6%     42%   6%     24%
    flow = Table(
        [[apps_outer, arrow_l, aw_outer, arrow_r, targets_stack]],
        colWidths=[
            CONTENT_WIDTH * 0.20,
            CONTENT_WIDTH * 0.06,
            CONTENT_WIDTH * 0.42,
            CONTENT_WIDTH * 0.06,
            CONTENT_WIDTH * 0.26,
        ],
    )
    flow.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 1),
        ("RIGHTPADDING", (0, 0), (-1, -1), 1),
    ]))
    return flow


def make_persona_row() -> Table:
    boxes = []
    for (t1, t2, t3) in USER_PERSONAS:
        lines = [Paragraph(f'<b>{t1}</b>', STYLE_BOX_TITLE)]
        lines.append(Paragraph(t2, STYLE_BOX_LINE))
        if t3:
            lines.append(Paragraph(t3, STYLE_BOX_LINE))
        inner = Table([[l] for l in lines], colWidths=["*"])
        outer = Table([[inner]], colWidths=["*"], rowHeights=[42])
        outer.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), LIGHT_GRAY),
            ("BOX", (0, 0), (-1, -1), 0.5, BOX_BORDER),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        boxes.append(outer)
    n = len(boxes)
    row = Table([boxes], colWidths=[CONTENT_WIDTH / n] * n)
    row.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return row


def make_end_users_bar() -> Table:
    """Green bar that says 'End Users — Same experience regardless of backend changes'."""
    text = '<font color="#0F7A3F"><b>\u2714 End Users</b></font> <font color="#4A4A5A">— Same experience regardless of backend changes</font>'
    para = Paragraph(text, ParagraphStyle("eu", fontSize=8, leading=10, alignment=TA_LEFT))
    t = Table([[para]], colWidths=[CONTENT_WIDTH], rowHeights=[16])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), GREEN_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, GREEN),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


# =============================================================================
# BUILD THE DOCUMENT
# =============================================================================

def build_pdf(output_path: str):
    doc = SimpleDocTemplate(
        output_path,
        pagesize=letter,
        leftMargin=LEFT_MARGIN,
        rightMargin=RIGHT_MARGIN,
        topMargin=TOP_MARGIN,
        bottomMargin=BOTTOM_MARGIN,
        title=DOC_TITLE,
        author="Recast Software",
    )

    story = []

    # --- Section 1: Meeting Recap ---
    story.append(section_header_bar(RECAP_SECTION_TITLE))
    story.append(Spacer(1, 3))
    story.append(Paragraph(RECAP_PARAGRAPH, STYLE_RECAP))
    story.append(Spacer(1, 1))
    for fact in CONFIRMED_FACTS:
        story.append(semantic_bullet("green", fact))
    story.append(Spacer(1, 5))

    # --- Section 2: Your Current Environment ---
    story.append(section_header_bar("YOUR CURRENT ENVIRONMENT"))
    story.append(Spacer(1, 2))
    for sub in ENVIRONMENT_SECTIONS:
        story.append(Paragraph(sub["title"], STYLE_SECTION_SUB))
        for (kind, text) in sub["bullets"]:
            story.append(semantic_bullet(kind, text))
    story.append(Spacer(1, 5))

    # --- Section 3: Mutual Action Plan ---
    story.append(section_header_bar("MUTUAL ACTION PLAN"))
    story.append(Spacer(1, 2))
    story.append(Paragraph(MAP_INTRO, STYLE_INFO_INTRO))
    story.append(Spacer(1, 1))
    story.append(build_map_table())

    # --- Page 2: Architecture Infographic ---
    story.append(PageBreak())
    story.append(section_header_bar(ARCH_INTRO_TITLE))
    story.append(Spacer(1, 4))
    story.append(Paragraph(ARCH_INTRO_TEXT, STYLE_INFO_INTRO))
    story.append(Spacer(1, 4))

    # Current state label + grid
    story.append(make_label_bar(CURRENT_STATE_LABEL, PRIMARY_BLUE, WHITE))
    story.append(Spacer(1, 6))
    story.append(make_row_of_boxes(CURRENT_ROW_1))
    story.append(Spacer(1, 4))
    story.append(make_row_of_boxes(CURRENT_ROW_2))
    story.append(Spacer(1, 6))
    story.append(make_friction_bar(FRICTION_POINTS))
    story.append(Spacer(1, 6))

    # Transition arrow
    story.append(make_arrow_transition())
    story.append(Spacer(1, 2))

    # Proposed state label + flow
    story.append(make_label_bar(PROPOSED_STATE_LABEL, PRIMARY_BLUE, WHITE))
    story.append(Spacer(1, 6))
    story.append(make_aw_flow_row())
    story.append(Spacer(1, 8))
    story.append(make_end_users_bar())
    story.append(Spacer(1, 4))
    story.append(make_persona_row())
    story.append(Spacer(1, 6))
    story.append(make_outcome_bar(OUTCOMES))

    doc.build(story, onFirstPage=_draw_header_and_footer,
              onLaterPages=_draw_header_and_footer)


if __name__ == "__main__":
    build_pdf(OUTPUT_FILENAME)
    print(f"Wrote {OUTPUT_FILENAME}")
