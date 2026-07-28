// Tests for the Partner Analyzer's LIKELY ORG CHART capability — the
// Partner-mode analogue of the Contact brief's "Likely Organizational Map".
//
// Covers the whole pipeline the feature rides on:
//   • roster building (strict Partner_Contacts scoping; contact_id+name+role
//     ONLY — emails/phones can never leak into the prompt),
//   • prompt composition (roster block, org_map contract, empty-roster line),
//   • strict parsing (status canonicalization, depth clamping, node cap,
//     roster-anchored contact_id — fabricated ids are stripped),
//   • TRUTH OVER COMPLETENESS enforcement: a named person the validator
//     cannot find in the saved roster or the supplied evidence text is
//     REMOVED (and the removal is counted in org_map_meta), person and
//     reporting-line confidence are scored separately (the explicit →
//     observed → inferred → scaffold ladder, with deterministic clamps),
//     cross-source corroboration and last-seen dates are app-computed,
//     duplicates collapse, exact roster names auto-link, and gap nodes stay
//     visible as scaffold questions rather than answers,
//   • the partner_contact structured source for key_stakeholders_identified,
//   • scoring isolation (an org chart can never move a maturity criterion),
//   • the shared tree/stat derivations the view and the PDF both use, and
//   • the end-to-end client flow plus the PDF org-chart section.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectPartnerContacts,
  buildPartnerContactRoster,
  CONTACT_ROSTER_LIMIT,
  buildPartnerCriteriaFacts,
  collectPartnerAnchors,
  assemblePartnerEvidence,
  buildPartnerKpis,
} from '../js/utils/partner-analyzer-evidence.js';
import { buildPartnerAnalyzerPrompt } from '../js/utils/partner-analyzer-prompts.js';
import {
  parsePartnerAnalysisResponse,
  buildOrgChartTree,
  derivePartnerOrgStats,
  PARTNER_ANALYZER_SCHEMA_EXAMPLE,
  VALID_SOURCE_TYPES,
} from '../js/utils/partner-analyzer-schema.js';
import { preparePartnerAnalysis, requestPartnerAnalysisJson } from '../js/utils/partner-analyzer-client.js';
import { buildPartnerAnalysisPdf } from '../js/utils/partner-analyzer-pdf-builder.js';

const TODAY = '2026-07-21';
const PARTNER = { partner_id: 'p1', display_name: 'Nerdio', partner_type: 'Technology', tier: 'Premier/Strategic', region: 'North America', hq_location: 'Chicago', status: 'active', created_at: '2026-01-15' };

// Partner_Contacts rows — p1's roster plus another partner's row and edge
// cases that must never reach the prompt.
const PARTNER_CONTACTS = [
  { contact_id: 'ct2', partner_id: 'p1', partner_name: 'Nerdio', name: 'Zoe Alvarez', role: 'VP Alliances', company: 'Nerdio', email: 'zoe@getnerdio.com', phone: '555-201-9999', evidence: 'intro call' },
  { contact_id: 'ct1', partner_id: 'p1', partner_name: 'Nerdio', name: 'Amir Khan', role: 'Solutions Architect', company: 'Nerdio', email: 'amir@getnerdio.com', phone: '' },
  { contact_id: 'ct3', partner_id: 'p1', partner_name: 'Nerdio', name: '', role: '', company: '', email: 'mystery@getnerdio.com', phone: '' }, // nameless — org chart can't label it without leaking the email
  { contact_id: 'ct9', partner_id: 'p2', partner_name: 'Elantis', name: 'Eve Larson', role: 'CEO', company: 'Elantis', email: 'eve@elantis.com', phone: '' }, // other partner
  { contact_id: '', partner_id: 'p1', name: 'No Id Person', role: 'Ghost', email: '' }, // no contact_id — unciteable
];

function rosterFor(partnerId = 'p1') {
  return buildPartnerContactRoster(selectPartnerContacts(PARTNER_CONTACTS, partnerId));
}

