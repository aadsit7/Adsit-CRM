// ============================================================
// Analyzer background-job key — { entityType, entityId, runId }
// ============================================================
// The Analyzer now runs three independent entity modes (Opportunity, Event,
// Partner), each with its own background job that survives navigation. A typed
// job key lets an async handler prove, before it applies a response, that the
// response still belongs to the job the user is actually looking at — so a
// stale response for Partner A can never render under Partner B, and one
// mode's result can never overwrite another's.
//
// Pure — no DOM, no network. Trivially unit-testable.
// ============================================================

/** Build a job key. `runId` should be unique per run (e.g. a uuid). */
export function makeJobKey(entityType, entityId, runId) {
  return {
    entityType: String(entityType || ''),
    entityId: String(entityId || ''),
    runId: String(runId || ''),
  };
}

/**
 * True only when ALL THREE of entityType, entityId and runId match. Any
 * difference (a different partner, a superseding run, the wrong mode) makes a
 * late response non-applicable.
 */
export function sameJobKey(a, b) {
  if (!a || !b) return false;
  return String(a.entityType) === String(b.entityType)
    && String(a.entityId) === String(b.entityId)
    && String(a.runId) === String(b.runId);
}
