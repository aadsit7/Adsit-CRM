// Tests for the Partner Contacts module (js/utils/partner-contacts.js).
// The accuracy contract is the point of this feature, so most tests are
// adversarial: hallucinated people, invented emails, paraphrased titles and
// cross-person name stitching must all be rejected, while verbatim data —
// including reordered "Last, First" names and diacritic variants — survives.
import './_setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PARTNER_CONTACT_HEADERS,
  CONTACT_SOURCE_LIMITS,
  nameFoundInText, emailFoundInText, phoneFoundInText, fieldFoundInText,
  collectPartnerContactSources,
  buildPartnerContactsPrompt,
  parsePartnerContactsResponse,
  attendeeContactsToExtracted,
  parseSourcesJson,
  partnerContactRowValues,
  partnerContactFromRow,
  mergeExtractedContacts,
  sortContactsForDisplay,
} from '../js/utils/partner-contacts.js';

// ── Fixtures ─────────────────────────────────────────────────────────
const TRANSCRIPTS = [
  {
    transcript_id: 't1', partner_id: 'p1', conversation_date: '2026-06-10',
    transcript_text: '<p>Call with <b>Jane Doe</b> (Director of IT at Acme Corp). '
      + 'Follow up via jane.doe@acme.com or (555) 123-4567. '
      + 'Miguel Ángel will own the technical track.</p>',
  },
  {
    transcript_id: 't2', partner_id: 'p1', conversation_date: '2026-05-01',
    transcript_text: '<p>Attendees: Smith, John — VP of Sales. Kickoff recap.</p>',
  },
  { transcript_id: 't9', partner_id: 'p2', conversation_date: '2026-06-01', transcript_text: '<p>Zoe Zhang of OtherCo.</p>' },
  { transcript_id: 't3', partner_id: 'p1', conversation_date: '2026-04-01', transcript_text: '   ' },
];

const MEETINGS = [
  {
    meeting_id: 'm1', partner_id: 'p1', meeting_date: '2026-06-20', meeting_title: 'QBR',
    attendees: 'Jane Doe; Raj Patel', summary: 'Reviewed pipeline with Raj Patel.',
  },
  { meeting_id: 'm9', partner_id: 'p2', meeting_date: '2026-06-01', attendees: 'Someone Else' },
];

const DOCUMENTS = [
  {
    document_id: 'd1', partner_id: 'p1', title: 'GTM Plan', created_at: '2026-06-05',
    html_content: '<p>Owner on the partner side: Priya Nair (priya@partner.io).</p>',
  },
  { document_id: 'd9', partner_id: 'p2', title: 'Other', html_content: '<p>Bob Only</p>' },
];

function p1Sources() {
  return collectPartnerContactSources({
    partnerId: 'p1', transcripts: TRANSCRIPTS, meetings: MEETINGS, documents: DOCUMENTS,
  }).sources;
}

// ── Verbatim matching primitives ─────────────────────────────────────
test('nameFoundInText: exact, reordered, diacritics, and boundaries', () => {
  const text = 'Met with John Smith about AVD.';
  assert.equal(nameFoundInText('John Smith', text), true);
  assert.equal(nameFoundInText('John Smith', 'Attendees: Smith, John (Acme)'), true);
  assert.equal(nameFoundInText('Jose Alvarez', 'Call with José Álvarez re pricing'), true);
  assert.equal(nameFoundInText('José Álvarez', 'Call with Jose Alvarez re pricing'), true);
  // Single-word names require the exact bounded phrase.
  assert.equal(nameFoundInText('Ann', 'Annette joined the call'), false);
  assert.equal(nameFoundInText('Ann', 'Ann joined the call'), true);
});

test('nameFoundInText: never stitches a name from two different people', () => {
  const far = 'John Adams opened the call. ' + 'x'.repeat(150) + ' Later Sarah Smith closed it.';
  assert.equal(nameFoundInText('John Smith', far), false);
});

test('emailFoundInText: exact only, no partial-token matches', () => {
  assert.equal(emailFoundInText('jane@acme.com', 'reach jane@acme.com today'), true);
  assert.equal(emailFoundInText('an@b.co', 'email ryan@b.com now'), false);
  assert.equal(emailFoundInText('jane@acme.com', 'no emails here'), false);
});