// ── Roster building (strict scoping + privacy) ───────────────────────
test('selectPartnerContacts keeps only this partner’s rows that carry a contact_id', () => {
  const rows = selectPartnerContacts(PARTNER_CONTACTS, 'p1');
  const ids = rows.map(r => r.contact_id).sort();
  assert.deepEqual(ids, ['ct1', 'ct2', 'ct3']);
  assert.ok(!rows.some(r => r.partner_id === 'p2'), 'another partner’s contact must never be selected');
});

test('buildPartnerContactRoster: named rows only, A→Z, contact_id+name+role ONLY', () => {
  const roster = rosterFor();
  assert.equal(roster.total, 2, 'the nameless row is excluded');
  assert.equal(roster.omittedCount, 0);
  assert.deepEqual(roster.included.map(c => c.name), ['Amir Khan', 'Zoe Alvarez'], 'sorted by name');
  for (const c of roster.included) {
    assert.deepEqual(Object.keys(c).sort(), ['contact_id', 'name', 'role'], 'no email/phone/evidence fields may survive');
  }
});

test('buildPartnerContactRoster caps the roster and reports the omission', () => {
  const many = Array.from({ length: CONTACT_ROSTER_LIMIT + 5 }, (_, i) => ({
    contact_id: `c${i}`, partner_id: 'p1', name: `Person ${String(i).padStart(3, '0')}`, role: 'Role',
  }));
  const roster = buildPartnerContactRoster(many);
  assert.equal(roster.total, CONTACT_ROSTER_LIMIT + 5);
  assert.equal(roster.included.length, CONTACT_ROSTER_LIMIT);
  assert.equal(roster.omittedCount, 5);
});

// ── Prompt composition ───────────────────────────────────────────────
function promptWith(roster) {
  const kpis = buildPartnerKpis({ partner: PARTNER, transcripts: [], meetings: [], documents: [], events: [], opportunities: [], today: TODAY });
  const evidence = assemblePartnerEvidence({});
  return buildPartnerAnalyzerPrompt({ partner: PARTNER, kpis, evidence, contactRoster: roster, today: TODAY });
}

test('prompt carries the roster (ids, names, roles) but never emails or phones', () => {
  const prompt = promptWith(rosterFor());
  assert.ok(prompt.includes('SAVED PARTNER CONTACTS'), 'roster section present');
  assert.ok(prompt.includes('[contact_id: ct2] Zoe Alvarez — VP Alliances'));
  assert.ok(prompt.includes('[contact_id: ct1] Amir Khan — Solutions Architect'));
  assert.ok(!prompt.includes('getnerdio.com'), 'emails must never enter the prompt');
  assert.ok(!prompt.includes('555-201-9999'), 'phones must never enter the prompt');
  assert.ok(!prompt.includes('Eve Larson'), 'another partner’s contact must never enter the prompt');
});

test('prompt explains the org_map contract and the partner_contact source type', () => {
  const prompt = promptWith(rosterFor());
  assert.ok(/ORG CHART \("org_map"\)/.test(prompt), 'org-chart guidance present');
  assert.ok(/never invent a named person/i.test(prompt));
  assert.ok(/Never fabricate a contact_id/i.test(prompt));
  assert.ok(/not an official org chart/i.test(prompt));
  assert.ok(prompt.includes('source_type "partner_contact"'));
  assert.ok(PARTNER_ANALYZER_SCHEMA_EXAMPLE.includes('"org_map"'), 'schema example carries org_map');
  assert.ok(PARTNER_ANALYZER_SCHEMA_EXAMPLE.includes('partner_contact'), 'schema example allows the new source type');
});

