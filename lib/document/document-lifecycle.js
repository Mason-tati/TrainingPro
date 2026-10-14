// WP-17 · D1 — Document lifecycle-action registry (document-management foundation).
//
// Immutable, report-only description of each lifecycle action and the controls it
// requires. Pure, dependency-free, deep-frozen, copy-on-read, never throws; unknown
// ids fall back to a fail-safe most-restrictive default. UNWIRED — nothing imports it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

function stage(id, displayName, controls) {
  const c = controls; // every registry entry passes an explicit controls object
  return {
    id,
    displayName,
    requiresApproval: !!c.requiresApproval,
    requiresAudit: !!c.requiresAudit,
    requiresVersion: !!c.requiresVersion,
    requiresPermission: !!c.requiresPermission,
  };
}

const DOCUMENT_LIFECYCLE = deepFreeze({
  create: stage('create', 'Create', { requiresAudit: true, requiresVersion: true, requiresPermission: true }),
  review: stage('review', 'Review', { requiresAudit: true, requiresPermission: true }),
  approve: stage('approve', 'Approve', { requiresApproval: true, requiresAudit: true, requiresPermission: true }),
  publish: stage('publish', 'Publish', { requiresApproval: true, requiresAudit: true, requiresVersion: true, requiresPermission: true }),
  read: stage('read', 'Read', { requiresAudit: true, requiresPermission: true }),
  revise: stage('revise', 'Revise', { requiresAudit: true, requiresVersion: true, requiresPermission: true }),
  supersede: stage('supersede', 'Supersede', { requiresApproval: true, requiresAudit: true, requiresVersion: true, requiresPermission: true }),
  archive: stage('archive', 'Archive', { requiresAudit: true, requiresPermission: true }),
  restore: stage('restore', 'Restore', { requiresAudit: true, requiresPermission: true }),
  delete: stage('delete', 'Delete', { requiresApproval: true, requiresAudit: true, requiresPermission: true }),
});

const DOCUMENT_LIFECYCLE_IDS = Object.freeze(Object.keys(DOCUMENT_LIFECYCLE));

// Fail-safe default for an unrecognised action: most restrictive (everything required).
const SAFE_DEFAULT = deepFreeze(stage('unknown', 'Unknown', {
  requiresApproval: true, requiresAudit: true, requiresVersion: true, requiresPermission: true,
}));

function copyStage(s) { return Object.assign({}, s); }

function getLifecycleStage(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_LIFECYCLE, id);
  return copyStage(known ? DOCUMENT_LIFECYCLE[id] : SAFE_DEFAULT);
}

function listLifecycleStages() {
  return DOCUMENT_LIFECYCLE_IDS.map((k) => copyStage(DOCUMENT_LIFECYCLE[k]));
}

module.exports = { DOCUMENT_LIFECYCLE, DOCUMENT_LIFECYCLE_IDS, getLifecycleStage, listLifecycleStages };
