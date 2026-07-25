// ============================================================
// File-store keys — one untyped namespace, kept collision-free
// ============================================================
// Every attachment in the portal lives in ONE Drive-backed store (the Apps
// Script `Opportunity_Documents` sheet), keyed by a single string in its
// `opportunity_id` column. The backend never inspects that string: it writes
// it on upload and matches it on list. So two records of DIFFERENT types that
// happen to share an id value share a document list — a partner's files appear
// under an event, and vice versa.
//
// The app's generated ids all carry a type prefix (`opp_` / `evt_` / `p_` /
// `pct_`) and therefore cannot collide. Rows seeded before that convention do:
// in this spreadsheet partners are numbered 1-9 and events 1-8, so partner `4`
// and event `4` are the same bucket.
//
// `fileStoreKey()` closes that hole WITHOUT re-keying the records themselves.
// Changing `partner_id` would ripple through eight sheets of foreign keys,
// every saved URL and every signed-in partner session, to fix a collision that
// only exists in this one store. Qualifying the key at the store boundary
// fixes it where it lives.
//
// IDEMPOTENT BY CONSTRUCTION: an id that already carries a known prefix is
// returned untouched, so a record created by the app keys exactly as it always
// has and its existing attachments stay attached. Only legacy bare ids change,
// and `planDocumentKeyMigration()` below moves their existing rows across.
//
// Pure — no DOM, no network, fully unit-testable.
// ============================================================

/** Entity type → the prefix ids of that type carry. */
export const ENTITY_ID_PREFIXES = Object.freeze({
  opportunity: 'opp_',
  event: 'evt_',
  partner: 'p_',
  contact: 'pct_',
});

const ALL_PREFIXES = Object.freeze(Object.values(ENTITY_ID_PREFIXES));