test('prompt teaches the accuracy contract: truth over completeness and the line-confidence ladder', () => {
  const prompt = promptWith(rosterFor());
  assert.ok(/TRUTH OVER COMPLETENESS/.test(prompt), 'the governing rule is stated');
  assert.ok(/PERSON AND THE REPORTING LINE ARE RATED SEPARATELY/i.test(prompt), 'person vs line split is explicit');
  for (const rung of ['"explicit"', '"observed"', '"inferred"', '"scaffold"']) {
    assert.ok(prompt.includes(rung), `ladder rung ${rung} defined`);
  }
  assert.ok(/removes any named node it cannot find/i.test(prompt), 'the model is warned that fabrications are removed');
  assert.ok(/line_basis/.test(prompt), 'line_basis asked for');
  assert.ok(PARTNER_ANALYZER_SCHEMA_EXAMPLE.includes('line_confidence'), 'schema example carries line_confidence');
  assert.ok(PARTNER_ANALYZER_SCHEMA_EXAMPLE.includes('line_basis'), 'schema example carries line_basis');
});

test('an empty roster gets the explicit empty-state instruction instead of names', () => {
  const prompt = promptWith(buildPartnerContactRoster([]));
  assert.ok(/No saved partner contacts on file/i.test(prompt));
  assert.ok(!prompt.includes('[contact_id:'), 'no roster entries listed');
});

// ── Strict parsing of org_map ────────────────────────────────────────
// Roster-only anchors: two saved contacts, no narrative evidence supplied.
const CONTACT_ANCHORS = {
  narrativeIds: new Set(), narrativeDates: new Set(),
  textById: new Map(), textByDate: new Map(),
  structuredIds: new Set(['p1', 'ct1', 'ct2']),
  relatedById: new Map(), partnerId: 'p1',
  contactIds: new Set(['ct1', 'ct2']),
  contactNamesById: new Map([['ct1', 'Amir Khan'], ['ct2', 'Zoe Alvarez']]),
};

// Roster + narrative evidence: the SAME bounded texts the model was shown,
// naming Zoe (a saved contact), Priya (not saved) and Böb (diacritics).
const EVIDENCE_TEXT_MAY = 'Call with Zoe Alvarez and their CTO Priya Nair. Priya said the rollout team reports to her. Marketing lead Böb Ünger joined late.';
const EVIDENCE_TEXT_JUNE = 'Follow-up with Priya Nair about the joint GTM plan.';
const EVIDENCE_ANCHORS = {
  ...CONTACT_ANCHORS,
  narrativeIds: new Set(['t1', 't2']),
  narrativeDates: new Set(['2026-05-12', '2026-06-02']),
  textById: new Map([['t1', EVIDENCE_TEXT_MAY], ['t2', EVIDENCE_TEXT_JUNE]]),
  textByDate: new Map([['2026-05-12', EVIDENCE_TEXT_MAY], ['2026-06-02', EVIDENCE_TEXT_JUNE]]),
};

function parseWithOrgMap(orgMap, { facts, anchors = CONTACT_ANCHORS, stages = [] } = {}) {
  const raw = JSON.stringify({
    partner_id: 'p1', partner_name: 'Nerdio', confidence: 'low', summary: '',
    stages, next_actions: [], gaps: [], open_questions: [], risks: [], momentum: [],
    org_map: orgMap,
  });
  return parsePartnerAnalysisResponse(raw, { partnerId: 'p1', partnerName: 'Nerdio', anchors, facts });
}

test('org_map nodes are structurally validated: status canon, depth clamp, name required', () => {
  const out = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'actively working together', depth: 0, contact_id: 'ct2' },
    { name: 'Amir Khan — Solutions Architect', status: 'INTRODUCED', depth: '1', contact_id: 'ct1' },
    { name: 'CTO (not yet identified)', status: 'gap — absent', depth: 99 },
    { name: '   ', status: 'engaged', depth: 1 },          // nameless — dropped
    'not-an-object',                                        // dropped
  ]);
  assert.equal(out.org_map.length, 3);
  assert.deepEqual(out.org_map[0], {
    name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2',
    line_confidence: '', line_basis: '', person_source: 'roster', corroborated: false, last_seen_date: '',
  });
  assert.equal(out.org_map[1].status, 'introduced');
  assert.equal(out.org_map[1].depth, 1);
  assert.equal(out.org_map[1].line_confidence, 'inferred', 'an unstated line defaults to the honest middle rung');
  assert.equal(out.org_map[2].status, 'missing');
  assert.equal(out.org_map[2].depth, 6, 'depth clamps to 6');
  assert.equal(out.org_map[2].person_source, 'gap');
  assert.equal(out.org_map[2].line_confidence, 'scaffold', 'a gap node is scaffold by definition');
});

