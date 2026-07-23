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
  CRM_OWNER_COMPANY,
  nameFoundInText, emailFoundInText, phoneFoundInText, fieldFoundInText,
  nameFoundInTextFuzzy, namesLikelySamePerson, companyMatchesPartner,
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

// ── Similar-name reasoning ───────────────────────────────────────────
test('namesLikelySamePerson: variants, subsets and initials link; different people never do', () => {
  // The screenshot bugs: a bare first name and the full name are one person.
  assert.equal(namesLikelySamePerson('Aaron', 'Aaron Adsit'), true);
  assert.equal(namesLikelySamePerson('Aaron Adsit', 'Aaron'), true);
  // One-character typo/plural surname ("Jack Smith" vs "Jack Smiths").
  assert.equal(namesLikelySamePerson('Jack Smith', 'Jack Smiths'), true);
  assert.equal(namesLikelySamePerson('Jon Smith', 'John Smith'), true);
  // Reordered and initialed forms.
  assert.equal(namesLikelySamePerson('Smith, Jack', 'Jack Smiths'), true);
  assert.equal(namesLikelySamePerson('J. Smith', 'Jack Smith'), true);
  // Substitutions are NOT typos — different humans stay separate.
  assert.equal(namesLikelySamePerson('Mark Smith', 'Mary Smith'), false);
  assert.equal(namesLikelySamePerson('Dan Brown', 'Don Brown'), false);
  // Different surnames never link, and initials alone are never enough.
  assert.equal(namesLikelySamePerson('John Smith', 'John Carter'), false);
  assert.equal(namesLikelySamePerson('J. S.', 'Jack Smith'), false);
  // Short tokens don't get fuzzy tolerance; empty names never match.
  assert.equal(namesLikelySamePerson('Ann', 'Annette Chu'), false);
  assert.equal(namesLikelySamePerson('', 'Jack Smith'), false);
});

test('nameFoundInTextFuzzy: one-character spelling variants verify, stitching still fails', () => {
  assert.equal(nameFoundInTextFuzzy('Jack Smith', 'Kickoff run by Jack Smiths yesterday'), true);
  assert.equal(nameFoundInTextFuzzy('John Smith', 'Attendees: Jon Smith (SE)'), true);
  // Words far apart never assemble into a person.
  const far = 'Jack Adams opened. ' + 'x'.repeat(150) + ' Later Sarah Smiths closed.';
  assert.equal(nameFoundInTextFuzzy('Jack Smith', far), false);
  // Single-word names still require the exact phrase.
  assert.equal(nameFoundInTextFuzzy('Smith', 'Jack Smiths presented'), false);
  assert.equal(nameFoundInTextFuzzy('Mark Smith', 'Mary Smith presented'), false);
});

