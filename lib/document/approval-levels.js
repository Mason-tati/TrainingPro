// WP-17 · D1 — Document approval-level registry (document-management foundation).
//
// Immutable, report-only approval authority levels ordered by seniority. Pure,
// dependency-free, deep-frozen, copy-on-read, never throws; unknown ids fall back to
// a fail-safe NONE-like default. UNWIRED — nothing in production imports it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// level: ordinal seniority (0 = none). MULTI_LEVEL uses a sentinel high level to
// denote "requires more than one approval level", resolved by future workflow logic.
function approval(id, displayName, level, description) {
  return { id, displayName, level, description };
}

const APPROVAL_LEVELS = deepFreeze({
  NONE: approval('NONE', 'None', 0, 'No approval required'),
  SUPERVISOR: approval('SUPERVISOR', 'Supervisor', 1, 'Approval by a supervisor'),
  SUPERINTENDENT: approval('SUPERINTENDENT', 'Superintendent', 2, 'Approval by a superintendent'),
  MANAGER: approval('MANAGER', 'Manager', 3, 'Approval by a manager'),
  SITE_MANAGER: approval('SITE_MANAGER', 'Site Manager', 4, 'Approval by a site manager'),
  GENERAL_MANAGER: approval('GENERAL_MANAGER', 'General Manager', 5, 'Approval by a general manager'),
  EXECUTIVE: approval('EXECUTIVE', 'Executive', 6, 'Approval by an executive'),
  MULTI_LEVEL: approval('MULTI_LEVEL', 'Multi-Level', 99, 'Requires multiple sequential approval levels'),
});

const APPROVAL_LEVEL_IDS = Object.freeze(Object.keys(APPROVAL_LEVELS));

// Fail-safe default for an unrecognised approval level: treated as NONE.
const SAFE_DEFAULT = deepFreeze(approval('unknown', 'Unknown', 0, 'Unrecognised approval level — safe default'));

function copyApproval(a) { return Object.assign({}, a); }

function getApprovalLevel(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(APPROVAL_LEVELS, id);
  return copyApproval(known ? APPROVAL_LEVELS[id] : SAFE_DEFAULT);
}

function listApprovalLevels() {
  return APPROVAL_LEVEL_IDS.map((k) => copyApproval(APPROVAL_LEVELS[k]));
}

module.exports = { APPROVAL_LEVELS, APPROVAL_LEVEL_IDS, getApprovalLevel, listApprovalLevels };