test('phoneFoundInText: complete-number match, 7-digit minimum', () => {
  assert.equal(phoneFoundInText('(555) 123-4567', 'call 555.123.4567 x89'), true);
  assert.equal(phoneFoundInText('555 123 4567', 'call 555-123-4567'), true);
  // A truncated number is a wrong value, not a verified one.
  assert.equal(phoneFoundInText('555-1234', 'call 555.123.4567'), false);
  assert.equal(phoneFoundInText('123456', '123456'), false); // too short to verify
  // Country-prefixed source still verifies the national form.
  assert.equal(phoneFoundInText('(555) 123-4567', 'reach him at +1 555 123 4567'), true);
  // A date glued to a phone by a space must not hide the phone.
  assert.equal(phoneFoundInText('555-123-4567', 'met 2026-06-10 555-123-4567'), true);
  // Digits stitched from unrelated groups never verify.
  assert.equal(phoneFoundInText('555-1234567', 'over 555 people, 1234567 units'), false);
});

test('fieldFoundInText: verbatim phrase only — paraphrases fail', () => {
  const text = 'She is Director of IT at Acme Corp.';
  assert.equal(fieldFoundInText('Director of IT', text), true);
  assert.equal(fieldFoundInText('IT Director', text), false);
  assert.equal(fieldFoundInText('Acme', 'Acmex Industries'), false);
});

// ── Source collection ────────────────────────────────────────────────
test('collectPartnerContactSources: strict partner scoping and HTML stripping', () => {
  const { sources, coverage } = collectPartnerContactSources({
    partnerId: 'p1', transcripts: TRANSCRIPTS, meetings: MEETINGS, documents: DOCUMENTS,
  });
  const ids = sources.map(s => s.source_id);
  assert.deepEqual(new Set(ids), new Set(['t1', 't2', 'm1', 'd1']));
  // Other partners' rows never leak in.
  const allText = sources.map(s => s.text).join(' ');
  assert.ok(!allText.includes('Zoe Zhang'));
  assert.ok(!allText.includes('Someone Else'));
  assert.ok(!allText.includes('Bob Only'));
  // HTML is stripped to prose.
  const t1 = sources.find(s => s.source_id === 't1');
  assert.ok(!t1.text.includes('<p>'));
  assert.ok(t1.text.includes('Jane Doe'));
  // Empty transcript (t3) is skipped but still counted as not included.
  assert.equal(coverage.included.descriptions, 2);
  assert.equal(coverage.truncatedItems, 0);
  // Meeting text carries the attendee fields.
  const m1 = sources.find(s => s.source_id === 'm1');
  assert.ok(m1.text.includes('Attendees: Jane Doe; Raj Patel'));
  assert.equal(m1.source_type, 'meeting');
});

test('collectPartnerContactSources: truncation is labelled and counted', () => {
  const { sources, coverage } = collectPartnerContactSources({
    partnerId: 'p1',
    transcripts: [{ transcript_id: 'tL', partner_id: 'p1', conversation_date: '2026-01-01', transcript_text: 'A'.repeat(9000) }],
    meetings: [], documents: [],
  }, { charsPerItem: 100 });
  assert.equal(coverage.truncatedItems, 1);
  assert.ok(sources[0].text.endsWith('…[truncated]'));
});

// ── Prompt ───────────────────────────────────────────────────────────
test('buildPartnerContactsPrompt: carries rules, sources and partner name', () => {
  const prompt = buildPartnerContactsPrompt({ partnerName: 'Nerdio', sources: p1Sources(), today: '2026-07-22' });
  assert.ok(prompt.includes('PARTNER: Nerdio'));
  assert.ok(prompt.includes('TODAY: 2026-07-22'));
  assert.ok(prompt.includes('GOLDEN RULE'));
  assert.ok(prompt.includes('COPIED EXACTLY'));
  assert.ok(prompt.includes('[src id=t1'));
  assert.ok(prompt.includes('Jane Doe'));
  assert.ok(prompt.includes('STRICT JSON only'));
});