function str(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * Does this id already declare its own type? Checked against EVERY prefix, not
 * just the caller's: that is what stops an opportunity id from being re-tagged
 * as `p_opp_…` if a call site ever passes the wrong type, and what makes the
 * function safe to apply more than once.
 */
export function hasEntityPrefix(id) {
  const s = str(id);
  return ALL_PREFIXES.some(p => s.startsWith(p));
}

/**
 * The key this record's attachments are stored under.
 *
 * @param {string} entityType One of the ENTITY_ID_PREFIXES keys.
 * @param {string} entityId   The record's own id.
 * @returns {string} The qualified key, or '' for a blank id (callers already
 *   treat '' as "no record yet" — the Documents panel shows its save-first
 *   placeholder, and the analyzer attach refuses rather than claiming success).
 */
export function fileStoreKey(entityType, entityId) {
  const id = str(entityId);
  if (!id) return '';
  if (hasEntityPrefix(id)) return id;
  const prefix = ENTITY_ID_PREFIXES[entityType];
  // An unknown entity type is a programming error, not a data condition. Return
  // the id unchanged rather than inventing a namespace: worst case behaviour is
  // exactly what it was before this function existed.
  return prefix ? `${prefix}${id}` : id;
}

function norm(s) {
  return str(s).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The key this record's attachments were filed under BEFORE the qualification
 * above — i.e. its bare id — or '' when there is no such thing because the id
 * was always prefixed.
 *
 * Reads have to bridge this: the code starts asking for `p_4` the moment it
 * ships, while the rows still say `4` until the one-time repair is run. Without
 * a bridge, four real documents would simply vanish from three records until
 * someone happened to open Setup. With it, the repair is a tidy-up rather than
 * a prerequisite.
 */
export function legacyFileStoreKey(entityType, entityId) {
  const id = str(entityId);
  if (!id || hasEntityPrefix(id)) return '';
  // Only meaningful when qualification actually changed the key.
  return fileStoreKey(entityType, id) === id ? '' : id;
}

/**
 * Does a legacy row belong to the record now asking for it?
 *
 * The bare key is exactly the bucket two records share, so rows read back
 * under it CANNOT be handed over wholesale — that is the cross-listing bug.
 * They are filtered by the Drive folder name, the same signal
 * `planDocumentKeyMigration` uses, so the bridge and the repair always agree
 * about who owns what.
 */
export function legacyRowBelongsTo(row, contextName) {
  const folder = norm(row && row.customer_name);
  const name = norm(contextName);
  return !!folder && !!name && folder === name;
}

// ── Migrating the rows already in the store ─────────────────────────
// A legacy record's existing attachments are filed under its BARE id. Once the
// code asks for the qualified key those rows would no longer be found, so they
// have to be moved across — and moving them is also what un-mixes the buckets
// that are currently shared.
//
// The only signal in the row that says which record it belongs to is
// `customer_name`: the Drive folder, which the uploader sets to the partner's
// display name or the event's title. That is enough to resolve a shared bucket,
// and when it is NOT enough the planner says so instead of guessing — a
// misfiled document is worse than one left where it is.

/**
 * Plan the rewrite of every legacy (bare-id) document row.
 *
 * @param {Object} input
 * @param {Array} input.documentRows `Opportunity_Documents` rows (readSheetAsObjects output).
 * @param {Array} input.partners     `Partners` rows.
 * @param {Array} input.events       `Events` rows.
 * @returns {{changes:Array, ambiguous:Array, alreadyQualified:number, scanned:number}}
 *   `changes`   — [{ rowIndex, docId, fileName, from, to, entityType, entityLabel }]
 *   `ambiguous` — rows whose owner could not be determined; left untouched, reported.
 */
export function planDocumentKeyMigration({ documentRows, partners, events, opportunities, contacts } = {}) {
  // A default parameter only covers `undefined`, and these come straight from
  // `.catch(() => [])`-guarded sheet reads that can hand back anything.
  const docs = Array.isArray(documentRows) ? documentRows : [];
  const partnerRows = Array.isArray(partners) ? partners : [];
  const eventRows = Array.isArray(events) ? events : [];

  // Only partners and events are ever RE-KEYED — they are the two types with
  // overlapping legacy numbering. Opportunities and contacts are read purely so
  // that an id one of THEM claims makes a row ambiguous instead of being swept
  // onto a partner by the single-claimant rule below. Every id of theirs is
  // prefixed today, so this is a guard against imported or hand-added rows.
  const otherClaimants = new Set();
  for (const o of (Array.isArray(opportunities) ? opportunities : [])) {
    const id = str(o && o.opportunity_id);
    if (id && !hasEntityPrefix(id)) otherClaimants.add(id);
  }
  for (const c of (Array.isArray(contacts) ? contacts : [])) {
    const id = str(c && c.contact_id);
    if (id && !hasEntityPrefix(id)) otherClaimants.add(id);
  }

  // Legacy records only: an already-prefixed record keys the same before and
  // after, so its rows need no move.
  const partnersByBareId = new Map();
  for (const p of partnerRows) {
    const id = str(p && p.partner_id);
    if (id && !hasEntityPrefix(id)) partnersByBareId.set(id, str(p.display_name));
  }
  const eventsByBareId = new Map();
  for (const e of eventRows) {
    const id = str(e && e.event_id);
    if (id && !hasEntityPrefix(id)) eventsByBareId.set(id, str(e.title));
  }

  const changes = [];
  const ambiguous = [];
  let alreadyQualified = 0;
  let scanned = 0;

  for (const row of docs) {
    if (!row || typeof row !== 'object') continue;
    const key = str(row.opportunity_id);
    if (!key) continue;
    scanned += 1;
    if (hasEntityPrefix(key)) { alreadyQualified += 1; continue; }

    const partnerName = partnersByBareId.get(key);
    const eventTitle = eventsByBareId.get(key);
    const folder = norm(row.customer_name);

    // Which record does this row belong to? Prefer the folder name, which the
    // uploader copied from the record itself.
    const matchesPartner = partnerName !== undefined && folder && norm(partnerName) === folder;
    const matchesEvent = eventTitle !== undefined && folder && norm(eventTitle) === folder;

    let entityType = '';
    let entityLabel = '';
    if (matchesPartner && !matchesEvent) {
      entityType = 'partner'; entityLabel = partnerName;
    } else if (matchesEvent && !matchesPartner) {
      entityType = 'event'; entityLabel = eventTitle;
    } else if (!matchesPartner && !matchesEvent && !otherClaimants.has(key)) {
      // The folder names nothing. If exactly ONE record in the whole CRM
      // carries this id there is still no ambiguity about where it goes — but
      // an opportunity or contact holding it too means we must not assume.
      if (partnerName !== undefined && eventTitle === undefined) {
        entityType = 'partner'; entityLabel = partnerName;
      } else if (eventTitle !== undefined && partnerName === undefined) {
        entityType = 'event'; entityLabel = eventTitle;
      }
    }
    // matchesPartner && matchesEvent (a partner and an event with the SAME id
    // AND the same name) falls through as ambiguous, as does an id no record
    // claims and a shared id whose folder matches neither.

    if (!entityType) {
      ambiguous.push({
        rowIndex: Number(row._rowIndex) || 0,
        docId: str(row.doc_id),
        fileName: str(row.file_name),
        key,
        folder: str(row.customer_name),
        partnerName: partnerName === undefined ? '' : partnerName,
        eventTitle: eventTitle === undefined ? '' : eventTitle,
        reason: otherClaimants.has(key)
          ? 'Another record type also uses this id, so its owner is not certain.'
          : (partnerName === undefined && eventTitle === undefined
            ? 'No partner or event has this id.'
            : 'The Drive folder name does not identify which record this belongs to.'),
      });
      continue;
    }

    changes.push({
      rowIndex: Number(row._rowIndex) || 0,
      docId: str(row.doc_id),
      fileName: str(row.file_name),
      from: key,
      to: fileStoreKey(entityType, key),
      entityType,
      entityLabel,
    });
  }

  return { changes, ambiguous, alreadyQualified, scanned };
}

// ── Turning a plan into writes ──────────────────────────────────────
// A ROW NUMBER IS NOT AN IDENTITY IN THIS SHEET. Deleting an attachment runs
// `sheet.deleteRow()` in the Apps Script, which physically removes the row and
// shifts every row below it up by one. So a row index captured when the plan
// was built can point at a completely different document by the time the admin
// presses Apply — and writing to it would re-key someone else's attachment and
// leave the real one behind.
//
// `doc_id` IS an identity: the Apps Script mints it per upload and never
// reuses it. So the row index is resolved from `doc_id` against a fresh read
// at write time, and a change is only written if that row still holds the key
// the plan expected. Anything that moved is reported, not written.

/** Column letter for a 1-based index (1 → A). */
function columnLetterFor(index) {
  let n = index;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Which column holds `opportunity_id`, derived from the sheet's own header row
 * rather than assumed. The Apps Script writes that header only when it has to
 * CREATE the tab, and nothing in the app validates the layout afterwards — so
 * on a hand-maintained spreadsheet an inserted column would otherwise send
 * these writes into `doc_id` or `customer_name`.
 *
 * @returns {string} the column letter, or '' when the header is missing (the
 *   caller must then refuse to write).
 */
export function documentKeyColumnLetter(headerRow) {
  const idx = (headerRow || []).findIndex(h => str(h) === 'opportunity_id');
  return idx >= 0 ? columnLetterFor(idx + 1) : '';
}

/**
 * Resolve a plan into the exact cell writes that apply it, against the sheet as
 * it is RIGHT NOW.
 *
 * @param {Object} plan       from planDocumentKeyMigration()
 * @param {Array}  freshRows  `Opportunity_Documents` re-read at write time
 * @param {string} keyColumn  from documentKeyColumnLetter()
 * @returns {{updates:Array<{a1:string,value:string}>, stale:Array}}
 *   `stale` — changes that could not be applied safely, each with a reason.
 *   A non-empty `stale` means the sheet moved under the plan: the caller should
 *   write nothing and ask for a fresh check.
 */
export function resolveDocumentKeyWrites(plan, freshRows, keyColumn) {
  const updates = [];
  const stale = [];
  const col = str(keyColumn);
  const changes = (plan && plan.changes) || [];
  if (!col) {
    return {
      updates: [],
      stale: changes.map(c => ({ ...c, reason: 'The Opportunity_Documents sheet has no opportunity_id column.' })),
    };
  }

  const byDocId = new Map();
  for (const row of (Array.isArray(freshRows) ? freshRows : [])) {
    if (!row || typeof row !== 'object') continue;
    const id = str(row.doc_id);
    if (id) byDocId.set(id, row);
  }

  for (const c of changes) {
    if (!c) continue;
    if (!c.docId) {
      stale.push({ ...c, reason: 'This attachment has no doc_id, so its row cannot be identified.' });
      continue;
    }
    const row = byDocId.get(c.docId);
    if (!row) {
      stale.push({ ...c, reason: 'This attachment is no longer in the sheet.' });
      continue;
    }
    if (str(row.opportunity_id) !== c.from) {
      stale.push({ ...c, reason: `Its record id is now “${str(row.opportunity_id)}”, not “${c.from}”.` });
      continue;
    }
    const rowIndex = Number(row._rowIndex) || 0;
    if (rowIndex < 2) {
      stale.push({ ...c, reason: 'Its row could not be located.' });
      continue;
    }
    updates.push({ a1: `${col}${rowIndex}`, value: c.to });
  }

  return { updates, stale };
}

/**
 * One-line human summary of a plan — used by the Setup page's preview and by
 * the toast after applying, so both describe the same thing the same way.
 */
export function describeDocumentKeyPlan(plan) {
  const { changes = [], ambiguous = [], alreadyQualified = 0 } = plan || {};
  if (!changes.length && !ambiguous.length) {
    return `Nothing to migrate — all ${alreadyQualified} attachment${alreadyQualified === 1 ? '' : 's'} already key to exactly one record.`;
  }
  const bits = [];
  if (changes.length) bits.push(`${changes.length} attachment${changes.length === 1 ? '' : 's'} to re-key`);
  if (ambiguous.length) bits.push(`${ambiguous.length} needing a manual decision`);
  return bits.join(', ') + `; ${alreadyQualified} already correct.`;
}