test('a fabricated contact_id is stripped, and an unverifiable name is removed outright', () => {
  const out = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
    { name: 'Fake Person — CFO', status: 'identified', depth: 1, contact_id: 'ct999' },
  ]);
  assert.equal(out.org_map.length, 1, 'a name found in neither the roster nor the evidence never renders');
  assert.equal(out.org_map[0].contact_id, 'ct2');
  assert.equal(out.org_map_meta.removed_unverified, 1, 'the removal is surfaced, not silent');
});

test('a fabricated contact_id on an evidence-named person is stripped while the person survives', () => {
  const out = parseWithOrgMap([
    { name: 'Priya Nair — CTO', status: 'engaged', depth: 0, contact_id: 'ct999' },
  ], { anchors: EVIDENCE_ANCHORS });
  assert.equal(out.org_map.length, 1);
  assert.equal(out.org_map[0].contact_id, '', 'an id not in the supplied roster can never masquerade as saved');
  assert.equal(out.org_map[0].person_source, 'evidence');
});

test('org_map is bounded to 30 nodes and tolerates a missing/malformed section', () => {
  // Declared gaps are legitimate nodes, so they exercise the cap without
  // tripping the fabricated-name removal.
  const big = Array.from({ length: 40 }, (_, i) => ({ name: `Role ${i} (not yet identified)`, status: 'missing', depth: 0 }));
  assert.equal(parseWithOrgMap(big).org_map.length, 30);
  assert.deepEqual(parseWithOrgMap(undefined).org_map, [], 'a response without org_map still parses (backward compatible)');
  assert.deepEqual(parseWithOrgMap('nope').org_map, []);
  assert.deepEqual(parseWithOrgMap(undefined).org_map_meta, { removed_unverified: 0, deduped: 0, auto_linked: 0 });
});

// ── Truth over completeness: person verification + provenance ────────
test('a person named only in the supplied evidence survives with app-computed provenance and freshness', () => {
  const out = parseWithOrgMap([
    { name: 'Priya Nair — CTO', status: 'engaged', depth: 0 },
  ], { anchors: EVIDENCE_ANCHORS });
  assert.equal(out.org_map.length, 1);
  assert.equal(out.org_map[0].person_source, 'evidence');
  assert.equal(out.org_map[0].corroborated, false);
  assert.equal(out.org_map[0].last_seen_date, '2026-06-02', 'the NEWEST sighting dates the node');
});

test('a saved contact also named in the evidence is corroborated across source types', () => {
  const out = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
  ], { anchors: EVIDENCE_ANCHORS });
  assert.equal(out.org_map[0].person_source, 'both');
  assert.equal(out.org_map[0].corroborated, true);
  assert.equal(out.org_map[0].last_seen_date, '2026-05-12');
  assert.equal(derivePartnerOrgStats(out.org_map).corroborated, 1);
});

test('name matching is diacritic- and word-order-insensitive but never invents a surname', () => {
  const out = parseWithOrgMap([
    { name: 'Bob Unger — Marketing Lead', status: 'introduced', depth: 0 },   // evidence spells him "Böb Ünger"
    { name: 'Nair, Priya — CTO', status: 'identified', depth: 0 },            // reversed word order
    { name: 'Priya Higgins — CTO', status: 'identified', depth: 0 },          // surname not in any source → removed
  ], { anchors: EVIDENCE_ANCHORS });
  assert.deepEqual(out.org_map.map(n => n.name), ['Bob Unger — Marketing Lead', 'Nair, Priya — CTO']);
  assert.equal(out.org_map_meta.removed_unverified, 1);
});

test('an unlinked node whose name exactly matches exactly one saved contact is auto-linked', () => {
  const out = parseWithOrgMap([
    { name: 'Amir Khan — Solutions Architect', status: 'introduced', depth: 0 },
  ]);
  assert.equal(out.org_map[0].contact_id, 'ct1', 'the Saved tag now reflects the real CRM record');
  assert.equal(out.org_map[0].person_source, 'roster');
  assert.equal(out.org_map_meta.auto_linked, 1);
});

