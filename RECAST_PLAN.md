# Recast design system — system-wide rollout plan

Apply the Recast brand language across the Partner Portal. The deal pop-out
(shipped in PR #99 with scoped tokens inside `.modal--details`) is the visual
reference; this rollout promotes those tokens to global, restyles the layout
shell, and sweeps every screen.

User decisions captured up-front (asked before plan finalization):
- **Page header**: reuse existing `#topbar` element. Extend `setTopbarTitle`
  to `setTopbar({title, meta, chips, actions})`; remove per-view
  `.section-header` blocks.
- **KPI strip**: keep interactive (click-to-filter), restyle as a single
  metric strip with shared 1px dividers.
- **Deal pop-out**: update the in-modal hero — drop the tall blue panel,
  use the brief's 52px condensed metadata strip.
- **Font**: switch global `--font-sans` to Inter (already loaded).

Reference screenshot (Opportunities page) refinements added after the plan
was drafted:
- Sidebar shows a single `+` decorator above the "ADMIN" label (one of the
  two per-screen decorators allowed by the brief on Primary Blue surfaces).
- **STAGE column stays plain text** — Prospect / Closed / Proposal /
  Qualified. The "always a chip" rule applies to **STATUS only** (Won →
  green dot, Registered → blue dot, In Progress → cyan dot, Lost → red).
- **PARTNER cell** is a light-blue chip (`#E6E8FF` bg / `#0000CC` text /
  rounded). Existing code already uses `badge--admin` — just restyle.
- **Topbar zones**: type-filter chips in the topbar center; BOARD / LIST
  view toggle stays in the filter row right edge (not in topbar).
- **Metric strip delta line** ("▲ +2 this week", "▼ 2 closing this week")
  pushes effective height to ~96px when present. Relaxing the brief's 64px
  cap to "≤ 64px without delta line, ≤ ~100px with delta line" since the
  delta is data-bearing. Triangle glyph color = green up / red down.
- **EDIT / DELETE** are pure text links (no button chrome) — uppercase,
  tracked, 12/700, `#0000CC` and `#CC2222`.

---

## 1. Why this is structured the way it is

- **No build step.** Site is plain CSS + ES modules served from GitHub Pages.
  All theming routes through CSS variables in `css/variables.css`. There is
  no Tailwind config or Storybook to update.
- **Class names already match.** The HTML uses the right hooks
  (`.btn--primary`, `.stat-card`, `.table`, `.filter-bar`, `.section-header`,
  `.kanban__card`, etc.) — JS won't need to change just to update visuals.
  Heavy work is in CSS; targeted JS edits are limited to (a) the
  topbar API extension, (b) demoting the `.stats-grid` block to the new
  metric strip class, and (c) swapping a few inline color literals.
- **Existing scoped Recast block.** Lines 5054–5951 of `components.css`
  already define `.modal--details`-scoped tokens and styling matching the
  brief. Promoting these tokens to `:root` makes the scoped declarations
  redundant but harmless. We won't delete that block in this pass — that's
  a separate cleanup PR.

---

## 2. Phase order

The brief's section 10 implementation order applies. Within each phase the
file list is concrete. **Each phase ends with a quick visual smoke-test by
opening `index.html` locally; nothing is fully done until the audit pass at
the end.**

### Phase A — Tokens (`css/variables.css`)

Replace the current Recast-cobalt set with the brief's exact values, and add
the new tokens needed for tables, filter chips, page headers.

```css
:root {
  /* Recast brand */
  --color-primary:           #0000CC;   /* (was #1E30CC) */
  --color-primary-deep:      #0000A8;
  --color-accent-cyan:       #00BFFF;   /* (was #00CFFF) */
  --color-accent-cyan-hover: #33CCFF;
  --color-decorator-blue:    #2222DD;

  /* Text */
  --color-text-primary:   #1A1A2E;       /* (was #0D1229) */
  --color-text-secondary: #4A4A5A;
  --color-text-muted:     #AABBEE;       /* used in eyebrow secondaries, sidebar role */

  /* Surfaces */
  --color-surface:        #FFFFFF;
  --color-bg:             #F0F0F6;       /* section band tint (was #EDF0F7) */
  --color-row-tint:       #FAFAFE;       /* table row hover */
  --color-quote-bg:       #F6F8FF;       /* condensed strip bg, modal footer */

  /* Borders */
  --color-divider:        #DDDDEE;
  --color-border:         #DDDDEE;
  --color-border-light:   #F0F0F6;

  /* Sidebar (flat #0000CC; no more deep navy) */
  --color-sidebar-bg:           #0000CC;
  --color-sidebar-text:         #FFFFFF;
  --color-sidebar-text-muted:   #AABBEE;
  --color-sidebar-hover:        rgba(255,255,255,0.08);
  --color-sidebar-active-bg:    #00BFFF;
  --color-sidebar-active-text:  #0000CC;

  /* Status (semantic) */
  --color-success:        #0F7A3F;
  --color-success-bg:     #E8F5EE;
  --color-info-bg:        #E6F8FF;
  --color-info-text:      #0066A3;
  --color-warning:        #CC8800;
  --color-warning-bg:     #FFF5E0;
  --color-danger:         #CC2222;
  --color-danger-bg:      #FBE9E9;

  /* Typography — Inter only */
  --font-sans:  'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono:  'SF Mono', 'Fira Code', Consolas, monospace;

  /* Sizes (unchanged numerically; intent unchanged) */
  --text-xs: 0.6875rem;  /* 11px */
  --text-sm: 0.8125rem;  /* 13px */
  --text-base: 0.875rem; /* 14px */
  --text-lg: 1.125rem;   /* 18px */
  /* …keep the rest as-is */

  /* Layout */
  --sidebar-width: 220px;        /* (was 260px) */
  --header-height: 56px;
  --metric-strip-height: 64px;
  --modal-title-bar-height: 48px;

  /* Radii */
  --radius-sharp:   0;            /* default for surfaces */
  --radius-button:  6px;          /* buttons only */
  --radius-card:    8px;          /* info cards only */
  --radius-pill:    999px;        /* status chips only */
}
```

Drop / repurpose:
- `--color-primary-light`, `--color-primary-lighter` — replaced by `--color-primary-deep` and `--color-accent-cyan`. Keep aliases pointing to new vars so legacy references in JS (e.g., dashboard `TYPE_COLORS`) keep working.
- The Recast-cobalt `--color-status-registered` etc. — re-aim at the new chip palette.

### Phase B — Layout shell (`css/layout.css`, `js/components/sidebar.js`)

**Sidebar** (`.sidebar`, `.sidebar__*`):
- Background flips to flat `var(--color-sidebar-bg)` = `#0000CC`. Width drops to 220px.
- Logo: drop the gradient `.sidebar__logo-icon` square. Wordmark is text-only — `Partner` in `#FFFFFF`, `Portal` in `#00BFFF`, 18px / 700 / `letter-spacing: -0.02em`. Keep the existing structure in `sidebar.js`; just adjust styles inline.
- `.sidebar__section-label`: 10px / `letter-spacing: 0.18em` / `color: #AABBEE`.
- `.sidebar__link`: 13px / 500 / white, padding `10px 16px`, **`border-radius: 0`** (was 7px). Hover = `rgba(255,255,255,0.08)`.
- `.sidebar__link--active`: solid cyan block (`background: #00BFFF; color: #0000CC; font-weight: 700`) — sharp corners. Drop the inset cyan stripe.
- `.sidebar__avatar`: 32px square, sharp corners, flat `#00BFFF` background, no gradient/shadow.
- User chip: name 13/600 white, role 11/500 `#AABBEE`. Logout 28×28 sharp.

**Topbar / Page header** (the existing `<header id="topbar">`, restyled and extended):
- White background, `border-bottom: 1px solid #DDDDEE`, NO shadow, NO gradient. Height stays 56px.
- New layout (3 zones): `.topbar__title-zone` (eyebrow title + meta middot count) on the left; `.topbar__chips` (filter chips, view toggle) center; `.topbar__actions` (primary CTA + overflow) right.
- Eyebrow style: `font-size: 13px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #0000CC`.
- Inline meta: `13px / 500 / #4A4A5A`, separated from title by `·`.

**Sidebar.js — `setTopbar(...)`**:
Replace `setTopbarTitle(title)` with the richer `setTopbar({title, meta, chips, actions})`. Keep `setTopbarTitle` as a thin wrapper (`setTopbar({title})`) so unaudited views keep working — this lets us roll out per-view in the next phase without a whole-site break.

```js
export function setTopbar({ title, meta, chips, actions } = {}) {
  const titleEl = $('#topbar-title');
  // …render eyebrow + meta middot
  const actionsEl = $('#topbar-actions');
  // …append chips region + actions region
}
export function setTopbarTitle(title) { setTopbar({ title }); }
```

### Phase C — Primitives (`css/components.css`)

Rewrite the existing classes in place (preserves JS hooks). Hard rule: only
buttons get 6px radius, only info cards get 8px, only status pills get
`999px`. Everything else is sharp (`border-radius: 0`).

**Buttons** (`.btn`, `.btn--primary`, etc.):
- Base: height 36px, padding 10px 18px, `border-radius: 6px`, `font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;`. No shadow, no gradient.
- Variants per the brief table:
  - `.btn--primary`        → cyan `#00BFFF` bg / white text / hover `#33CCFF`
  - `.btn--secondary`      → white bg / `#0000CC` text / 1.5px `#0000CC` border
  - `.btn--tertiary` (new) → transparent bg / `#0000CC` text / underline on hover
  - `.btn--filled-blue` (new) → `#0000CC` bg / white text / 800 weight (admin actions like "Generate MAP")
  - `.btn--danger` / `.btn--destructive` → transparent / `#CC2222` text / underline on hover
  - `.btn--ghost` → keep semantically (used inline on tables) — re-aim as the "text link" variant: 12px / 700 / uppercase / tracked / `#0000CC` for default, set `color: #CC2222` for destructive.
- `.btn--sm` → height 28px, padding 0 12px, font 11px.
- Action buttons in tables (`Edit` / `Delete`) should use `.btn--ghost` and read as text links — no background. Existing JS already passes `class="btn btn--ghost btn--sm"` so just restyle.

**Stat cards / Metric strip** (`.stats-grid`, `.stat-card`):
- New display contract: `.stats-grid` becomes a single 64px-tall flex row, white background, 1px outer border `#DDDDEE`, no shadow, no rounded corners.
- `.stat-card` becomes a flex cell: `flex: 1; padding: 14px 18px; border-right: 1px solid #DDDDEE` (last cell drops the right border).
- `.stat-card__label`: 10px / 800 / uppercase / tracked 0.14em / `#0000CC`.
- `.stat-card__value`: 24px / 700 / `#1A1A2E` / `font-variant-numeric: tabular-nums; letter-spacing: -0.02em`.
- `.stat-card__change`: 11px / 600 / `#0F7A3F` (up) or `#CC2222` (down) — already exists, just re-color.
- `.stat-card--clickable:hover`: `background: #FAFAFE` (no transform, no shadow).
- `.stat-card--active`: cyan top accent (2px `::before`), `background: #F6F8FF`, value text in `#0000CC`.
- Drop `.stat-card__icon-wrap` in the strip context (the brief omits icons). Existing JS passes `icon: '<svg>...'` to `statCard()` — leave the slot rendered but `display: none` it under `.stats-grid` (no JS change). The dashboard variant in `dashboard.css` will be re-scoped.

**Tables** (`.table`, `.table-wrapper`):
- `.table-wrapper`: white bg, 1px `#DDDDEE` border, `border-radius: 0`, no shadow.
- `.table th`: bg `#F0F0F6`, color `#0000CC`, 10px / 800 / uppercase / tracked 0.14em, padding 10px 16px.
- `.table td`: padding 14px 16px, `font-size: 13px; color: #1A1A2E`. Bottom border `1px solid #F0F0F6`.
- `.table tr:hover td`: bg `#FAFAFE`.
- `.deal-name-link` (already in CSS): 13px / 600 / `#0000CC`, no underline.
- New: `.table .row-subtitle` for the second-line org/customer text (11px / `#4A4A5A`).
- Money cells: add `.table__money` modifier — `font-variant-numeric: tabular-nums; font-weight: 600; text-align: right`. Apply where opportunities/partners views render currency.
- Actions column → fixed-width via `.table th:last-child, .table td:last-child { width: 1%; white-space: nowrap; text-align: right }`.

**Filter chips / View toggle** (`.type-filter-bar`, `.view-toggle`):
- `.type-filter-bar` rule (overrides current pill style in `dashboard.css`): height 28px, padding 0 12px, `border-radius: 0`, font 12px / 600. Inactive: white bg, 1px `#DDDDEE` border, `#4A4A5A` text. Active: `#0000CC` bg / white text / `#0000CC` border (no black). Trailing pipeline count: 6px gap, muted (`#AABBEE` on active, `#4A4A5A` on inactive), tabular-nums.
- `.view-toggle` (Board / List): 2-segment switch. Active = `#0000CC` bg / white. Inactive = white / `#4A4A5A`. Sharp corners, 1px shared `#DDDDEE` divider between segments.

**Forms** (`.form-input`, `.form-select`, `.form-textarea`, `.form-label`):
- `.form-label`: 11px / 700 / uppercase / tracked 0.12em / `#0000CC`. 6px gap above field.
- `.form-input`, `.form-select`: height 36px, padding 0 12px, font 14px, `border: 1px solid #DDDDEE; border-radius: 0`. Focus: `border-color: #00BFFF; outline: 2px solid rgba(0,191,255,0.25); outline-offset: 0`.
- Disabled state: bg `#F0F0F6` / text `#AABBEE`.
- Error: `border-color: #CC2222; outline-color: rgba(204,34,34,0.2)`. Helper `.form-error` already exists; recolor to 12px / `#CC2222`.
- Selects: same chrome + 12px `#0000CC` chevron (replace the gray data URI).
- `.form-textarea`: same chrome, `min-height: 96px`, vertical resize only.
- Filter-bar variants (`.filter-bar__search`, `.filter-bar__select`): height drops to 32px, padding 0 12px, sharp corners. Drop the search-magnifier icon in the Opportunities view (per brief: "no leading magnifier icon — it's noise"). The icon is rendered inline in `admin-opportunities.js` line 483 — remove it.

**Modals** (`.modal`, `.modal__header`, etc.):
- `.modal`: max-width unchanged per modal type, but `border-radius: 0` (was 8px), no scale-down open animation (only translateY + fade). 1px `#DDDDEE` border, soft shadow.
- `.modal__header`: 48px tall (was 64-72px), 4×24 cyan rule on the left, eyebrow + 18px/700 title (was 20px). Action buttons pinned right (Edit All, expand, close — existing pattern from `.modal--details`).
- `.modal__body`: white, no gradient (kill the `linear-gradient(180deg, #fafbfd 0%, #ffffff 140px)` at line 1503).
- `.modal__footer`: bg `#F6F8FF`, 1px top border, padding 14px 28px.
- `.modal__close`: 36×36 sharp, white bg, 1.5px divider border. Hover → blue.
- The brief's "Drop the tall blue hero panel" applies to `.modal--details`. Change in JS (admin-opportunities.js `buildOppDetailsHero`): swap the current 4-meta hero for the condensed strip:

```
[Closed] [● Won] | CUSTOMER Flexera | PARTNER Flexera | CLOSE Mar 1, 2026 | DEAL VALUE $50,000
```

  - Container `.details-hero`: bg `#F6F8FF`, 3px `#00BFFF` left border, ~52px tall, NOT flat `#0000CC`.
  - Drop the four `+` decorators inside the hero — keep them only on the login screen.
  - Amount: 22px / 800 / `#1A1A2E`, right-aligned, NOT 44px white.
  - The scoped CSS section in `components.css` (lines 5217–5352) is rewritten to reflect the new strip styling.

**Empty state** (`.empty-state`):
- Centered, max-width 360px.
- Icon 32px Lucide stroke, `color: #AABBEE`.
- Title 14px / 700 / `#1A1A2E`. Body 13px / 500 / `#4A4A5A`, line-height 1.5.
- Primary CTA = `.btn--primary` (cyan).

**Status chips / badges** (`.badge`):
- Always pill (`border-radius: 999px`), 11px / 700 / uppercase / tracked 0.08em, padding 4px 10px.
- Add a leading semantic dot via `.badge__dot` span (8px circle, `currentColor`, `box-shadow: 0 0 0 3px color-mix(...)`).
- Colors: Won → green chip (`bg #E8F5EE / color #0F7A3F`); In Progress / Qualified / Negotiation → cyan chip (`#E6F8FF / #0066A3`); Registered / Prospect → muted-blue or amber (`#FFF5E0 / #CC8800`); Lost / Risk → red (`#FBE9E9 / #CC2222`).
- "Stop using bare colored text for status" — sweep `js/views/admin-opportunities.js` and any others rendering plain text status; route through `<span class="badge ...">` with a leading `.badge__dot`.

### Phase D — Per-screen sweep

Touch each view in the order from the brief. Each entry lists the file and
the concrete change.

**1. Dashboard — `js/views/admin-dashboard.js` + `css/dashboard.css`**
- Replace the 4-card `.dashboard-top__stats` (currently with rounded 14px cards, accent gradient on active) with the global metric strip. The custom rules in `dashboard.css` (lines 50–157) are deleted; the global `.stats-grid + .stat-card` styles take over.
- Kill the gradient on `.timeline-card__date-col` (line 578) — use flat `#0000CC`.
- Kill `.timeline-card__checklist-fill` gradient (line 660) — use flat `#0000CC`.
- Kill the "active" gradient on `.dashboard-top__stats .stat-card--active` (line 144).
- Restyle the section headers: replace the 4px primary blue rule + 17px title with eyebrow style (the global `.section-header` rewrite).
- Move title + count to the topbar: call `setTopbar({ title: 'Dashboard', meta: \`${tfPartners.length} partners · ${formatCurrency(tfTotalPipeline)} pipeline\`, chips: typeFilterBar })`. Drop the in-view section-header for the page-level title (keep the per-section `.section-header` blocks for "Partner Activity" / "Upcoming Events" subsections — those become eyebrow rule headers, not topbar bars).

**2. Opportunities — `js/views/admin-opportunities.js`**
- `renderView`: drop the `el('div', { class: 'section-header' }, ...)` block (lines 445–457). Push title + count to `setTopbar({ title: 'Opportunities', meta: \`${opportunities.length} deals · ${formatCurrency(totalValue)} pipeline\`, chips: filterBar (type chips) + view toggle, actions: 'New Opportunity' button })`.
- Stats grid (`.stats-grid stagger`, lines 460–477): keep the 4 statCard calls; the global metric strip restyle handles the visuals.
- Filter row (lines 480–492): drop the leading magnifier icon span (line 483). Change `searchInput` placeholder to `Search opportunities…` (already there).
- Stage column in the list table (line 690) currently uses `<span class="badge badge--silver">` — switch to a chip with semantic dot. (Add a stage-color map: Closed → green, Negotiation/Qualified → cyan, Prospect/Proposal → amber, Lost → red.)
- Status column — already uses `.badge--{status}`; just verify the new semantic colors land.
- Opportunity Details modal hero — see Phase C "Modals" rewrite of `.details-hero` from tall blue → condensed strip.
- Kanban column header: `.kanban__column-title` should use eyebrow style (10px uppercase tracked `#0000CC`).

**3. Accounts (Lead Check) — `js/views/partner-leadcheck.js`**
- 27-line stub; `setTopbar({title:'Accounts'})`, no other change required beyond what global primitives give.

**4. Partners — `js/views/admin-partners.js`**
- Drop `.section-header` block; push to `setTopbar({title:'Partners', meta, chips: typeFilter, actions: 'New Partner'})`.
- Sweep stat-card grid same as above.
- Restyle `.partner-mgmt-card` (rounded `--radius-lg` = 12px): switch to `--radius-card` = 8px (info card) or sharp 0 if the design density calls for it. Default to 0 (table-row-style list) but keep grid layout.
- `.partner-thumb` and `.partner-avatar` — drop the gradient flair on the avatar; flat color tied to tier.

**5. Partner Detail — `js/views/admin-partner-detail.js`**
- The current `.detail-header` is a "hero" pattern (avatar + name + tier badge + 4 stat columns). Match the brief's condensed strip: 52px tall, `#F6F8FF` bg, 3px cyan left border, eyebrow labels, sharp.
- `setTopbar({title: 'Partner', meta: partner.display_name})` so the deep-link page name is in the sticky bar.
- Sub-sections (Opportunities table, Events, Transcripts) get the global table/empty-state styling.

**6. Events / JLG — `js/views/admin-events.js`**
- Same shape as Opportunities. `setTopbar({title:'Events / JLG', meta, chips, actions})`. Stat strip, filter row, table or board view restyled by the global rewrite.
- The Event modal currently uses `modal--xwide` with a sourced-opps summary panel — the panel internals (`.event-opps-section`) get the new semantic chip palette and the section-band header.

**7. Pricing — external link**
- No code change. Sidebar item already opens an external popup window.

**8. Setup — `js/views/admin-setup.js`**
- `.setup-header` and `.setup-card` are already simple white cards. Just verify the global form input/button restyles flow through. Title goes to topbar.

**9. Login — `js/views/login.js` + `css/layout.css`**
- The current `.app-shell--login` uses a navy-cobalt diagonal gradient. Per brief, the `+` decorator flourish is allowed here. Switch to flat `#0000CC` background, scatter 4–6 `+` decorators in the deeper `#2222DD`, drop the gradient.
- The login card itself: sharp corners (`border-radius: 0`), white surface, max-width 420px, inputs use the new form chrome.
- Wordmark inside the card matches the sidebar style (`Partner` white-on-blue, no — here it would be `Partner` in `#1A1A2E` and `Portal` in `#0000CC` since the card is white).

**10. Partner Dashboard / Demand Gen / Resources — `js/views/partner-*`**
- Same as admin counterparts. Push title to topbar, restyle stat strip, table, empty states.

### Phase E — Audit pass (run last)

Run these scans and fix what surfaces:

```bash
# Find remaining gradients in app surfaces (login is the only allowed exception → grep -v)
grep -rnE "background.*linear-gradient" css/ | grep -v 'app-shell--login'

# Find non-standard border radii
grep -rnE "border-radius:\s*(2px|3px|4px|7px|10px|12px|14px|18px|20px|24px)" css/

# Find inline color hexes in JS that should be tokens
grep -rnE "#[0-9A-Fa-f]{3,6}" js/views/ js/components/ | grep -v 'svg\|fill='

# Find capitalize / wrong text-transform
grep -rnE "text-transform:\s*capitalize" css/

# Find any non-Inter font-family
grep -rnE "font-family.*Plus Jakarta|font-family.*sans-serif" css/ | grep -v -- '--font-sans:'
```

Hard-rule checklist (paste into PR description, verify each):
- [ ] No `linear-gradient` in app surfaces (login screen exempt).
- [ ] No black buttons / black active-state pills.
- [ ] All container surfaces have `border-radius: 0`. Buttons 6px, info cards 8px, pill-status-chips 999px.
- [ ] All page titles are uppercase tracked eyebrows in `#0000CC` — not big H1s.
- [ ] Inter is the only font family.
- [ ] No emoji in product copy or icons. Use Lucide stroke SVGs.
- [ ] Every status appears as a chip with a leading semantic dot.
- [ ] Money is `font-variant-numeric: tabular-nums`, right-aligned in tables.
- [ ] Page header bars ≤ 56px, KPI strips ≤ 64px, modal title bars ≤ 48px.
- [ ] `+` Recast decorator appears at most twice per screen, only on Primary Blue surfaces or featured empty states.

---

## 3. Files touched

**Created**: none. (No new components — we restyle existing primitives.)

**Modified**:
- `css/variables.css` — token rewrite.
- `css/layout.css` — sidebar + topbar restyle, login background.
- `css/components.css` — primitives rewrite (buttons, table, stat-card, badge, form, modal, filter-bar, view-toggle, empty-state, search-bar, type-filter-bar). Update the `.modal--details` hero block (lines ~5217–5352).
- `css/dashboard.css` — strip the per-page stat-card overrides and gradients; let globals win.
- `css/quick-form.css`, `css/randy.css`, `css/ai-assistant.css` — only if any spill into chrome we restyle (chrome should be scoped; if not, scope it). Spot-fix only — these are widget-internal.
- `js/components/sidebar.js` — extend `setTopbarTitle` → `setTopbar({title, meta, chips, actions})`; tweak wordmark colors; flat avatar.
- `js/components/card.js` — `statCard()` markup unchanged; the icon slot just gets `display: none` under the new strip.
- `js/views/admin-dashboard.js` — push to topbar, drop in-view section-header, drop bento gradient on `.timeline-card`.
- `js/views/admin-opportunities.js` — push to topbar, drop magnifier icon, swap stage cell from grey badge to semantic chip + dot, replace details-modal hero with condensed strip.
- `js/views/admin-partners.js` — push to topbar.
- `js/views/admin-partner-detail.js` — replace hero with condensed strip; push to topbar.
- `js/views/admin-events.js` — push to topbar, swap status pills to chips with dots.
- `js/views/admin-setup.js` — push to topbar.
- `js/views/login.js` — flat `#0000CC` bg, `+` decorators, sharp card.
- `js/views/partner-dashboard.js`, `js/views/partner-marketing.js`, `js/views/partner-leadcheck.js`, `js/views/partner-resources.js` — push to topbar.

**Untouched**:
- `index.html` (already loads Inter; the `<link>` for Plus Jakarta Sans stays for now — removing it is a follow-up to keep this PR focused on visuals, not asset cleanup).
- `js/components/randy.js`, `js/components/voice-widget.js`, `js/components/quick-form.js`, `js/components/calendar.js` — internal widgets, restyle only if they leak into the audit. Out of scope per brief ("no marketing-style chrome inside the app" applies to data layer, not the assistant widgets).
- `js/components/descriptions-panel.js`, `documents-panel.js`, `map-pdf-pill.js` — used inside the deal pop-out, already harmonized via the scoped Recast block.
- Tests — none of the existing tests assert on visuals.

---

## 4. Risks & mitigations

- **Token color shift will cascade everywhere.** The `--color-primary` change from `#1E30CC` to `#0000CC` will repaint every blue accent in the portal. Mitigation: visual smoke-test each page after Phase A; the change is intentional but will look "different".
- **Section-header demotion may leave subsection eyebrow rules unstyled** if any view used `.section-header` for non-page-level headings (e.g., "Recent Activity" inside the dashboard). The dashboard's per-section headers stay — we keep `.section-header` working as an eyebrow-style sub-section label, not as a giant H1. Need a pass through every view to confirm what's a page header (→ topbar) vs sub-section header (→ eyebrow rule).
- **Existing scoped `.modal--details` redesign block** will overlap with the new global rules. The scoped rules win by specificity. Net effect: deal pop-out keeps its current "tall blue hero" until we update its scoped CSS in Phase C. Order matters: do the global primitives first, then the scoped block update, so we never have a half-styled popup in between.
- **Stat-card icon slot.** Existing `statCard()` JS passes SVG icons. The strip pattern omits icons. We keep the API and just hide the slot via CSS — no breaking change. If the dashboard later wants icons back, scope a `dashboard.css` override.
- **No automated regression**. Static site, no visual snapshot. Manual verification per page is the gate; the audit-pass greps catch hard-rule violations.

---

## 5. PR strategy

One PR per logical phase keeps blast radius small:
1. PR-1: Phase A + B — tokens, sidebar, topbar shell, `setTopbar` API. (Visual change everywhere; no per-view content change.)
2. PR-2: Phase C — primitives (buttons, table, stat-card, form, modal, badge, chips, view-toggle, empty-state).
3. PR-3: Phase D — per-screen sweep (one view at a time within the PR is fine; one PR is OK because changes are mechanical).
4. PR-4: Phase E — audit pass + the deal pop-out condensed-strip rewrite.

If the user prefers a single PR, fold all four into one — but staging gives reviewers a saner diff per step.

The branch is already `claude/apply-recast-styling-2H2TS`; ship sequential
commits on it and open one draft PR per phase (or one larger draft PR
covering the whole rollout, depending on user preference).