// ── Parser / validator ───────────────────────────────────────────────
function respond(payload) { return JSON.stringify(payload); }

test('parse: verbatim contact survives with all grounded fields', () => {
  const { contacts, dropped } = parsePartnerContactsResponse(respond({
    contacts: [{
      name: 'Jane Doe', role: 'Director of IT', company: 'Acme Corp',
      email: 'jane.doe@acme.com', phone: '(555) 123-4567',
      source_ids: ['t1', 'm1'], context: 'Call with Jane Doe',
    }],
    note: '',
  }), { sources: p1Sources() });

  assert.equal(dropped.length, 0);
  assert.equal(contacts.length, 1);
  const c = contacts[0];
  assert.equal(c.name, 'Jane Doe');
  assert.equal(c.role, 'Director of IT');
  assert.equal(c.company, 'Acme Corp');
  assert.equal(c.email, 'jane.doe@acme.com');
  assert.equal(c.phone, '(555) 123-4567');
  assert.equal(c.evidence, 'Call with Jane Doe');
  assert.deepEqual(c.sources.map(s => s.id).sort(), ['m1', 't1']);
  assert.equal(c.sources.find(s => s.id === 't1').type, 'description');
});

test('parse: hallucinated person is dropped and reported', () => {
  const { contacts, dropped } = parsePartnerContactsResponse(respond({
    contacts: [{ name: 'Carlos Rivera', role: '', company: '', email: '', phone: '', source_ids: ['t1'], context: '' }],
    note: '',
  }), { sources: p1Sources() });
  assert.equal(contacts.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, 'Carlos Rivera');
});

test('parse: invented email/phone/role/company are blanked, not kept', () => {
  const { contacts } = parsePartnerContactsResponse(respond({
    contacts: [{
      name: 'Jane Doe',
      role: 'Chief Executive Officer',      // not in any source
      company: 'Globex',                    // not in any source
      email: 'jane@globex.com',             // not in any source
      phone: '999-888-7777',                // not in any source
      source_ids: ['t1'],
      context: 'not actually in the source text at all',
    }],
    note: '',
  }), { sources: p1Sources() });
  const c = contacts[0];
  assert.equal(c.name, 'Jane Doe');
  assert.equal(c.role, '');
  assert.equal(c.company, '');
  assert.equal(c.email, '');
  assert.equal(c.phone, '');
  assert.equal(c.evidence, '');
});

test('parse: unknown source ids are ignored; contact with none left is dropped', () => {
  const { contacts, dropped } = parsePartnerContactsResponse(respond({
    contacts: [
      { name: 'Jane Doe', role: '', company: '', email: '', phone: '', source_ids: ['t9', 'bogus', 't1'], context: '' },
      { name: 'Priya Nair', role: '', company: '', email: '', phone: '', source_ids: ['bogus'], context: '' },
    ],
    note: '',
  }), { sources: p1Sources() });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, 'Jane Doe');
  // Only the real, containing source survives as provenance.
  assert.deepEqual(contacts[0].sources.map(s => s.id), ['t1']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, 'Priya Nair');
});

test('parse: cited source that does not contain the person is dropped from provenance', () => {
  const { contacts } = parsePartnerContactsResponse(respond({
    contacts: [{ name: 'Raj Patel', role: '', company: '', email: '', phone: '', source_ids: ['m1', 't1'], context: '' }],
    note: '',
  }), { sources: p1Sources() });
  // Raj Patel appears in m1 but not t1.
  assert.deepEqual(contacts[0].sources.map(s => s.id), ['m1']);
});

test('parse: reordered "Last, First" mention verifies; single-word name needs exact phrase', () => {
  const { contacts } = parsePartnerContactsResponse(respond({
    contacts: [
      { name: 'John Smith', role: 'VP of Sales', company: '', email: '', phone: '', source_ids: ['t2'], context: '' },
      { name: 'Smith', role: '', company: '', email: '', phone: '', source_ids: ['t2'], context: '' },
    ],
    note: '',
  }), { sources: p1Sources() });
  assert.deepEqual(contacts.map(c => c.name).sort(), ['John Smith', 'Smith']);
  assert.equal(contacts.find(c => c.name === 'John Smith').role, 'VP of Sales');
});

