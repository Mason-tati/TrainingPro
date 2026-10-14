// WP-15 · D1 — Retention category registry (governance foundation).
//
// Immutable, report-only retention categories. Durations remain NULL — there is
// NO retention enforcement, NO purge, NO deletion. Pure, dependency-free,
// deep-frozen, copy-on-read, never throws; unknown ids fall back to the safe
// default `standard` (which is NOT auto-delete-eligible). Unwired.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}
function entry(id, flags) {
  return {
    id,
    defaultYears: null, // placeholder — never a duration in WP-15
    legalHoldSupported: flags.legalHoldSupported,
    archiveRequired: flags.archiveRequired,
    autoDeleteEligible: flags.autoDeleteEligible,
    approvalRequired: flags.approvalRequired,
    exportReviewRequired: flags.exportReviewRequired,
  };
}

const RETENTION = deepFreeze({
  transient: entry('transient', { legalHoldSupported: false, archiveRequired: false, autoDeleteEligible: true, approvalRequired: false, exportReviewRequired: false }),
  standard: entry('standard', { legalHoldSupported: true, archiveRequired: false, autoDeleteEligible: false, approvalRequired: false, exportReviewRequired: false }),
  extended: entry('extended', { legalHoldSupported: true, archiveRequired: true, autoDeleteEligible: false, approvalRequired: true, exportReviewRequired: true }),
  legal_hold: entry('legal_hold', { legalHoldSupported: true, archiveRequired: true, autoDeleteEligible: false, approvalRequired: true, exportReviewRequired: true }),
  permanent: entry('permanent', { legalHoldSupported: true, archiveRequired: true, autoDeleteEligible: false, approvalRequired: true, exportReviewRequired: true }),
});

const RETENTION_IDS = Object.freeze(Object.keys(RETENTION));
const SAFE_DEFAULT = 'standard'; // fail-safe: not auto-delete-eligible

function copy(e) {
  return {
    id: e.id,
    defaultYears: e.defaultYears,
    legalHoldSupported: e.legalHoldSupported,
    archiveRequired: e.archiveRequired,
    autoDeleteEligible: e.autoDeleteEligible,
    approvalRequired: e.approvalRequired,
    exportReviewRequired: e.exportReviewRequired,
  };
}

function getRetention(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(RETENTION, id);
  return copy(known ? RETENTION[id] : RETENTION[SAFE_DEFAULT]);
}

function listRetention() {
  return RETENTION_IDS.map((k) => copy(RETENTION[k]));
}

module.exports = { RETENTION, RETENTION_IDS, getRetention, listRetention };