test('one person can never occupy two boxes — duplicate ids and names collapse', () => {
  const out = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
    { name: 'Alvarez, Zoe', status: 'identified', depth: 1 },   // same person, reversed
    { name: 'Amir Khan — Solutions Architect', status: 'introduced', depth: 1, contact_id: 'ct1' },
    { name: 'Amir Khan', status: 'identified', depth: 1, contact_id: 'ct1' },  // duplicate id
  ]);
  assert.deepEqual(out.org_map.map(n => n.contact_id), ['ct2', 'ct1']);
  assert.equal(out.org_map_meta.deduped, 2);
});

// ── Person vs reporting line — scored separately ─────────────────────
test('a roster-only person can never carry an evidence-grade reporting line', () => {
  const out = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
    { name: 'Amir Khan — Solutions Architect', status: 'introduced', depth: 1, contact_id: 'ct1', line_confidence: 'explicit', line_basis: 'reports to Zoe' },
  ]);
  const amir = out.org_map[1];
  assert.equal(amir.line_confidence, 'inferred', 'the saved roster stores no reporting info — explicit/observed clamp to inferred');
  assert.equal(amir.line_basis, 'reports to Zoe', 'the basis stays visible so the reader can judge it');
});

test('an evidence-named person may keep an explicit line, and the rung canonicalizes', () => {
  const out = parseWithOrgMap([
    { name: 'Priya Nair — CTO', status: 'engaged', depth: 0, line_confidence: 'explicit', line_basis: 'is the CTO' },
    { name: 'Bob Unger — Marketing Lead', status: 'introduced', depth: 1, line_confidence: 'stated directly in the call', line_basis: 'Priya said the rollout team reports to her — 2026-05-12' },
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 1, contact_id: 'ct2', line_confidence: 'typical channel pattern' },
  ], { anchors: EVIDENCE_ANCHORS });
  assert.equal(out.org_map[0].line_confidence, '', 'a depth-0 root has no reporting line to rate');
  assert.equal(out.org_map[0].line_basis, '', 'and no basis either');
  assert.equal(out.org_map[1].line_confidence, 'explicit', 'free-text rungs canonicalize');
  assert.equal(out.org_map[2].line_confidence, 'scaffold', 'an analogous-structure claim stays visibly scaffold');
});

// ── Gaps are data (never guessed answers) ────────────────────────────
test('a "(not yet identified)" name is a gap regardless of the claimed status', () => {
  const out = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
    { name: 'CRO (not yet identified)', status: 'engaged', depth: 1, line_confidence: 'explicit' },
  ]);
  const gap = out.org_map[1];
  assert.equal(gap.status, 'missing', 'an unnamed role slot can never claim engagement');
  assert.equal(gap.person_source, 'gap');
  assert.equal(gap.line_confidence, 'scaffold', 'a gap’s line is shape only, whatever the model claimed');
});

test('a saved CRM record beats a "missing" claim — the primary source wins', () => {
  const out = parseWithOrgMap([
    { name: 'Amir Khan — Solutions Architect', status: 'missing', depth: 0, contact_id: 'ct1' },
  ]);
  assert.equal(out.org_map[0].status, 'identified', 'a person with a saved contact row is not an unfilled gap');
  assert.equal(out.org_map[0].person_source, 'roster');
});

test('the org chart never moves a maturity criterion or the completion %', () => {
  const out = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
  ]);
  assert.equal(out.completion.met, 0, 'a rich org chart with no scored criteria stays 0% complete');
  assert.ok(out.stages.every(s => s.criteria.every(c => c.status === 'no_evidence')));
});

// ── partner_contact as a structured source ───────────────────────────
function stakeholderClaim() {
  return [{
    stage_id: 'profile_fit',
    status: 'in_progress',
    criteria: [{
      criterion_id: 'key_stakeholders_identified', status: 'met',
      evidence: '', source_type: 'partner_contact', source_id: 'ct2', source_date: '',
      related_entity_id: '',
    }],
  }];
}

