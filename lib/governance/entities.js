// WP-15 · D1 — Governed-entity registry (governance foundation).
//
// Immutable, report-only descriptions of governed business entities. Each entry
// reserves classification, retention, sensitive categories, business/technical
// ownership, AI-provenance, and evidence-edge fields — ALL placeholders in WP-15
// (owners null, AI fields null/false, evidenceEdges empty). Pure, dependency-free,
// deep-frozen, copy-on-read (fresh nested arrays), never throws; unknown ids fall
// back to a fail-safe CONFIDENTIAL/standard default. Unwired.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// Build an entity with all reserved governance fields as placeholders.
function entity(id, classification, retention, sensitiveCategories, extra) {
  return Object.assign({
    id,
    classification,
    retention,
    sensitiveCategories,
    businessOwner: null,
    technicalOwner: null,
    responsibleDepartment: null,
    approvalAuthority: null,
    aiGenerated: false,
    aiModel: null,
    promptVersion: null,
    policyVersion: null,
    confidence: null,
    humanVerified: false,
    verifiedBy: null,
    verificationDate: null,
    evidenceEdges: [],
  }, extra || {});
}

const ENTITIES = deepFreeze({
  users: entity('users', 'INTERNAL', 'standard', ['pii', 'credentials']),
  documents: entity('documents', 'CONFIDENTIAL', 'extended', []),
  training: entity('training', 'INTERNAL', 'standard', []),
  competencies: entity('competencies', 'INTERNAL', 'standard', []),
  assessments: entity('assessments', 'CONFIDENTIAL', 'standard', []),
  risk_assessments: entity('risk_assessments', 'SAFETY_CRITICAL', 'extended', []),
  corrective_actions: entity('corrective_actions', 'SAFETY_CRITICAL', 'extended', []),
  ai_outputs: entity('ai_outputs', 'AI_GENERATED', 'standard', ['ai_content'], { aiGenerated: true }),
  attachments: entity('attachments', 'CONFIDENTIAL', 'extended', []),
  photos: entity('photos', 'INTERNAL', 'extended', []),
  approvals: entity('approvals', 'LEGAL', 'permanent', []),
  audit: entity('audit', 'LEGAL', 'permanent', []),
  // WP-15 D4 — HR / medical governed entities (required by the D4 governance
  // integration: HR entities carry HR_CONFIDENTIAL, medical entities carry MEDICAL).
  disciplinary: entity('disciplinary', 'HR_CONFIDENTIAL', 'extended', ['disciplinary_freetext', 'pii']),
  medical: entity('medical', 'MEDICAL', 'extended', ['medical', 'pii']),
  // WP-16 M2 — legacy-audit coverage entities (required by the audit adapter's
  // table mapping for onboarding / leave / equipment domains).
  // WP-16 M4 — onboarding/leave carry medical/health free-text (onboarding MEDICAL
  // action, leave medical reasons), so they include the `medical` category → the
  // adapter drops their free-text audit values.
  onboarding: entity('onboarding', 'HR_CONFIDENTIAL', 'extended', ['pii', 'medical']),
  leave: entity('leave', 'HR_CONFIDENTIAL', 'standard', ['pii', 'medical']),
  equipment: entity('equipment', 'INTERNAL', 'standard', []),
});

const ENTITY_IDS = Object.freeze(Object.keys(ENTITIES));
const SAFE_DEFAULT = deepFreeze(entity('unknown', 'CONFIDENTIAL', 'standard', []));

// Deep copy — fresh nested arrays so callers can never mutate the frozen registry.
function copyEntity(e) {
  return Object.assign({}, e, { sensitiveCategories: [...e.sensitiveCategories], evidenceEdges: [...e.evidenceEdges] });
}

function getEntity(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(ENTITIES, id);
  return copyEntity(known ? ENTITIES[id] : SAFE_DEFAULT);
}

function listEntities() {
  return ENTITY_IDS.map((k) => copyEntity(ENTITIES[k]));
}

module.exports = { ENTITIES, ENTITY_IDS, getEntity, listEntities };