test('parse: markdown fences and placeholder values are tolerated', () => {
  const raw = '```json\n' + respond({
    contacts: [{ name: 'Jane Doe', role: 'Not specified', company: 'N/A', email: '', phone: '', source_ids: ['t1'], context: '' }],
    note: 'ok',
  }) + '\n```';
  const { contacts, note } = parsePartnerContactsResponse(raw, { sources: p1Sources() });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].role, '');
  assert.equal(contacts[0].company, '');
  assert.equal(note, 'ok');
});

test('parse: duplicate proposals collapse into one contact with unioned sources', () => {
  // The second mention lost its email during grounding (m1 carries no
  // email), so it must fold into the first by name — never a second row.
  const { contacts } = parsePartnerContactsResponse(respond({
    contacts: [
      { name: 'Jane Doe', role: 'Director of IT', company: '', email: 'jane.doe@acme.com', phone: '', source_ids: ['t1'], context: '' },
      { name: 'Jane Doe', role: '', company: '', email: 'jane.doe@acme.com', phone: '', source_ids: ['m1'], context: '' },
    ],
    note: '',
  }), { sources: p1Sources() });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].role, 'Director of IT');
  assert.deepEqual(contacts[0].sources.map(s => s.id).sort(), ['m1', 't1']);
});

test('parse: same name with two different grounded emails stays two contacts', () => {
  const sources = [
    { source_id: 's1', source_type: 'description', label: 'Description', date: '2026-06-01', text: 'Alex Kim <alex.kim@acme.com> joined.' },
    { source_id: 's2', source_type: 'description', label: 'Description', date: '2026-06-02', text: 'Alex Kim (alex@othercorp.com) also attended.' },
  ];
  const { contacts } = parsePartnerContactsResponse(respond({
    contacts: [
      { name: 'Alex Kim', role: '', company: '', email: 'alex.kim@acme.com', phone: '', source_ids: ['s1'], context: '' },
      { name: 'Alex Kim', role: '', company: '', email: 'alex@othercorp.com', phone: '', source_ids: ['s2'], context: '' },
    ],
    note: '',
  }), { sources });
  assert.equal(contacts.length, 2);
});

test('parse: malformed payloads throw coded errors', () => {
  assert.throws(() => parsePartnerContactsResponse('', { sources: [] }), /PARTNER_CONTACTS_EMPTY|empty/i);
  assert.throws(() => parsePartnerContactsResponse('not json at all', { sources: [] }), (e) => e.code === 'PARTNER_CONTACTS_INVALID');
});

// ── Attachment (attendee pipeline) mapping ───────────────────────────
test('attendeeContactsToExtracted: normalizes placeholders and attaches provenance', () => {
  const out = attendeeContactsToExtracted([
    { name: 'Ana Lima', company: 'Acme Corp', email: 'ana@acme.com', role: 'Not specified' },
    { name: 'Not specified', company: 'X', email: 'Not specified', role: 'Y' }, // no identity → skipped
    { name: '', company: '', email: 'ops@partner.io', role: '' },               // email-only kept
    { name: 'Ana Lima', company: '', email: 'ana@acme.com', role: 'CTO' },      // dupe merges
  ], { docId: 'doc_1', fileName: 'attendees.xlsx', date: '2026-07-22' });

  assert.equal(out.length, 2);
  const ana = out.find(c => c.name === 'Ana Lima');
  assert.equal(ana.role, 'CTO');
  assert.equal(ana.company, 'Acme Corp');
  assert.deepEqual(ana.sources, [{ type: 'attachment', id: 'doc_1', label: 'attendees.xlsx', date: '2026-07-22' }]);
  const emailOnly = out.find(c => !c.name);
  assert.equal(emailOnly.email, 'ops@partner.io');
});