test('a key-stakeholders claim citing the saved roster survives when the roster was supplied', () => {
  const facts = buildPartnerCriteriaFacts({ partner: PARTNER, kpis: {}, contactRoster: rosterFor() });
  assert.equal(facts.structuredSupport.key_stakeholders_identified, true);
  const out = parseWithOrgMap([], { stages: stakeholderClaim(), facts });
  const crit = out.stages.find(s => s.stage_id === 'profile_fit').criteria.find(c => c.criterion_id === 'key_stakeholders_identified');
  assert.equal(crit.status, 'met');
  assert.equal(crit.source_type, 'partner_contact');
  assert.equal(crit.source_id, 'ct2', 'a real roster id is kept as the citation');
});

test('the same claim is downgraded to no_evidence when no roster backs it', () => {
  const facts = buildPartnerCriteriaFacts({ partner: PARTNER, kpis: {}, contactRoster: buildPartnerContactRoster([]) });
  assert.ok(!facts.structuredSupport.key_stakeholders_identified);
  const out = parseWithOrgMap([], { stages: stakeholderClaim(), facts });
  const crit = out.stages.find(s => s.stage_id === 'profile_fit').criteria.find(c => c.criterion_id === 'key_stakeholders_identified');
  assert.equal(crit.status, 'no_evidence');
  assert.equal(crit.source_type, 'none');
});

test('partner_contact is a registered source type', () => {
  assert.ok(VALID_SOURCE_TYPES.has('partner_contact'));
});

// ── Shared tree/stat derivations (view + PDF) ────────────────────────
test('buildOrgChartTree nests by depth, allows multiple roots, and never skips a level', () => {
  const tree = buildOrgChartTree([
    { name: 'CEO', status: 'identified', depth: 0 },
    { name: 'VP Sales', status: 'engaged', depth: 1 },
    { name: 'AE', status: 'engaged', depth: 2 },
    { name: 'SE Lead', status: 'introduced', depth: 5 },  // skip-level → clamps to a child of AE
    { name: 'VP Product', status: 'identified', depth: 1 },
    { name: 'Advisor', status: 'identified', depth: 0 },  // a second root
  ]);
  assert.equal(tree.length, 2, 'two depth-0 roots');
  const ceo = tree[0];
  assert.equal(ceo.children.length, 2, 'VP Sales + VP Product under the CEO');
  const ae = ceo.children[0].children[0];
  assert.equal(ae.node.name, 'AE');
  assert.equal(ae.children.length, 1, 'the depth-5 row normalizes to one level below AE');
  assert.equal(ae.children[0].node.name, 'SE Lead');
  assert.equal(tree[1].node.name, 'Advisor');
});

test('a first row deeper than 0 still roots the tree instead of being lost', () => {
  const tree = buildOrgChartTree([{ name: 'Only Person', status: 'engaged', depth: 3 }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].node.name, 'Only Person');
});

test('derivePartnerOrgStats counts statuses, saved contacts and corroborated people', () => {
  const stats = derivePartnerOrgStats([
    { name: 'A', status: 'engaged', depth: 0, contact_id: 'ct1', person_source: 'both', corroborated: true },
    { name: 'B', status: 'engaged', depth: 1, contact_id: '' },
    { name: 'C', status: 'introduced', depth: 1, contact_id: 'ct2' },
    { name: 'D', status: 'identified', depth: 1, contact_id: '' },
    { name: 'E', status: 'missing', depth: 1, contact_id: '' },
  ]);
  assert.deepEqual(stats, { total: 5, engaged: 2, introduced: 1, identified: 1, missing: 1, saved: 2, corroborated: 1 });
  assert.deepEqual(derivePartnerOrgStats([]), { total: 0, engaged: 0, introduced: 0, identified: 0, missing: 0, saved: 0, corroborated: 0 });
});

