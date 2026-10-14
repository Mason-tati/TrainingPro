// WP-17 · D2 — Document governance mapping (document-management foundation).
//
// Maps D1 document types to the WP-15 governance registries (classification,
// retention, entity, sensitive categories) and reserves ownership / AI-provenance
// placeholders. Pure, deep-frozen source data, copy-on-read (fresh object per call),
// never throws; unknown types fall back to a safe default. UNWIRED — nothing in
// production runtime imports it.
'use strict';

const { getDocumentType } = require('./document-types');
const { getClassification } = require('../governance/classifications');
const { getRetention } = require('../governance/retention');
const { getEntity } = require('../governance/entities');
const { SENSITIVE_DATA_IDS } = require('../governance/sensitive-data');

// Safe defaults for an unknown / unmapped document type.
const DEFAULT_CLASSIFICATION = 'CONFIDENTIAL';
const DEFAULT_RETENTION = 'standard';
const DEFAULT_ENTITY = 'documents';
const DEFAULT_SOURCE = 'global';

// Document type → { classification, retention }. Every value is a known WP-15 id.
// EXTERNAL_STANDARD would ideally be EXTERNAL/extended, but no EXTERNAL classification
// exists in the registry, so it uses the safe CONFIDENTIAL/extended fallback.
const TYPE_GOVERNANCE = Object.freeze({
  SOP: { classification: 'SAFETY_CRITICAL', retention: 'extended' },
  WORK_INSTRUCTION: { classification: 'SAFETY_CRITICAL', retention: 'extended' },
  TRAINING_MANUAL: { classification: 'INTERNAL', retention: 'extended' },
  POLICY: { classification: 'CONFIDENTIAL', retention: 'extended' },
  PROCEDURE: { classification: 'INTERNAL', retention: 'extended' },
  STANDARD: { classification: 'INTERNAL', retention: 'extended' },
  FORM: { classification: 'INTERNAL', retention: 'standard' },
  CHECKLIST: { classification: 'INTERNAL', retention: 'standard' },
  RISK_ASSESSMENT: { classification: 'SAFETY_CRITICAL', retention: 'extended' },
  JSA: { classification: 'SAFETY_CRITICAL', retention: 'extended' },
  SWMS: { classification: 'SAFETY_CRITICAL', retention: 'extended' },
  PRESENTATION: { classification: 'INTERNAL', retention: 'standard' },
  HANDBOOK: { classification: 'INTERNAL', retention: 'extended' },
  TOOLBOX_TALK: { classification: 'INTERNAL', retention: 'standard' },
  AI_CONTENT: { classification: 'AI_GENERATED', retention: 'standard' },
  IMAGE: { classification: 'INTERNAL', retention: 'standard' },
  VIDEO: { classification: 'INTERNAL', retention: 'standard' },
  ASSESSMENT: { classification: 'CONFIDENTIAL', retention: 'extended' },
  REFERENCE: { classification: 'INTERNAL', retention: 'standard' },
  EXTERNAL_STANDARD: { classification: 'CONFIDENTIAL', retention: 'extended' },
});

// Document type → governance entity. Default (and unknown) → 'documents'.
const ENTITY_MAP = Object.freeze({
  AI_CONTENT: 'ai_outputs',
  ASSESSMENT: 'assessments',
  RISK_ASSESSMENT: 'risk_assessments',
  JSA: 'risk_assessments',
  SWMS: 'risk_assessments',
});

// Document type → sensitive categories (known WP-15 ids). Default → [].
const SENSITIVE_MAP = Object.freeze({
  AI_CONTENT: ['ai_content'],
  ASSESSMENT: ['pii'],
});

// getDocumentGovernance — resolve a governance record for a document type id.
// Always returns a FRESH object; unknown/garbage → safe default; never throws.
function getDocumentGovernance(typeId) {
  const t = getDocumentType(typeId); // copy; t.id === 'unknown' when unrecognised
  const map = TYPE_GOVERNANCE[t.id]; // undefined for the unknown default
  const classification = getClassification(map ? map.classification : DEFAULT_CLASSIFICATION).id;
  const retention = getRetention(map ? map.retention : DEFAULT_RETENTION).id;
  const entity = getEntity(ENTITY_MAP[t.id] || DEFAULT_ENTITY).id;
  const sensitiveCategories = (SENSITIVE_MAP[t.id] || []).filter((s) => SENSITIVE_DATA_IDS.includes(s));
  const aiGenerated = t.id === 'AI_CONTENT';
  return {
    type: t.id,
    classification,
    retention,
    entity,
    sensitiveCategories, // fresh array
    requiresApproval: t.requiresApproval,
    requiresVersioning: t.requiresVersioning,
    requiresReview: t.requiresReview,
    supportsTranslation: t.supportsTranslation,
    supportsTraining: t.supportsTraining,
    supportsRiskAssessment: t.supportsRiskAssessment,
    supportsAI: t.supportsAI,
    supportsAttachments: t.supportsAttachments,
    supportsWorkflow: t.supportsWorkflow,
    supportsReadAcknowledgement: t.supportsReadAcknowledgement,
    supportsElectronicSignoff: t.supportsElectronicSignoff,
    ownership: { businessOwner: null, technicalOwner: null, responsibleDepartment: null, approvalAuthority: null },
    ai: {
      aiGenerated,
      aiModel: null,
      promptVersion: null,
      policyVersion: null,
      confidence: null,
      humanVerified: false,
      verifiedBy: null,
      verificationDate: null,
    },
    source: DEFAULT_SOURCE,
  };
}

// listDocumentGovernance — a fresh governance record for every known document type.
function listDocumentGovernance() {
  return require('./document-types').DOCUMENT_TYPE_IDS.map((id) => getDocumentGovernance(id));
}

// resolveDocumentGovernance — flexible resolver: accepts a type-id string, or an
// object { type, source? } (source override is a non-empty string), or anything else
// (→ safe default). Never throws; always a fresh object.
function resolveDocumentGovernance(input) {
  if (typeof input === 'string') return getDocumentGovernance(input);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const gov = getDocumentGovernance(input.type);
    if (typeof input.source === 'string' && input.source.trim() !== '') gov.source = input.source.trim();
    return gov;
  }
  return getDocumentGovernance(undefined);
}

module.exports = { getDocumentGovernance, listDocumentGovernance, resolveDocumentGovernance };
