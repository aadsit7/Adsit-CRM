// Unit tests for js/utils/map-pdf-builder.js.
//
// buildMapPdf() itself requires jsPDF + jspdf-autotable (loaded via CDN
// in index.html). Installing jsPDF as a dev dep solely to render in
// Node would bloat the test runner, so we stub a minimal jsPDF shim on
// globalThis.jspdf and assert the public surface, not the pixel output.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugName, mapFilename, blobToBase64, buildMapPdf } from '../js/utils/map-pdf-builder.js';

// ── slug + filename ──────────────────────────────────────────

test('slugName replaces spaces with underscores', () => {
  assert.equal(slugName('American National Insurance Company'), 'American_National_Insurance_Company');
});
test('slugName strips special characters', () => {
  assert.equal(slugName('AT&T, Inc.'), 'ATT_Inc');
});
test('slugName collapses repeated whitespace and underscores', () => {
  assert.equal(slugName('Foo     Bar___Baz'), 'Foo_Bar_Baz');
});
test('slugName caps at 60 chars', () => {
  const long = 'Super '.repeat(40);
  assert.ok(slugName(long).length <= 60);
});
test('slugName falls back to "opportunity" on empty', () => {
  assert.equal(slugName(''), 'opportunity');
  assert.equal(slugName(null), 'opportunity');
  assert.equal(slugName(undefined), 'opportunity');
});

test('mapFilename produces MAP_{slug}_{date}.pdf', () => {
  assert.equal(
    mapFilename('American National Insurance Company', '2026-04-22'),
    'MAP_American_National_Insurance_Company_2026-04-22.pdf',
  );
});
test('mapFilename trims timestamp precision if full ISO provided', () => {
  assert.equal(
    mapFilename('Acme', '2026-04-22T15:30:00Z'),
    'MAP_Acme_2026-04-22.pdf',
  );
});
test('mapFilename IGNORES non-ISO date strings and uses today — the Bug 2 regression', () => {
  // Previous behaviour sliced the first 10 chars of "April 22, 2026"
  // and produced "MAP_Greenshield_April_22_.pdf" (with trailing _).
  // Now we validate the shape and fall through to today's ISO date.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(mapFilename('Greenshield', 'April 22, 2026'), `MAP_Greenshield_${today}.pdf`);
  assert.equal(mapFilename('Greenshield', '4/22/2026'),      `MAP_Greenshield_${today}.pdf`);
  assert.equal(mapFilename('Greenshield'),                   `MAP_Greenshield_${today}.pdf`);
  assert.equal(mapFilename('Greenshield', null),             `MAP_Greenshield_${today}.pdf`);
  assert.equal(mapFilename('Greenshield', ''),               `MAP_Greenshield_${today}.pdf`);
});
test('mapFilename has no trailing underscore between slug and .pdf', () => {
  // Extra tight guard: even if slug + date produced weird edges, the
  // literal filename can never end in `_.pdf`.
  const name = mapFilename('Greenshield', 'April 22, 2026');
  assert.ok(!/_\.pdf$/.test(name), `filename should not end in _.pdf, got ${name}`);
});

// ── V1.5: sourceCount suffix ─────────────────────────────────

test('mapFilename appends _1source when sourceCount is 1', () => {
  assert.equal(
    mapFilename('Greenshield', '2026-04-22', 1),
    'MAP_Greenshield_2026-04-22_1source.pdf',
  );
});

test('mapFilename appends _Nsources when sourceCount >= 2', () => {
  assert.equal(
    mapFilename('Greenshield', '2026-04-22', 3),
    'MAP_Greenshield_2026-04-22_3sources.pdf',
  );
  assert.equal(
    mapFilename('Greenshield', '2026-04-22', 12),
    'MAP_Greenshield_2026-04-22_12sources.pdf',
  );
});

test('mapFilename without sourceCount is byte-identical to the V1 voice flow', () => {
  // Critical regression guard — the voice flow calls mapFilename with
  // only (customer, dateISO) and must continue to receive the exact
  // same filename it always has. Any change to this test means the
  // voice flow will also change; don't touch it without checking
  // randy.js.
  const d = '2026-04-22';
  assert.equal(
    mapFilename('Greenshield', d),
    'MAP_Greenshield_2026-04-22.pdf',
  );
  assert.equal(
    mapFilename('Greenshield', d, null),
    'MAP_Greenshield_2026-04-22.pdf',
  );
  assert.equal(
    mapFilename('Greenshield', d, undefined),
    'MAP_Greenshield_2026-04-22.pdf',
  );
});

