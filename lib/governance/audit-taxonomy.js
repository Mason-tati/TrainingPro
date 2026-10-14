// WP-15 · D3 — Audit event taxonomy (governance foundation).
//
// Immutable, report-only catalogue of approved business-audit events. Each event
// maps to a known D1 entity + action, and carries a known D1 classification +
// retention, plus governance flags. Pure, dependency-free, deep-frozen,
// copy-on-read, never throws; unknown ids return a safe default. Unwired.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// id is always `${entity}.${action}` (lowercase dot format).
function event(entity, action, description, category, risk, classification, retention, flags) {
  const f = flags || {};
  return {
    id: `${entity}.${action}`,
    entity,
    action,
    description,
    category,
    risk,
    classification,
    retention,
    complianceRelevant: f.complianceRelevant === true,
    lifecycleEvent: f.lifecycleEvent === true,
    evidenceEvent: f.evidenceEvent === true,
  };
}

const RAW = [
  event('users', 'create', 'A user account was created', 'business', 'medium', 'INTERNAL', 'standard'),
  event('users', 'update', 'A user account was updated', 'business', 'medium', 'INTERNAL', 'standard'),
  event('documents', 'create', 'A document was created', 'business', 'low', 'CONFIDENTIAL', 'extended', { evidenceEvent: true }),
  event('documents', 'update', 'A document was updated', 'business', 'low', 'CONFIDENTIAL', 'extended', { evidenceEvent: true }),
  event('documents', 'publish', 'A document was published', 'lifecycle', 'medium', 'CONFIDENTIAL', 'extended', { lifecycleEvent: true, evidenceEvent: true, complianceRelevant: true }),
  event('documents', 'archive', 'A document was archived', 'lifecycle', 'low', 'CONFIDENTIAL', 'extended', { lifecycleEvent: true, evidenceEvent: true }),
  event('training', 'assign', 'Training was assigned', 'training', 'low', 'INTERNAL', 'standard'),
  event('training', 'complete', 'Training was completed', 'training', 'medium', 'INTERNAL', 'standard', { evidenceEvent: true, complianceRelevant: true }),
  event('competencies', 'verify', 'A competency was verified', 'training', 'medium', 'INTERNAL', 'standard', { evidenceEvent: true, complianceRelevant: true }),
  event('assessments', 'assess', 'An assessment was recorded', 'training', 'medium', 'CONFIDENTIAL', 'standard', { evidenceEvent: true }),
  event('risk_assessments', 'create', 'A risk assessment was created', 'compliance', 'high', 'SAFETY_CRITICAL', 'extended', { complianceRelevant: true, evidenceEvent: true }),
  event('corrective_actions', 'update', 'A corrective action was updated', 'compliance', 'high', 'SAFETY_CRITICAL', 'extended', { complianceRelevant: true, evidenceEvent: true }),
  event('ai_outputs', 'generate_ai', 'AI content was generated', 'ai', 'medium', 'AI_GENERATED', 'standard', { evidenceEvent: true }),
  event('approvals', 'approve', 'An approval was granted', 'compliance', 'high', 'LEGAL', 'permanent', { complianceRelevant: true, lifecycleEvent: true, evidenceEvent: true }),
  event('audit', 'export', 'Audit data was exported', 'security', 'high', 'LEGAL', 'permanent', { complianceRelevant: true, evidenceEvent: true }),
  event('audit', 'view', 'Audit data was viewed', 'security', 'low', 'LEGAL', 'permanent', { complianceRelevant: true }),
  event('attachments', 'create', 'An attachment was added', 'business', 'low', 'CONFIDENTIAL', 'extended', { evidenceEvent: true }),
  event('photos', 'create', 'A photo was added', 'business', 'low', 'INTERNAL', 'extended', { evidenceEvent: true }),
];

const AUDIT_EVENTS = deepFreeze(RAW.reduce((acc, e) => { acc[e.id] = e; return acc; }, {}));
const AUDIT_EVENT_IDS = Object.freeze(Object.keys(AUDIT_EVENTS)); // 'unknown' is NOT included

// Safe default returned for any unrecognised event id.
const SAFE_DEFAULT = deepFreeze({
  id: 'unknown', entity: 'audit', action: 'view', description: 'Unknown audit event',
  category: 'compliance', risk: 'low', classification: 'INTERNAL', retention: 'standard',
  complianceRelevant: false, lifecycleEvent: false, evidenceEvent: false,
});

function copy(e) {
  return {
    id: e.id, entity: e.entity, action: e.action, description: e.description,
    category: e.category, risk: e.risk, classification: e.classification, retention: e.retention,
    complianceRelevant: e.complianceRelevant, lifecycleEvent: e.lifecycleEvent, evidenceEvent: e.evidenceEvent,
  };
}

function isKnownAuditEvent(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, id);
}

function getAuditEvent(id) {
  return copy(isKnownAuditEvent(id) ? AUDIT_EVENTS[id] : SAFE_DEFAULT);
}

function listAuditEvents() {
  return AUDIT_EVENT_IDS.map((k) => copy(AUDIT_EVENTS[k]));
}

module.exports = { AUDIT_EVENTS, AUDIT_EVENT_IDS, getAuditEvent, listAuditEvents, isKnownAuditEvent };