// ── Company ↔ partner matching ───────────────────────────────────────
test('companyMatchesPartner: case, punctuation, legal suffixes and short forms', () => {
  assert.equal(companyMatchesPartner('Insight Enterprises, Inc.', 'Insight'), true);
  assert.equal(companyMatchesPartner('insight', 'INSIGHT'), true);
  assert.equal(companyMatchesPartner('SHI', 'SHI International Corp'), true);
  assert.equal(companyMatchesPartner('CDW Canada', 'CDW'), true);
  assert.equal(companyMatchesPartner('Recast Software', 'Insight'), false);
  assert.equal(companyMatchesPartner('Acme', 'Acmex'), false);
  assert.equal(companyMatchesPartner('', 'Insight'), false);
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

test('buildPartnerContactsPrompt: affiliation and same-person rules are spelled out', () => {
  const prompt = buildPartnerContactsPrompt({ partnerName: 'Insight', sources: p1Sources(), today: '2026-07-22' });
  assert.ok(prompt.includes('PARTNER-SIDE PEOPLE ONLY'));
  assert.ok(prompt.includes('works_for_partner'));
  // The model is told who "we" are, so our own team is never proposed.
  assert.ok(prompt.includes(CRM_OWNER_COMPANY));
  // Spelling variants must collapse into one contact.
  assert.ok(prompt.includes('SAME person'));
  assert.ok(prompt.includes('Jack Smiths'));
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

test('parse: reordered "Last, First" mention verifies; surname-only mention folds into the fuller contact', () => {
  const { contacts } = parsePartnerContactsResponse(respond({
    contacts: [
      { name: 'John Smith', role: 'VP of Sales', company: '', email: '', phone: '', source_ids: ['t2'], context: '' },
      { name: 'Smith', role: '', company: '', email: '', phone: '', source_ids: ['t2'], context: '' },
    ],
    note: '',
  }), { sources: p1Sources() });
  // "Smith" alone is the same human as "John Smith" here — one contact, not
  // a duplicate row, under the fuller name.
  assert.deepEqual(contacts.map(c => c.name), ['John Smith']);
  assert.equal(contacts[0].role, 'VP of Sales');
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

// ── Affiliation rule (partner-side people only) ──────────────────────
const INSIGHT_SOURCES = [{
  source_id: 'a1', source_type: 'description', label: 'Description', date: '2026-06-12',
  text: 'Sync with Dana Reyes (Account Executive at Insight Enterprises, Inc.). '
    + 'Aaron Adsit of Recast Software ran the demo. '
    + 'Jane Doe, Director of IT at Acme Corp, joined for the customer. '
    + 'Kim Patel asked about licensing.',
}];

test('parse: model-flagged non-partner people are excluded; unknown affiliation is kept', () => {
  const { contacts, dropped } = parsePartnerContactsResponse(respond({
    contacts: [
      { name: 'Dana Reyes', role: 'Account Executive', company: 'Insight Enterprises, Inc.', email: '', phone: '', works_for_partner: 'yes', source_ids: ['a1'], context: '' },
      { name: 'Jane Doe', role: '', company: 'Acme Corp', email: '', phone: '', works_for_partner: 'no', source_ids: ['a1'], context: '' },
      { name: 'Kim Patel', role: '', company: '', email: '', phone: '', works_for_partner: 'unknown', source_ids: ['a1'], context: '' },
    ],
    note: '',
  }), { sources: INSIGHT_SOURCES, partnerName: 'Insight' });
  // Dana works for the partner (suffixed legal name still matches); Kim's
  // affiliation is unstated so she stays; Jane belongs to a customer.
  assert.deepEqual(contacts.map(c => c.name).sort(), ['Dana Reyes', 'Kim Patel']);
  assert.equal(contacts.find(c => c.name === 'Dana Reyes').company, 'Insight Enterprises, Inc.');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, 'Jane Doe');
  assert.match(dropped[0].reason, /another company/);
});

test('parse: a verified non-partner company drops the contact even without the model flag', () => {
  const { contacts, dropped } = parsePartnerContactsResponse(respond({
    contacts: [{ name: 'Jane Doe', role: '', company: 'Acme Corp', email: '', phone: '', source_ids: ['a1'], context: '' }],
    note: '',
  }), { sources: INSIGHT_SOURCES, partnerName: 'Insight' });
  assert.equal(contacts.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /Acme Corp/);
});

test("parse: the CRM owner's own team is never a partner contact", () => {
  // Even a (wrong) works_for_partner:"yes" can't save a Recast Software
  // row — the deterministic own-company backstop catches it.
  const { contacts, dropped } = parsePartnerContactsResponse(respond({
    contacts: [{ name: 'Aaron Adsit', role: '', company: 'Recast Software', email: '', phone: '', works_for_partner: 'yes', source_ids: ['a1'], context: '' }],
    note: '',
  }), { sources: INSIGHT_SOURCES, partnerName: 'Insight' });
  assert.equal(contacts.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /own team/);
});

// ── Similar-name duplicate collapse ──────────────────────────────────
test('parse: spelling variants and bare first names collapse into one contact', () => {
  const sources = [
    { source_id: 's1', source_type: 'description', label: 'Description', date: '2026-06-01', text: 'Jack Smith and Priya Nair will own enablement.' },
    { source_id: 's2', source_type: 'meeting', label: 'QBR', date: '2026-06-15', text: 'Jack Smiths presented pricing. Priya to follow up.' },
  ];
  const { contacts } = parsePartnerContactsResponse(respond({
    contacts: [
      { name: 'Jack Smith', role: '', company: '', email: '', phone: '', source_ids: ['s1', 's2'], context: '' },
      { name: 'Jack Smiths', role: '', company: '', email: '', phone: '', source_ids: ['s2'], context: '' },
      { name: 'Priya Nair', role: '', company: '', email: '', phone: '', source_ids: ['s1'], context: '' },
      { name: 'Priya', role: '', company: '', email: '', phone: '', source_ids: ['s2'], context: '' },
    ],
    note: '',
  }), { sources });
  assert.equal(contacts.length, 2);
  // "Jack Smith" verifies against s2's "Jack Smiths" (one-char variant) and
  // the two spellings collapse to a single row with both sources.
  const jack = contacts.find(c => c.name.startsWith('Jack'));
  assert.deepEqual(jack.sources.map(s => s.id).sort(), ['s1', 's2']);
  // The bare "Priya" folds into the fuller "Priya Nair" — never a dupe row.
  const priya = contacts.find(c => c.name.startsWith('Priya'));
  assert.equal(priya.name, 'Priya Nair');
  assert.deepEqual(priya.sources.map(s => s.id).sort(), ['s1', 's2']);
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

test('attendeeContactsToExtracted: rows from other companies are not partner contacts', () => {
  const out = attendeeContactsToExtracted([
    { name: 'Dana Reyes', company: 'Insight Enterprises, Inc.', email: 'dana@insight.com', role: 'AE' },
    { name: 'Aaron Adsit', company: 'Recast Software', email: '', role: 'VP Partner Sales' }, // our own team
    { name: 'Jane Doe', company: 'Acme Corp', email: '', role: '' },                          // customer attendee
    { name: 'Sam Ortiz', company: '', email: '', role: '' },                                  // employer unstated → kept
  ], { docId: 'doc_1', fileName: 'attendees.xlsx', date: '2026-07-22', partnerName: 'Insight' });
  assert.deepEqual(out.map(c => c.name).sort(), ['Dana Reyes', 'Sam Ortiz']);
});

test("attendeeContactsToExtracted: the CRM owner's team is filtered even without a partner name", () => {
  const out = attendeeContactsToExtracted([
    { name: 'Aaron Adsit', company: 'Recast Software', email: '', role: '' },
    { name: 'Ana Lima', company: 'Acme Corp', email: '', role: '' },
  ], { docId: 'doc_1', fileName: 'attendees.xlsx', date: '2026-07-22' });
  assert.deepEqual(out.map(c => c.name), ['Ana Lima']);
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

test('merge: a fuller name for a saved person updates that row — never a duplicate', () => {
  // The screenshot bug: "Aaron" saved, "Aaron Adsit" scanned → one row.
  const existing = [existingRow({ name: 'Aaron', company: '', email: '', sources: [], first_seen: '', last_seen: '' })];
  const { toAppend, toUpdate } = mergeExtractedContacts({
    existing,
    extracted: [{
      name: 'Aaron Adsit', role: 'Vice President Partner Sales', company: '', email: '', phone: '', evidence: '',
      sources: [{ type: 'description', id: 't1', label: 'Description', date: '2026-06-10' }],
    }],
    partnerId: 'p1', partnerName: 'Insight', nowIso: '2026-07-23T10:00:00Z',
  });
  assert.equal(toAppend.length, 0);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].name, 'Aaron Adsit'); // upgraded to the fuller form
  assert.equal(toUpdate[0].role, 'Vice President Partner Sales');
});

test('merge: a one-letter surname variant folds in and the saved spelling wins', () => {
  const existing = [existingRow({ name: 'Jack Smith', company: '', email: '', sources: [], first_seen: '', last_seen: '' })];
  const { toAppend, toUpdate } = mergeExtractedContacts({
    existing,
    extracted: [{
      name: 'Jack Smiths', role: 'Partner AE', company: '', email: '', phone: '', evidence: '',
      sources: [{ type: 'meeting', id: 'm1', label: 'QBR', date: '2026-06-20' }],
    }],
    partnerId: 'p1', partnerName: 'Insight', nowIso: '2026-07-23T10:00:00Z',
  });
  assert.equal(toAppend.length, 0);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].name, 'Jack Smith'); // equal completeness → saved spelling kept
  assert.equal(toUpdate[0].role, 'Partner AE');
});

test('merge: an ambiguous bare name or a contradicting email stays a separate row', () => {
  // Two saved Aarons — a bare "Aaron" could be either, so don't guess.
  const ambiguous = mergeExtractedContacts({
    existing: [
      existingRow({ contact_id: 'e1', _rowIndex: 2, name: 'Aaron Adsit', company: '', email: '', sources: [], first_seen: '', last_seen: '' }),
      existingRow({ contact_id: 'e2', _rowIndex: 3, name: 'Aaron Miller', company: '', email: '', sources: [], first_seen: '', last_seen: '' }),
    ],
    extracted: [{ name: 'Aaron', role: '', company: '', email: '', phone: '', evidence: '', sources: [] }],
    partnerId: 'p1', partnerName: 'Insight', nowIso: '2026-07-23T10:00:00Z',
  });
  assert.equal(ambiguous.toUpdate.length, 0);
  assert.equal(ambiguous.toAppend.length, 1);

  // A similar name with a DIFFERENT email is a different person.
  const contradicting = mergeExtractedContacts({
    existing: [existingRow({ name: 'Aaron Adsit', company: '', email: 'aadsit@insight.com', sources: [], first_seen: '', last_seen: '' })],
    extracted: [{ name: 'Aaron', role: '', company: '', email: 'aaron@other.io', phone: '', evidence: '', sources: [] }],
    partnerId: 'p1', partnerName: 'Insight', nowIso: '2026-07-23T10:00:00Z',
  });
  assert.equal(contradicting.toUpdate.length, 0);
  assert.equal(contradicting.toAppend.length, 1);
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