test('mapFilename falls back to no-suffix when sourceCount is 0 or invalid', () => {
  // Documented edge case: the click-flow UI blocks generation when
  // count is 0 (the CTA is disabled), so this branch should never
  // hit in practice. Behaviourally, fall back to the no-suffix form
  // instead of throwing so a misfire can't break the filename.
  const d = '2026-04-22';
  assert.equal(mapFilename('Greenshield', d, 0),     'MAP_Greenshield_2026-04-22.pdf');
  assert.equal(mapFilename('Greenshield', d, -1),    'MAP_Greenshield_2026-04-22.pdf');
  assert.equal(mapFilename('Greenshield', d, 1.5),   'MAP_Greenshield_2026-04-22.pdf');
  assert.equal(mapFilename('Greenshield', d, '3'),   'MAP_Greenshield_2026-04-22.pdf');
});

// ── blobToBase64 ─────────────────────────────────────────────

// Node lacks FileReader / Blob.readAsDataURL by default; stub a minimal
// Blob-compat that blobToBase64 can chew. We only care that it invokes
// FileReader and strips the data: prefix.
test('blobToBase64 strips the data: prefix and returns base64', async () => {
  class FakeFileReader {
    onload = null;
    onerror = null;
    readAsDataURL(blob) {
      setTimeout(() => {
        this.result = `data:${blob._type};base64,${blob._b64}`;
        if (this.onload) this.onload();
      }, 0);
    }
  }
  globalThis.FileReader = FakeFileReader;

  const fakeBlob = { _type: 'application/pdf', _b64: 'SGVsbG8=' };  // "Hello"
  const out = await blobToBase64(fakeBlob);
  assert.equal(out, 'SGVsbG8=');
});

// ── buildMapPdf: smoke test via a jsPDF shim ────────────────

function installJsPdfShim() {
  const calls = [];
  function Shim() {
    this._calls = calls;
    this.internal = { getNumberOfPages: () => 2 };
    this.autoTable = (opts) => {
      calls.push({ op: 'autoTable', opts });
      this.lastAutoTable = { finalY: 600 };
    };
    this.setFillColor = (...a)   => calls.push({ op: 'setFillColor', a });
    this.setDrawColor = (...a)   => calls.push({ op: 'setDrawColor', a });
    this.setTextColor = (...a)   => calls.push({ op: 'setTextColor', a });
    this.setFont      = (...a)   => calls.push({ op: 'setFont', a });
    this.setFontSize  = (...a)   => calls.push({ op: 'setFontSize', a });
    this.setLineWidth = (...a)   => calls.push({ op: 'setLineWidth', a });
    this.rect         = (...a)   => calls.push({ op: 'rect', a });
    this.roundedRect  = (...a)   => calls.push({ op: 'roundedRect', a });
    this.line         = (...a)   => calls.push({ op: 'line', a });
    this.triangle     = (...a)   => calls.push({ op: 'triangle', a });
    this.circle       = (...a)   => calls.push({ op: 'circle', a });
    this.text         = (...a)   => calls.push({ op: 'text', a });
    this.addPage      = (...a)   => calls.push({ op: 'addPage', a });
    this.setPage      = (...a)   => calls.push({ op: 'setPage', a });
    this.splitTextToSize = (s)   => String(s).split(/\s{80,}/);
    this.getTextWidth = (s)      => String(s || '').length * 5;
    this.output = (kind) => {
      if (kind === 'blob') return { _isBlob: true, type: 'application/pdf', size: 42, __calls: calls };
      return '';
    };
  }
  // jspdf-autotable attaches itself to jsPDF.API.autoTable when its
  // script loads. The waitForJsPdf() probe checks this exact path,
  // so the shim must mirror it.
  Shim.API = { autoTable: () => {} };
  globalThis.window = globalThis.window || {};
  globalThis.window.jspdf = { jsPDF: Shim };
  return calls;
}

