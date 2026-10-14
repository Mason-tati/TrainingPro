// WP-17 · D1 — Enterprise document-type registry (document-management foundation).
//
// Immutable, report-only descriptions of every governed document type the future
// document modules will depend on. Pure, dependency-free, deep-frozen, copy-on-read
// (callers get fresh objects), never throws; unknown ids fall back to a fail-safe
// default. UNWIRED — nothing in production imports it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// Build a document type with all capability flags explicit (no implicit defaults).
function type(id, displayName, description, category, caps) {
  const c = caps; // every registry entry passes an explicit caps object
  return {
    id,
    displayName,
    description,
    category,
    requiresApproval: !!c.requiresApproval,
    requiresVersioning: !!c.requiresVersioning,
    requiresReview: !!c.requiresReview,
    supportsTranslation: !!c.supportsTranslation,
    supportsTraining: !!c.supportsTraining,
    supportsRiskAssessment: !!c.supportsRiskAssessment,
    supportsAI: !!c.supportsAI,
    supportsAttachments: !!c.supportsAttachments,
    supportsWorkflow: !!c.supportsWorkflow,
    supportsReadAcknowledgement: !!c.supportsReadAcknowledgement,
    supportsElectronicSignoff: !!c.supportsElectronicSignoff,
  };
}

// Category labels used purely to group types for future navigation/reporting.
const CATEGORIES = Object.freeze(['controlled', 'training', 'record', 'media', 'ai', 'reference']);

const DOCUMENT_TYPES = deepFreeze({
  SOP: type('SOP', 'Standard Operating Procedure', 'Controlled step-by-step operating procedure', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsRiskAssessment: true, supportsAI: true, supportsAttachments: true,
    supportsWorkflow: true, supportsReadAcknowledgement: true, supportsElectronicSignoff: true,
  }),
  WORK_INSTRUCTION: type('WORK_INSTRUCTION', 'Work Instruction', 'Task-level controlled work instruction', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsRiskAssessment: true, supportsAI: true, supportsAttachments: true,
    supportsWorkflow: true, supportsReadAcknowledgement: true, supportsElectronicSignoff: true,
  }),
  TRAINING_MANUAL: type('TRAINING_MANUAL', 'Training Manual', 'Structured training manual', 'training', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsAI: true, supportsAttachments: true, supportsWorkflow: true,
    supportsReadAcknowledgement: true,
  }),
  POLICY: type('POLICY', 'Policy', 'Organisational policy statement', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsAI: true, supportsAttachments: true, supportsWorkflow: true, supportsReadAcknowledgement: true,
    supportsElectronicSignoff: true,
  }),
  PROCEDURE: type('PROCEDURE', 'Procedure', 'Controlled business or operational procedure', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsAI: true, supportsAttachments: true, supportsWorkflow: true,
    supportsReadAcknowledgement: true, supportsElectronicSignoff: true,
  }),
  STANDARD: type('STANDARD', 'Standard', 'Internal technical or management standard', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsAttachments: true, supportsWorkflow: true, supportsReadAcknowledgement: true,
  }),
  FORM: type('FORM', 'Form', 'Controlled data-capture form', 'record', {
    requiresApproval: true, requiresVersioning: true, supportsTranslation: true, supportsAttachments: true,
    supportsWorkflow: true, supportsElectronicSignoff: true,
  }),
  CHECKLIST: type('CHECKLIST', 'Checklist', 'Controlled verification checklist', 'record', {
    requiresApproval: true, requiresVersioning: true, supportsTranslation: true, supportsAttachments: true,
    supportsWorkflow: true, supportsElectronicSignoff: true,
  }),
  RISK_ASSESSMENT: type('RISK_ASSESSMENT', 'Risk Assessment', 'Formal risk assessment record', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsRiskAssessment: true, supportsAI: true, supportsAttachments: true,
    supportsWorkflow: true, supportsReadAcknowledgement: true, supportsElectronicSignoff: true,
  }),
  JSA: type('JSA', 'Job Safety Analysis', 'Job Safety Analysis (JSA/JHA)', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsRiskAssessment: true, supportsAI: true, supportsAttachments: true,
    supportsWorkflow: true, supportsReadAcknowledgement: true, supportsElectronicSignoff: true,
  }),
  SWMS: type('SWMS', 'Safe Work Method Statement', 'Safe Work Method Statement', 'controlled', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsRiskAssessment: true, supportsAI: true, supportsAttachments: true,
    supportsWorkflow: true, supportsReadAcknowledgement: true, supportsElectronicSignoff: true,
  }),
  PRESENTATION: type('PRESENTATION', 'Presentation', 'Training or briefing presentation', 'training', {
    requiresVersioning: true, supportsTranslation: true, supportsTraining: true, supportsAI: true,
    supportsAttachments: true, supportsWorkflow: true,
  }),
  HANDBOOK: type('HANDBOOK', 'Handbook', 'Employee or site handbook', 'training', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsAI: true, supportsAttachments: true, supportsWorkflow: true,
    supportsReadAcknowledgement: true,
  }),
  TOOLBOX_TALK: type('TOOLBOX_TALK', 'Toolbox Talk', 'Short pre-start safety talk', 'training', {
    requiresVersioning: true, supportsTranslation: true, supportsTraining: true, supportsAI: true,
    supportsAttachments: true, supportsReadAcknowledgement: true, supportsElectronicSignoff: true,
  }),
  AI_CONTENT: type('AI_CONTENT', 'AI Generated Content', 'AI-assisted generated content pending human verification', 'ai', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsAI: true, supportsAttachments: true, supportsWorkflow: true,
  }),
  IMAGE: type('IMAGE', 'Image', 'Image or photographic asset', 'media', {
    supportsAttachments: true,
  }),
  VIDEO: type('VIDEO', 'Video', 'Video or recorded media asset', 'media', {
    supportsTranslation: true, supportsTraining: true, supportsAttachments: true,
  }),
  ASSESSMENT: type('ASSESSMENT', 'Assessment', 'Knowledge or competency assessment', 'training', {
    requiresApproval: true, requiresVersioning: true, requiresReview: true, supportsTranslation: true,
    supportsTraining: true, supportsAI: true, supportsAttachments: true, supportsWorkflow: true,
    supportsElectronicSignoff: true,
  }),
  REFERENCE: type('REFERENCE', 'Reference Material', 'Supporting reference / learning material', 'reference', {
    supportsTranslation: true, supportsTraining: true, supportsAttachments: true,
  }),
  EXTERNAL_STANDARD: type('EXTERNAL_STANDARD', 'External Standard', 'Externally issued standard or regulation', 'reference', {
    requiresReview: true, supportsAttachments: true, supportsReadAcknowledgement: true,
  }),
});

const DOCUMENT_TYPE_IDS = Object.freeze(Object.keys(DOCUMENT_TYPES));

// Fail-safe default for an unrecognised type: most restrictive, no capabilities.
const SAFE_DEFAULT = deepFreeze(type('unknown', 'Unknown Document Type', 'Unrecognised document type — safe default', 'reference', {
  requiresApproval: true, requiresVersioning: true, requiresReview: true,
}));

function copyType(t) { return Object.assign({}, t); }

function getDocumentType(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, id);
  return copyType(known ? DOCUMENT_TYPES[id] : SAFE_DEFAULT);
}

function listDocumentTypes() {
  return DOCUMENT_TYPE_IDS.map((k) => copyType(DOCUMENT_TYPES[k]));
}

module.exports = { DOCUMENT_TYPES, DOCUMENT_TYPE_IDS, CATEGORIES, getDocumentType, listDocumentTypes };