// ── Row (de)serialization ────────────────────────────────────────────
test('row values round-trip through the sheet header contract', () => {
  const contact = {
    contact_id: 'pct_1', partner_id: 'p1', partner_name: 'Nerdio',
    name: 'Jane Doe', role: 'Director of IT', company: 'Acme Corp',
    email: 'jane.doe@acme.com', phone: '555', evidence: 'Call with Jane Doe',
    sources: [{ type: 'description', id: 't1', label: 'Description', date: '2026-06-10' }],
    first_seen: '2026-06-10', last_seen: '2026-06-10',
    created_at: '2026-07-22T00:00:00Z', updated_at: '2026-07-22T00:00:00Z',
  };
  const values = partnerContactRowValues(contact);
  assert.equal(values.length, PARTNER_CONTACT_HEADERS.length);

  const row = { _rowIndex: 5 };
  PARTNER_CONTACT_HEADERS.forEach((h, i) => { row[h] = values[i]; });
  const back = partnerContactFromRow(row);
  assert.equal(back._rowIndex, 5);
  assert.equal(back.name, 'Jane Doe');
  assert.deepEqual(back.sources, contact.sources);
});

test('parseSourcesJson: tolerant of junk', () => {
  assert.deepEqual(parseSourcesJson(''), []);
  assert.deepEqual(parseSourcesJson('{broken'), []);
  assert.deepEqual(parseSourcesJson('"a string"'), []);
  assert.equal(parseSourcesJson('[{"type":"manual","id":"","label":"Added manually","date":"2026-07-22"}]').length, 1);
});