test('buildMapPdf returns a blob and hits autoTable once', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Acme Corp',
    document_date: 'April 22, 2026',
    meeting_recap: ['a', 'b'],
    current_environment: {
      infrastructure: ['x'],
      current_state_pain: ['y'],
      stakeholders_and_decision_process: ['z'],
    },
    proposed_delivery_targets: [{ name: 'AVD / Nerdio', subline: 'Non-persistent VDI' }],
    mutual_action_plan: [
      { phase: 'Discovery', action: 'do stuff', owner: 'Recast', due_date: '2026-05-01', status: 'Complete' },
      { phase: 'Discovery', action: 'more stuff', owner: 'Customer', due_date: '2026-05-08', status: 'In Progress' },
    ],
  };
  const blob = await buildMapPdf(json, { name: 'Acme Corp' });
  assert.equal(blob.type, 'application/pdf');
  assert.ok(blob.size > 0);
  const calls = blob.__calls;
  assert.ok(calls.some(c => c.op === 'autoTable'),
    'buildMapPdf must invoke autoTable for the MAP grid');
  assert.ok(calls.some(c => c.op === 'addPage'),
    'buildMapPdf must call addPage to force the architecture page');
});

test('buildMapPdf renders the new {label, detail} + {name, subline} shapes without crashing', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Test Customer',
    document_date: 'April 22, 2026',
    meeting_recap: [
      { label: 'Total Users', detail: '~4,000 confirmed on the call' },
      { label: 'Pricing delivered', detail: 'Tiered pricing sent March 6' },
      { label: '', detail: 'Legacy-shaped fallback bullet' },
    ],
    current_environment: {
      infrastructure: [
        { name: 'Citrix XenApp', subline: '~900 daily users License expires EOY 2026' },
        { name: 'NetScaler', subline: '' },
        { name: 'SCCM / ConfigMgr', subline: 'On-prem Windows device management' },
      ],
      current_state_pain: [
        'Application packaging consumes 40+ hours per week',
        'No unified visibility into compliance status',
      ],
      stakeholders_and_decision_process: [
        'Sponsor: VP of End User Computing',
      ],
    },
    // V1.6: Page 3 personas + What Changes callout are now grounded in
    // JSON. Populate both so this test exercises the full architecture
    // page — the conditional-rendering tests below cover the empty paths.
    proposed_delivery_targets: [{ name: 'AVD / Nerdio', subline: 'Non-persistent VDI' }],
    end_users_personas: [
      { label: 'Packaging Engineers', subline: 'Own application delivery workflow' },
    ],
    what_changes: 'Per-platform packaging eliminated; single console across delivery targets.',
    mutual_action_plan: [
      { phase: 'Discovery', action: 'Kickoff', owner: 'Recast', due_date: '2026-05-01', status: 'Complete' },
    ],
  };
  const blob = await buildMapPdf(json, { name: 'Test Customer' });
  assert.equal(blob.type, 'application/pdf');
  const calls = blob.__calls;
  // Architecture page adds a fresh page because the JSON has infra + pain.
  assert.ok(calls.some(c => c.op === 'addPage'), 'buildMapPdf must call addPage for the architecture page');
  // Customer name must appear in the Layer-1 heading of the architecture page.
  assert.ok(
    calls.some(c => c.op === 'text' && /Test Customer/.test(String(c.a?.[0] || ''))),
    'architecture page Layer 1 must name the customer',
  );
  // Layer 2 heading: "Current State — Per-Platform Delivery" (case-insensitive since it's uppercased).
  assert.ok(
    calls.some(c => c.op === 'text' && /PER-PLATFORM DELIVERY/i.test(String(c.a?.[0] || ''))),
    'architecture page Layer 2 must carry the per-platform delivery heading',
  );
  // Layer 6 centerpiece must be rendered.
  assert.ok(
    calls.some(c => c.op === 'text' && /APPLICATION WORKSPACE/.test(String(c.a?.[0] || ''))),
    'architecture page Layer 6 must render the APPLICATION WORKSPACE centerpiece',
  );
  // Layer 8 "What Changes:" callout must be rendered because the JSON
  // supplied a non-empty what_changes string.
  assert.ok(
    calls.some(c => c.op === 'text' && /What Changes:/.test(String(c.a?.[0] || ''))),
    'architecture page Layer 8 must render the What Changes callout when what_changes is populated',
  );
  // Priority 6: the V1 "Tailored for ..." footer line must be gone.
  assert.ok(
    !calls.some(c => c.op === 'text' && /Tailored for/.test(String(c.a?.[0] || ''))),
    'orphaned "Tailored for" line must not appear anywhere in the PDF',
  );
});

