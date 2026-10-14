// WP-17 · D1 — Document workflow-status registry (document-management foundation).
//
// Immutable, report-only lifecycle statuses. Pure, dependency-free, deep-frozen,
// copy-on-read, never throws; unknown ids fall back to a fail-safe non-editable,
// non-published default. UNWIRED — nothing in production imports it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

function status(id, displayName, flags) {
  const f = flags; // every registry entry passes an explicit flags object
  return {
    id,
    displayName,
    editable: !!f.editable,
    published: !!f.published,
    terminal: !!f.terminal,
    requiresApproval: !!f.requiresApproval,
    requiresReview: !!f.requiresReview,
  };
}

const DOCUMENT_STATUSES = deepFreeze({
  DRAFT: status('DRAFT', 'Draft', { editable: true }),
  IN_REVIEW: status('IN_REVIEW', 'In Review', { requiresReview: true }),
  UNDER_APPROVAL: status('UNDER_APPROVAL', 'Under Approval', { requiresApproval: true }),
  APPROVED: status('APPROVED', 'Approved', {}),
  PUBLISHED: status('PUBLISHED', 'Published', { published: true }),
  SUPERSEDED: status('SUPERSEDED', 'Superseded', { terminal: true }),
  ARCHIVED: status('ARCHIVED', 'Archived', { terminal: true }),
  OBSOLETE: status('OBSOLETE', 'Obsolete', { terminal: true }),
});

const DOCUMENT_STATUS_IDS = Object.freeze(Object.keys(DOCUMENT_STATUSES));

// Fail-safe default: unknown status is treated as non-editable and non-published.
const SAFE_DEFAULT = deepFreeze(status('unknown', 'Unknown Status', {}));

function copyStatus(s) { return Object.assign({}, s); }

function getDocumentStatus(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_STATUSES, id);
  return copyStatus(known ? DOCUMENT_STATUSES[id] : SAFE_DEFAULT);
}

function listDocumentStatuses() {
  return DOCUMENT_STATUS_IDS.map((k) => copyStatus(DOCUMENT_STATUSES[k]));
}

module.exports = { DOCUMENT_STATUSES, DOCUMENT_STATUS_IDS, getDocumentStatus, listDocumentStatuses };