// ── Merge ────────────────────────────────────────────────────────────
function existingRow(overrides = {}) {
  return {
    _rowIndex: 2, contact_id: 'pct_ex1', partner_id: 'p1', partner_name: 'Nerdio',
    name: 'Jane Doe', role: '', company: 'Acme Corp', email: 'jane.doe@acme.com', phone: '',
    evidence: '', sources: [{ type: 'attachment', id: 'doc_1', label: 'attendees.xlsx', date: '2026-06-01' }],
    first_seen: '2026-06-01', last_seen: '2026-06-01',
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

test('merge: new person becomes a new row with ids and seen dates', () => {
  let n = 0;
  const { toAppend, toUpdate, added, updated } = mergeExtractedContacts({
    existing: [],
    extracted: [{
      name: 'Raj Patel', role: '', company: '', email: '', phone: '', evidence: '',
      sources: [{ type: 'meeting', id: 'm1', label: 'QBR', date: '2026-06-20' }],
    }],
    partnerId: 'p1', partnerName: 'Nerdio', nowIso: '2026-07-22T10:00:00Z',
    makeId: () => `id_${++n}`,
  });
  assert.equal(added, 1);
  assert.equal(updated, 0);
  assert.equal(toUpdate.length, 0);
  const c = toAppend[0];
  assert.equal(c.contact_id, 'id_1');
  assert.equal(c.partner_id, 'p1');
  assert.equal(c.first_seen, '2026-06-20');
  assert.equal(c.last_seen, '2026-06-20');
  assert.equal(c.created_at, '2026-07-22T10:00:00Z');
});

test('merge: email match fills blanks only — saved values are never overwritten', () => {
  const existing = [existingRow()];
  const { toAppend, toUpdate } = mergeExtractedContacts({
    existing,
    extracted: [{
      name: 'Jane A. Doe',                  // different form — must NOT overwrite
      role: 'Director of IT',               // blank on existing — fills
      company: 'Different Corp',            // saved value — must NOT overwrite
      email: 'jane.doe@acme.com',
      phone: '555-123-4567',                // blank — fills
      evidence: 'Call with Jane Doe',
      sources: [{ type: 'description', id: 't1', label: 'Description', date: '2026-06-10' }],
    }],
    partnerId: 'p1', partnerName: 'Nerdio', nowIso: '2026-07-22T10:00:00Z',
  });
  assert.equal(toAppend.length, 0);
  assert.equal(toUpdate.length, 1);
  const u = toUpdate[0];
  assert.equal(u._rowIndex, 2);
  assert.equal(u.name, 'Jane Doe');
  assert.equal(u.company, 'Acme Corp');
  assert.equal(u.role, 'Director of IT');
  assert.equal(u.phone, '555-123-4567');
  assert.equal(u.evidence, 'Call with Jane Doe');
  assert.deepEqual(u.sources.map(s => s.id).sort(), ['doc_1', 't1']);
  assert.equal(u.first_seen, '2026-06-01');
  assert.equal(u.last_seen, '2026-06-10');
  assert.equal(u.updated_at, '2026-07-22T10:00:00Z');
});

test('merge: name match links a no-email row and gains the email', () => {
  const existing = [existingRow({ email: '', sources: [], first_seen: '', last_seen: '' })];
  const { toAppend, toUpdate } = mergeExtractedContacts({
    existing,
    extracted: [{
      name: 'Jane Doe', role: '', company: '', email: 'jane.doe@acme.com', phone: '', evidence: '',
      sources: [{ type: 'description', id: 't1', label: 'Description', date: '2026-06-10' }],
    }],
    partnerId: 'p1', partnerName: 'Nerdio', nowIso: '2026-07-22T10:00:00Z',
  });
  assert.equal(toAppend.length, 0);
  assert.equal(toUpdate[0].email, 'jane.doe@acme.com');
});

test('merge: identical re-scan is a no-op (idempotent)', () => {
  const existing = [existingRow({ role: 'Director of IT' })];
  const { toAppend, toUpdate, unchanged } = mergeExtractedContacts({
    existing,
    extracted: [{
      name: 'Jane Doe', role: 'Director of IT', company: 'Acme Corp',
      email: 'jane.doe@acme.com', phone: '', evidence: '',
      sources: [{ type: 'attachment', id: 'doc_1', label: 'attendees.xlsx', date: '2026-06-01' }],
    }],
    partnerId: 'p1', partnerName: 'Nerdio', nowIso: '2026-07-22T10:00:00Z',
  });
  assert.equal(toAppend.length, 0);
  assert.equal(toUpdate.length, 0);
  assert.equal(unchanged, 1);
});

test('merge: same name with a different saved email stays a separate row', () => {
  const existing = [existingRow()]; // Jane Doe, jane.doe@acme.com
  const { toAppend, toUpdate } = mergeExtractedContacts({
    existing,
    extracted: [{
      name: 'Jane Doe', role: '', company: '', email: 'jane@elsewhere.org', phone: '', evidence: '',
      sources: [{ type: 'description', id: 't1', label: 'Description', date: '2026-06-10' }],
    }],
    partnerId: 'p1', partnerName: 'Nerdio', nowIso: '2026-07-22T10:00:00Z',
  });
  assert.equal(toUpdate.length, 0);
  assert.equal(toAppend.length, 1);
  assert.equal(toAppend[0].email, 'jane@elsewhere.org');
});

test('merge: two extracted mentions of the same new person collapse into one row', () => {
  const { toAppend } = mergeExtractedContacts({
    existing: [],
    extracted: [
      { name: 'Priya Nair', role: '', company: '', email: 'priya@partner.io', phone: '', evidence: '', sources: [{ type: 'partner_document', id: 'd1', label: 'GTM Plan', date: '2026-06-05' }] },
      { name: 'Priya Nair', role: '', company: '', email: '', phone: '', evidence: '', sources: [{ type: 'meeting', id: 'm1', label: 'QBR', date: '2026-06-20' }] },
    ],
    partnerId: 'p1', partnerName: 'Nerdio', nowIso: '2026-07-22T10:00:00Z',
  });
  assert.equal(toAppend.length, 1);
  assert.deepEqual(toAppend[0].sources.map(s => s.id).sort(), ['d1', 'm1']);
  assert.equal(toAppend[0].last_seen, '2026-06-20');
});

// ── Display sort ─────────────────────────────────────────────────────
test('sortContactsForDisplay: A→Z, nameless rows last', () => {
  const sorted = sortContactsForDisplay([
    { name: '', email: 'z@x.com' },
    { name: 'Zoe' },
    { name: 'ana' },
  ]);
  assert.deepEqual(sorted.map(c => c.name), ['ana', 'Zoe', '']);
});

test('source limits are sane', () => {
  assert.ok(CONTACT_SOURCE_LIMITS.totalChars >= 50_000);
  assert.ok(CONTACT_SOURCE_LIMITS.charsPerItem >= 1000);
});