test('waitForJsPdf throws a clear timeout error when libraries are missing', async () => {
  const { waitForJsPdf } = await import('../js/utils/map-pdf-builder.js');
  // Wipe the globals the builder probes for.
  delete globalThis.window?.jspdf;
  if (globalThis.window) delete globalThis.window.jsPDF;
  await assert.rejects(
    () => waitForJsPdf({ timeoutMs: 30, pollMs: 10 }),
    (err) => /jsPDF/i.test(err.message) && /didn't finish loading/i.test(err.message),
  );
});

test('waitForJsPdf flags autotable specifically when jsPDF is present but plugin is missing', async () => {
  const { waitForJsPdf } = await import('../js/utils/map-pdf-builder.js');
  function BareJs() {}
  // No API.autoTable — autotable "hasn't loaded yet"
  globalThis.window = globalThis.window || {};
  globalThis.window.jspdf = { jsPDF: BareJs };
  await assert.rejects(
    () => waitForJsPdf({ timeoutMs: 30, pollMs: 10 }),
    (err) => /jspdf-autotable/i.test(err.message),
  );
});

// ─────────────────────────────────────────────────────────────
// V1.6 — Golden Rule conditional rendering
// ─────────────────────────────────────────────────────────────
//
// Every section of the PDF is allowed to be empty. When it is, the
// renderer omits it silently — no heading bar, no placeholder copy,
// no "[Environment details to be collected]" narrative. These tests
// lock in each branch of the section-skip contract so future edits
// can't accidentally re-introduce fabricated fallback content.

function textOps(calls) {
  return calls.filter(c => c.op === 'text').map(c => String(c.a?.[0] || ''));
}
function hasText(calls, re) {
  return textOps(calls).some(t => re.test(t));
}

test('V1.6 thin-source MAP: only Page 1 recap + MAP table render — no Current Environment heading, no Page 3', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Greenshield',
    document_date: 'April 22, 2026',
    meeting_recap: [
      { label: 'Attendees', detail: 'Met with Joe' },
      { label: 'Pricing',   detail: 'Pricing discussed' },
      { label: 'Follow-up', detail: 'Sent follow-up email' },
    ],
    current_environment: {
      infrastructure: [],
      current_state_pain: [],
      stakeholders_and_decision_process: [],
    },
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [
      { phase: 'Discovery', action: 'Follow up with Joe', owner: 'Recast', due_date: '2026-05-01', status: 'Pending' },
    ],
  };
  const blob = await buildMapPdf(json, { name: 'Greenshield' });
  const calls = blob.__calls;

  // Meeting Recap heading renders.
  assert.ok(hasText(calls, /^MEETING RECAP$/),
    'Meeting Recap heading must always render');
  // MAP table heading renders (autoTable is invoked once for the MAP).
  assert.ok(calls.some(c => c.op === 'autoTable'),
    'MAP table must render when there are rows');
  assert.ok(hasText(calls, /^MUTUAL ACTION PLAN$/),
    'MAP heading must render when there are rows');

  // The blue "YOUR CURRENT ENVIRONMENT" heading must NOT render.
  assert.ok(!hasText(calls, /^YOUR CURRENT ENVIRONMENT$/),
    'Current Environment heading must be skipped when all three subsections are empty');
  // No Infrastructure / Pain Points / Stakeholders sub-labels either.
  assert.ok(!hasText(calls, /^Infrastructure$/),
    'Infrastructure sub-label must be skipped when infra is empty');
  assert.ok(!hasText(calls, /^Current State Pain Points$/),
    'Pain Points sub-label must be skipped when pain is empty');
  assert.ok(!hasText(calls, /^Stakeholders & Decision Process$/),
    'Stakeholders sub-label must be skipped when stakeholders is empty');

  // Page 3 must not be added at all — no doc.addPage() call.
  assert.ok(!calls.some(c => c.op === 'addPage'),
    'Architecture page must NOT render for a thin source with no infra and no pain');
  // And none of Page 3's visuals leaked onto Page 1.
  assert.ok(!hasText(calls, /APPLICATION WORKSPACE/),
    'APPLICATION WORKSPACE centerpiece must not render when Page 3 is skipped');
  assert.ok(!hasText(calls, /What Changes:/),
    'What Changes callout must not render when Page 3 is skipped');
});