// ── preparePartnerAnalysis wiring (pure) ─────────────────────────────
function prepArgs(extra = {}) {
  return {
    partner: PARTNER,
    transcripts: [], meetings: [], documents: [],
    opportunities: [], opportunityDescriptions: [],
    events: [], eventDescriptions: [], eventContacts: [],
    partnerContacts: PARTNER_CONTACTS,
    savedPlaybookRows: [], today: TODAY,
    ...extra,
  };
}

test('preparePartnerAnalysis scopes the roster, anchors its ids, and flags stakeholder support', () => {
  const prep = preparePartnerAnalysis(prepArgs());
  assert.equal(prep.contactRoster.total, 2);
  assert.deepEqual([...prep.anchors.contactIds].sort(), ['ct1', 'ct2']);
  assert.ok(prep.anchors.structuredIds.has('ct1'), 'roster ids are citable structured ids');
  assert.ok(!prep.anchors.contactIds.has('ct9'), 'another partner’s contact id is never anchored');
  assert.equal(prep.facts.structuredSupport.key_stakeholders_identified, true);
  assert.ok(prep.scoped.partnerContacts.every(c => c.partner_id === 'p1'));
});

test('anchors carry the roster names (names only) so the validator can verify/auto-link people', () => {
  const prep = preparePartnerAnalysis(prepArgs());
  assert.equal(prep.anchors.contactNamesById.get('ct1'), 'Amir Khan');
  assert.equal(prep.anchors.contactNamesById.get('ct2'), 'Zoe Alvarez');
  assert.ok(!prep.anchors.contactNamesById.has('ct9'), 'another partner’s contact never enters the anchors');
  for (const name of prep.anchors.contactNamesById.values()) {
    assert.ok(!String(name).includes('@'), 'names only — never an email');
  }
});

test('without Partner_Contacts rows nothing changes: empty roster, no stakeholder support from it', () => {
  const prep = preparePartnerAnalysis(prepArgs({ partnerContacts: [] }));
  assert.equal(prep.contactRoster.total, 0);
  assert.equal(prep.anchors.contactIds.size, 0);
  assert.ok(!prep.facts.structuredSupport.key_stakeholders_identified);
});

// ── End-to-end client flow (stubbed fetch) ───────────────────────────
const REAL_FETCH = globalThis.fetch;
function stubModel(obj) { globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) }); }
function restoreFetch() { globalThis.fetch = REAL_FETCH; }
function setApiKey() { globalThis.localStorage.setItem('pp_runtime_config', JSON.stringify({ ANTHROPIC_API_KEY: 'test-key' })); }