test('V1.6 full MAP renders all three pages like today', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Full Customer',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Attendees', detail: 'Full call' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: '~900 daily users' }],
      current_state_pain: ['Packaging overhead'],
      stakeholders_and_decision_process: ['Sponsor: VP EUC'],
    },
    proposed_delivery_targets: [{ name: 'AVD / Nerdio', subline: 'Non-persistent VDI' }],
    end_users_personas: [
      { label: 'Packaging Engineers', subline: '' },
    ],
    what_changes: 'RES eliminated; single console across delivery targets.',
    mutual_action_plan: [
      { phase: 'Discovery', action: 'Kickoff', owner: 'Recast', due_date: '2026-05-01', status: 'Complete' },
    ],
  };
  const blob = await buildMapPdf(json, { name: 'Full Customer' });
  const calls = blob.__calls;

  assert.ok(hasText(calls, /^YOUR CURRENT ENVIRONMENT$/),
    'full MAP must render the Current Environment heading');
  assert.ok(hasText(calls, /^Infrastructure$/), 'full MAP must render Infrastructure sub-label');
  assert.ok(hasText(calls, /^Current State Pain Points$/), 'full MAP must render Pain sub-label');
  assert.ok(hasText(calls, /^Stakeholders & Decision Process$/), 'full MAP must render Stakeholders sub-label');
  assert.ok(calls.some(c => c.op === 'addPage'), 'full MAP must render Page 3');
  assert.ok(hasText(calls, /What Changes:/), 'full MAP must render What Changes callout');
  assert.ok(hasText(calls, /Packaging Engineers/), 'full MAP must render grounded personas');
});

test('V1.6 infra-only MAP: Page 3 current-state boxes render but Key Friction callout is skipped', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Infra Only',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Env', detail: 'Reviewed systems' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: '~900 daily users' }],
      current_state_pain: [],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [{ name: 'AVD / Nerdio', subline: '' }],
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'Infra Only' });
  const calls = blob.__calls;

  // Page 3 exists (anchor is infrastructure).
  assert.ok(calls.some(c => c.op === 'addPage'),
    'Page 3 must render when infrastructure has content');
  // Layer 2 (tools grid heading) renders.
  assert.ok(hasText(calls, /PER-PLATFORM DELIVERY/i),
    'Layer 2 per-platform-delivery heading must render when infra is populated');
  // Key Friction callout is skipped (no pains in source).
  assert.ok(!hasText(calls, /Key Friction:/),
    'Key Friction callout must be skipped when pain array is empty');
});

test('V1.6 pain-only MAP: Page 3 Key Friction callout renders but current-state boxes are skipped', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Pain Only',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Pain', detail: 'Customer aired frustrations' }],
    current_environment: {
      infrastructure: [],
      current_state_pain: ['Packaging consumes 40+ hours per week'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [{ name: 'Intune', subline: 'Physical endpoints' }],
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'Pain Only' });
  const calls = blob.__calls;

  // Page 3 exists (anchor is pain).
  assert.ok(calls.some(c => c.op === 'addPage'),
    'Page 3 must render when pain has content even if infra is empty');
  // Key Friction callout renders.
  assert.ok(hasText(calls, /Key Friction:/),
    'Key Friction callout must render when pain is populated');
  // Layer 2 current-state boxes heading is skipped.
  assert.ok(!hasText(calls, /PER-PLATFORM DELIVERY/i),
    'Layer 2 per-platform-delivery heading must be skipped when infra is empty');
});

test('V1.6 both infra + pain empty: buildMapPdf must NOT call addPage for Page 3', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'No Arch',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Intro call', detail: 'Short call, no tech details' }],
    current_environment: {
      infrastructure: [],
      current_state_pain: [],
      stakeholders_and_decision_process: ['Joe Richardson attended'],
    },
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'No Arch' });
  const calls = blob.__calls;

  // Stakeholders alone is NOT enough to anchor Page 3 — the transformation
  // narrative needs either a current state (infra) or a friction point.
  assert.ok(!calls.some(c => c.op === 'addPage'),
    'Page 3 must be skipped (no addPage) when infra AND pain are both empty');
  // But the Current Environment section itself still renders because
  // stakeholders is populated — whole-env gate is independent.
  assert.ok(hasText(calls, /^YOUR CURRENT ENVIRONMENT$/),
    'Current Environment heading renders when any subsection (incl. stakeholders) has content');
  assert.ok(hasText(calls, /^Stakeholders & Decision Process$/),
    'Stakeholders sub-label renders when stakeholders is populated');
});

test('V1.6 Page 3 without what_changes renders the diagram as the visual conclusion — no green callout', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Diagram Only',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Env', detail: 'Reviewed systems' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: '' }],
      current_state_pain: ['Packaging is slow'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [{ name: 'AVD / Nerdio', subline: '' }],
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'Diagram Only' });
  const calls = blob.__calls;

  // Page 3 exists (anchor is infra + pain).
  assert.ok(calls.some(c => c.op === 'addPage'),
    'Page 3 must render when infra and pain are both populated');
  // Architecture diagram centerpiece renders — visual conclusion.
  assert.ok(hasText(calls, /APPLICATION WORKSPACE/),
    'APPLICATION WORKSPACE centerpiece must render on Page 3');
  // "What Changes:" callout must NOT render because the JSON didn't supply it.
  assert.ok(!hasText(calls, /What Changes:/),
    'What Changes callout must be skipped when what_changes is empty — no hardcoded fallback');
  // No generic "Office Workers / Remote / VDI Users / External Users" fallback personas.
  assert.ok(!hasText(calls, /Office Workers/),
    'hardcoded "Office Workers" persona fallback must be removed');
  assert.ok(!hasText(calls, /VDI Users/),
    'hardcoded "VDI Users" persona fallback must be removed');
});

test('V1.6 empty MAP table: skip the heading bar entirely — no placeholder row', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'No Action Items',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Chat', detail: 'Informal call' }],
    current_environment: {
      infrastructure: [],
      current_state_pain: [],
      stakeholders_and_decision_process: [],
    },
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'No Action Items' });
  const calls = blob.__calls;

  // MAP heading must NOT render.
  assert.ok(!hasText(calls, /^MUTUAL ACTION PLAN$/),
    'MAP heading must be skipped when the action plan array is empty');
  // autoTable must not be called (no placeholder row, no "No action items captured yet").
  assert.ok(!calls.some(c => c.op === 'autoTable'),
    'autoTable must not be invoked when there are no MAP rows');
  assert.ok(!hasText(calls, /No action items captured yet/),
    'legacy "No action items captured yet" placeholder must not render — that was fabricated narrative');
});

test('V1.6 personas row: hardcoded generic personas are gone; grounded personas render when supplied', async () => {
  installJsPdfShim();
  // Grounded personas: Page 3 renders them verbatim.
  const json1 = {
    customer_name: 'C',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'x', detail: 'y' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: '' }],
      current_state_pain: ['slow'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [{ name: 'AVD / Nerdio', subline: '' }],
    end_users_personas: [
      { label: 'Packaging Engineers', subline: 'Own application delivery workflow' },
      { label: 'Helpdesk',            subline: '' },
    ],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob1 = await buildMapPdf(json1, { name: 'C' });
  const calls1 = blob1.__calls;
  assert.ok(hasText(calls1, /Packaging Engineers/),
    'grounded persona label must render when supplied');
  assert.ok(hasText(calls1, /Helpdesk/),
    'grounded persona label must render even when its subline is empty');
  // None of the legacy generic persona labels should appear.
  assert.ok(!hasText(calls1, /Office Workers/),  'legacy "Office Workers" must not render');
  assert.ok(!hasText(calls1, /^Remote \/ Hybrid$/), 'legacy "Remote / Hybrid" must not render');
  assert.ok(!hasText(calls1, /External Users/),  'legacy "External Users" must not render');

  // Empty personas: row is skipped entirely (no heading label, no boxes).
  installJsPdfShim();
  const json2 = { ...json1, end_users_personas: [] };
  const blob2 = await buildMapPdf(json2, { name: 'C' });
  const calls2 = blob2.__calls;
  assert.ok(!hasText(calls2, /^End Users$/),
    'End Users heading must be skipped when personas is empty');
});

// ─────────────────────────────────────────────────────────────
// V1.7a — Greenshield-style header
// ─────────────────────────────────────────────────────────────

const THIN_JSON = {
  customer_name: 'Greenshield',
  document_date: 'March 16, 2026',
  meeting_recap: [],
  current_environment: { infrastructure: [], current_state_pain: [], stakeholders_and_decision_process: [] },
  end_users_personas: [],
  what_changes: '',
  mutual_action_plan: [],
};

test('V1.7a header band height is within 70-90pt (no oversized banner)', async () => {
  installJsPdfShim();
  const blob = await buildMapPdf(THIN_JSON, {});
  const calls = blob.__calls;
  const bandRect = calls.find(c => c.op === 'rect' && c.a[0] === 0 && c.a[1] === 0 && c.a[2] === 612);
  assert.ok(bandRect, 'header band rect must exist at (0,0) spanning full page width');
  const h = bandRect.a[3];
  assert.ok(h >= 70 && h <= 90, `header band height must be 70-90pt, got ${h}`);
});