test('requestPartnerAnalysisJson returns a validated org chart (fabrications stripped end-to-end)', async () => {
  setApiKey();
  stubModel({
    partner_id: 'p1', partner_name: 'Nerdio', confidence: 'low', summary: 'Early.',
    stages: [], next_actions: [], gaps: [], open_questions: [], risks: [], momentum: [],
    org_map: [
      { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
      { name: 'Amir Khan — Solutions Architect', status: 'introduced', depth: 1, contact_id: 'ct1', line_confidence: 'explicit', line_basis: 'reports to Zoe' },
      { name: 'CTO (not yet identified)', status: 'missing', depth: 1, contact_id: 'ct_fake' },
      { name: 'Taylor Made — CRO', status: 'identified', depth: 1 },  // invented — in no roster row and no evidence
    ],
  });
  try {
    const { analysis } = await requestPartnerAnalysisJson(prepArgs());
    assert.equal(analysis.org_map.length, 3, 'the invented person is removed end-to-end');
    assert.equal(analysis.org_map[0].contact_id, 'ct2');
    assert.equal(analysis.org_map[1].contact_id, 'ct1');
    assert.equal(analysis.org_map[1].line_confidence, 'inferred',
      'no evidence was supplied, so a roster-only "explicit" line clamps end-to-end');
    assert.equal(analysis.org_map[2].contact_id, '', 'fabricated id stripped end-to-end');
    assert.equal(analysis.org_map[2].line_confidence, 'scaffold');
    assert.equal(analysis.org_map_meta.removed_unverified, 1, 'the removal is reported to the UI');
    const stats = derivePartnerOrgStats(analysis.org_map);
    assert.deepEqual({ saved: stats.saved, missing: stats.missing }, { saved: 2, missing: 1 });
  } finally {
    restoreFetch();
  }
});

// ── PDF org-chart section ────────────────────────────────────────────
function installJsPdfShim() {
  const calls = [];
  function Shim() {
    this._pages = 1;
    this.internal = { getNumberOfPages: () => this._pages };
    for (const op of ['setFillColor', 'setDrawColor', 'setTextColor', 'setFont', 'setFontSize', 'setLineWidth', 'rect', 'roundedRect', 'circle', 'line']) {
      this[op] = (...a) => calls.push({ op, a });
    }
    this.text = (...a) => calls.push({ op: 'text', a });
    this.addPage = () => { this._pages += 1; calls.push({ op: 'addPage' }); };
    this.setPage = (p) => calls.push({ op: 'setPage', a: [p] });
    this.splitTextToSize = (text) => [String(text == null ? '' : text)];
    this.output = () => ({ _isBlob: true, __calls: calls });
  }
  globalThis.window = globalThis.window || {};
  globalThis.window.jspdf = { jsPDF: Shim };
  return calls;
}
function textStrings(calls) {
  return calls.filter(c => c.op === 'text').map(c => (Array.isArray(c.a?.[0]) ? c.a[0].join(' ') : String(c.a?.[0] ?? '')));
}

test('the partner PDF renders the org chart section with statuses and the SAVED tag', async () => {
  const calls = installJsPdfShim();
  const analysis = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
    { name: 'CTO (not yet identified)', status: 'missing', depth: 1 },
  ]);
  await buildPartnerAnalysisPdf({ analysis, partner: PARTNER, kpis: {} });
  const texts = textStrings(calls);
  assert.ok(texts.some(t => /LIKELY ORG CHART/i.test(t)), 'org chart heading drawn');
  assert.ok(texts.some(t => /not an official org chart/i.test(t)), 'disclaimer drawn');
  assert.ok(texts.some(t => t.includes('Zoe Alvarez — VP Alliances')));
  assert.ok(texts.some(t => t === 'ENGAGED · SAVED'), 'saved node tag drawn');
  assert.ok(texts.some(t => t === 'MISSING'), 'missing node tag drawn');
});

test('the PDF carries per-node provenance: corroboration, evidence sightings and line rungs', async () => {
  const calls = installJsPdfShim();
  const analysis = parseWithOrgMap([
    { name: 'Zoe Alvarez — VP Alliances', status: 'engaged', depth: 0, contact_id: 'ct2' },
    { name: 'Bob Unger — Marketing Lead', status: 'introduced', depth: 1, line_confidence: 'observed', line_basis: 'cc’d for sign-off' },
    { name: 'Invented Person — COO', status: 'identified', depth: 1 },
  ], { anchors: EVIDENCE_ANCHORS });
  await buildPartnerAnalysisPdf({ analysis, partner: PARTNER, kpis: {} });
  const texts = textStrings(calls);
  assert.ok(texts.some(t => t === 'ENGAGED · SAVED · CORROBORATED'), 'roster+evidence person tagged corroborated');
  assert.ok(texts.some(t => t === 'INTRODUCED · IN EVIDENCE · LINE OBSERVED'), 'evidence person carries its line rung');
  assert.ok(texts.some(t => /last seen 2026-05-12/.test(t)), 'freshness drawn');
  assert.ok(texts.some(t => /1 unverifiable name was removed/.test(t)), 'the removal is stated in the PDF too');
  assert.ok(!texts.some(t => t.includes('Invented Person')), 'the invented person never reaches the PDF');
});

test('a PDF for an analysis without an org chart simply omits the section', async () => {
  const calls = installJsPdfShim();
  const analysis = parseWithOrgMap([]);
  await buildPartnerAnalysisPdf({ analysis, partner: PARTNER, kpis: {} });
  assert.ok(!textStrings(calls).some(t => /LIKELY ORG CHART/i.test(t)));
});