test('V1.7a header: customer name renders as small metadata (≤12pt), not a large standalone element', async () => {
  installJsPdfShim();
  const blob = await buildMapPdf(THIN_JSON, {});
  const calls = blob.__calls;
  let currentFontSize = 12;
  const fontSizesAtCustomerName = [];
  for (const c of calls) {
    if (c.op === 'setFontSize') currentFontSize = c.a[0];
    if (c.op === 'text' && /Greenshield/.test(String(c.a?.[0] || ''))) {
      fontSizesAtCustomerName.push(currentFontSize);
    }
  }
  assert.ok(fontSizesAtCustomerName.length > 0, 'customer name must appear in the header');
  assert.ok(
    fontSizesAtCustomerName.every(sz => sz <= 12),
    `customer name must only appear at ≤12pt (metadata treatment), found sizes: ${fontSizesAtCustomerName}`,
  );
});

test('V1.7a header: coral divider bar (#E07050) renders immediately below the header band', async () => {
  installJsPdfShim();
  const blob = await buildMapPdf(THIN_JSON, {});
  const calls = blob.__calls;
  const bandRect = calls.find(c => c.op === 'rect' && c.a[0] === 0 && c.a[1] === 0 && c.a[2] === 612);
  assert.ok(bandRect, 'header band must exist');
  const bandBottom = bandRect.a[1] + bandRect.a[3];
  let lastFillColor = null;
  let dividerFound = false;
  for (const c of calls) {
    if (c.op === 'setFillColor') lastFillColor = c.a;
    if (c.op === 'rect' && c.a[0] === 0 && c.a[1] === bandBottom && c.a[3] <= 5) {
      if (lastFillColor && lastFillColor[0] === 224 && lastFillColor[1] === 112 && lastFillColor[2] === 80) {
        dividerFound = true;
      }
    }
  }
  assert.ok(dividerFound, `coral divider bar (#E07050) must render at y=${bandBottom} below the header band`);
});

// ─────────────────────────────────────────────────────────────
// V1.8 — Dynamic proposed_delivery_targets (T1–T6)
// ─────────────────────────────────────────────────────────────

test('T1 dynamic targets: Greenshield scenario — AVD/Nerdio, SCCM, Intune, Jamf present; Windows 365 absent', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Greenshield',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Direction', detail: 'Citrix exit; moving to AVD/Nerdio and Jamf' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: 'Exiting EOY 2026' }],
      current_state_pain: ['Citrix licensing costs rising'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [
      { name: 'AVD / Nerdio', subline: 'Non-persistent VDI' },
      { name: 'SCCM',         subline: '' },
      { name: 'Intune',       subline: 'Physical endpoints' },
      { name: 'Jamf',         subline: 'macOS management' },
    ],
    end_users_personas: [],
    what_changes: 'Citrix eliminated; AVD/Nerdio adoption managed without repackaging.',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'Greenshield' });
  const calls = blob.__calls;

  assert.ok(calls.some(c => c.op === 'addPage'),
    'Page 3 must render when proposed_delivery_targets is populated');
  assert.ok(hasText(calls, /AVD \/ Nerdio/), 'AVD / Nerdio must render');
  assert.ok(hasText(calls, /^SCCM$/),        'SCCM must render');
  assert.ok(hasText(calls, /^Intune$/),       'Intune must render');
  assert.ok(hasText(calls, /^Jamf$/),         'Jamf must render');
  assert.ok(!hasText(calls, /Windows 365/),
    'Windows 365 must NOT render — not in Greenshield proposed targets');
  assert.ok(hasText(calls, /What Changes:/),
    'What Changes callout must render when what_changes is populated');
  assert.ok(hasText(calls, /Citrix eliminated/),
    'What Changes must contain customer-specific Citrix language');
});

test('T2 dynamic targets: Windows 365-heavy customer — W365 renders, AVD absent', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'CloudFirst Corp',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Direction', detail: 'Moving entirely to Windows 365 Cloud PCs' }],
    current_environment: {
      infrastructure: [{ name: 'SCCM', subline: 'On-prem managed' }],
      current_state_pain: ['On-prem complexity'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [
      { name: 'Windows 365', subline: 'Cloud PCs' },
    ],
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'CloudFirst Corp' });
  const calls = blob.__calls;

  assert.ok(calls.some(c => c.op === 'addPage'), 'Page 3 must render');
  assert.ok(hasText(calls, /Windows 365/), 'Windows 365 must render');
  assert.ok(!hasText(calls, /AVD/),        'AVD must not render — not in this customer\'s proposed targets');
  assert.ok(!hasText(calls, /Nerdio/),     'Nerdio must not render');
});

test('T3 dynamic targets: Mac-heavy customer — single Jamf box, no Windows targets', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'MacFirst Inc',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Fleet', detail: 'Entirely macOS managed via Jamf' }],
    current_environment: {
      infrastructure: [{ name: 'Jamf', subline: 'Current macOS management' }],
      current_state_pain: ['App delivery fragmented across Mac fleet'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [
      { name: 'Jamf', subline: 'macOS management' },
    ],
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'MacFirst Inc' });
  const calls = blob.__calls;

  assert.ok(calls.some(c => c.op === 'addPage'), 'Page 3 must render');
  assert.ok(hasText(calls, /^Jamf$/),    'Single Jamf box must render in proposed targets');
  assert.ok(!hasText(calls, /^Intune$/), 'Intune must not render for a Mac-only customer');
  assert.ok(!hasText(calls, /AVD/),      'AVD must not render for a Mac-only customer');
});

test('T4 dynamic targets: empty proposed_delivery_targets skips Page 3 even when infra + pain are present', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Sparse Data Co',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Intro', detail: 'First call — no architecture detail yet' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: 'Some details' }],
      current_state_pain: ['Licensing pain'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [],
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'Sparse Data Co' });
  const calls = blob.__calls;

  assert.ok(!calls.some(c => c.op === 'addPage'),
    'Architecture page must be skipped when proposed_delivery_targets is empty — a missing section is better than a fabricated one');
  assert.ok(!hasText(calls, /APPLICATION WORKSPACE/),
    'APPLICATION WORKSPACE must not render when architecture page is skipped');
  assert.ok(!hasText(calls, /HOW APPLICATION WORKSPACE FITS/),
    'Page 3 heading must not render when architecture page is skipped');
});

test('T5 dynamic targets: what_changes renders customer-specific narrative (not generic pitch)', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Transition Corp',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Exit', detail: 'Citrix exit confirmed for Q3' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: 'Exiting Q3 2026' }],
      current_state_pain: ['Licensing cost spike'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [{ name: 'AVD / Nerdio', subline: 'Non-persistent VDI' }],
    end_users_personas: [],
    what_changes: 'Citrix eliminated; AVD/Nerdio adoption without repackaging.',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'Transition Corp' });
  const calls = blob.__calls;

  assert.ok(hasText(calls, /What Changes:/),
    'What Changes callout must render');
  assert.ok(hasText(calls, /Citrix eliminated/),
    'What Changes must contain the customer-specific transition language');
});

test('T6 dynamic targets: four proposed targets all render without crashing (variable-height boxes)', async () => {
  installJsPdfShim();
  const json = {
    customer_name: 'Multi Target Corp',
    document_date: 'April 22, 2026',
    meeting_recap: [{ label: 'Mix', detail: 'Multi-platform environment' }],
    current_environment: {
      infrastructure: [{ name: 'Citrix', subline: '' }],
      current_state_pain: ['Complexity'],
      stakeholders_and_decision_process: [],
    },
    proposed_delivery_targets: [
      { name: 'AVD / Nerdio', subline: 'Non-persistent VDI' },
      { name: 'Intune',       subline: 'Physical endpoints' },
      { name: 'Jamf',         subline: 'macOS management' },
      { name: 'Windows 365',  subline: 'Cloud PCs' },
    ],
    end_users_personas: [],
    what_changes: '',
    mutual_action_plan: [],
  };
  const blob = await buildMapPdf(json, { name: 'Multi Target Corp' });
  const calls = blob.__calls;

  assert.ok(calls.some(c => c.op === 'addPage'), 'Page 3 must render');
  assert.ok(hasText(calls, /AVD \/ Nerdio/), 'AVD / Nerdio must render');
  assert.ok(hasText(calls, /^Intune$/),       'Intune must render');
  assert.ok(hasText(calls, /^Jamf$/),         'Jamf must render');
  assert.ok(hasText(calls, /Windows 365/),    'Windows 365 must render');
});
