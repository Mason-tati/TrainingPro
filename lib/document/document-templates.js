// WP-17 · D3 — Enterprise document-template registry (document-management foundation).
//
// The immutable single source of truth for every supported enterprise document
// template. Each entry pairs a document type with sensible governance/workflow
// defaults, capability flags, and a reserved `futureReserved` extension block (all
// null). Deep-frozen, copy-on-read (fresh objects/arrays), pure, dependency-free,
// CommonJS, never throws; unknown ids fall back to a most-restrictive UNKNOWN default.
// UNWIRED — nothing in production runtime imports or consumes it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    builder: null,
    workflow: null,
    approvalFlow: null,
    numberingScheme: null,
    retentionPolicy: null,
    reviewPolicy: null,
    distributionPolicy: null,
    aiPrompt: null,
    translationProfile: null,
    brandingProfile: null,
    exportProfile: null,
    permissionsProfile: null,
    customFields: null,
    integrationHooks: null,
  };
}

// Build a template. `d` carries the defaults + capability flags (booleans coerced),
// and is always an explicit object supplied by the registry below.
function template(id, displayName, description, d) {
  return {
    id,
    displayName,
    description,
    documentType: d.documentType,
    defaultWorkflow: d.defaultWorkflow,
    defaultStatus: d.defaultStatus,
    defaultReviewFrequency: d.defaultReviewFrequency,
    defaultApprovalLevel: d.defaultApprovalLevel,
    defaultClassification: d.defaultClassification,
    defaultRetention: d.defaultRetention,
    requiresVersioning: !!d.requiresVersioning,
    requiresApproval: !!d.requiresApproval,
    requiresReview: !!d.requiresReview,
    requiresRiskAssessment: !!d.requiresRiskAssessment,
    supportsTranslation: !!d.supportsTranslation,
    supportsReadAcknowledgement: !!d.supportsReadAcknowledgement,
    supportsElectronicSignature: !!d.supportsElectronicSignature,
    supportsAI: !!d.supportsAI,
    supportsAttachments: !!d.supportsAttachments,
    supportsImages: !!d.supportsImages,
    supportsVideo: !!d.supportsVideo,
    supportsPowerPoint: !!d.supportsPowerPoint,
    supportsAssessment: !!d.supportsAssessment,
    supportsRevisionHistory: !!d.supportsRevisionHistory,
    supportsArchiving: !!d.supportsArchiving,
    supportsPublishing: !!d.supportsPublishing,
    supportsMetadata: !!d.supportsMetadata,
    supportsNumbering: !!d.supportsNumbering,
    supportsLifecycle: !!d.supportsLifecycle,
    supportsAudit: !!d.supportsAudit,
    futureReserved: reserved(),
  };
}

// A rich capability set shared by fully-governed controlled/training documents.
const CONTROLLED = {
  requiresVersioning: true, requiresApproval: true, requiresReview: true,
  supportsTranslation: true, supportsReadAcknowledgement: true, supportsElectronicSignature: true,
  supportsAI: true, supportsAttachments: true, supportsImages: true,
  supportsRevisionHistory: true, supportsArchiving: true, supportsPublishing: true,
  supportsMetadata: true, supportsNumbering: true, supportsLifecycle: true, supportsAudit: true,
};

const TEMPLATES = deepFreeze({
  SOP: template('SOP', 'Standard Operating Procedure', 'Controlled step-by-step operating procedure', {
    documentType: 'SOP', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'SAFETY_CRITICAL', defaultRetention: 'extended',
    ...CONTROLLED, requiresRiskAssessment: true,
  }),
  WORK_INSTRUCTION: template('WORK_INSTRUCTION', 'Work Instruction', 'Task-level controlled work instruction', {
    documentType: 'WORK_INSTRUCTION', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'SUPERVISOR', defaultClassification: 'SAFETY_CRITICAL', defaultRetention: 'extended',
    ...CONTROLLED, requiresRiskAssessment: true,
  }),
  TRAINING_MANUAL: template('TRAINING_MANUAL', 'Training Manual', 'Structured training manual', {
    documentType: 'TRAINING_MANUAL', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'INTERNAL', defaultRetention: 'extended',
    ...CONTROLLED, supportsVideo: true, supportsPowerPoint: true, supportsAssessment: true,
  }),
  POLICY: template('POLICY', 'Policy', 'Organisational policy statement', {
    documentType: 'POLICY', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'TWO_YEAR',
    defaultApprovalLevel: 'EXECUTIVE', defaultClassification: 'CONFIDENTIAL', defaultRetention: 'extended',
    ...CONTROLLED,
  }),
  PROCEDURE: template('PROCEDURE', 'Procedure', 'Controlled business or operational procedure', {
    documentType: 'PROCEDURE', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'INTERNAL', defaultRetention: 'extended',
    ...CONTROLLED,
  }),
  STANDARD: template('STANDARD', 'Standard', 'Internal technical or management standard', {
    documentType: 'STANDARD', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'INTERNAL', defaultRetention: 'extended',
    ...CONTROLLED,
  }),
  FORM: template('FORM', 'Form', 'Controlled data-capture form', {
    documentType: 'FORM', defaultWorkflow: 'SIMPLE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'SUPERVISOR', defaultClassification: 'INTERNAL', defaultRetention: 'standard',
    requiresVersioning: true, requiresApproval: true, supportsTranslation: true, supportsElectronicSignature: true,
    supportsAttachments: true, supportsRevisionHistory: true, supportsArchiving: true, supportsPublishing: true,
    supportsMetadata: true, supportsNumbering: true, supportsLifecycle: true, supportsAudit: true,
  }),
  CHECKLIST: template('CHECKLIST', 'Checklist', 'Controlled verification checklist', {
    documentType: 'CHECKLIST', defaultWorkflow: 'SIMPLE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'SUPERVISOR', defaultClassification: 'INTERNAL', defaultRetention: 'standard',
    requiresVersioning: true, requiresApproval: true, supportsTranslation: true, supportsElectronicSignature: true,
    supportsAttachments: true, supportsRevisionHistory: true, supportsArchiving: true, supportsPublishing: true,
    supportsMetadata: true, supportsNumbering: true, supportsLifecycle: true, supportsAudit: true,
  }),
  RISK_ASSESSMENT: template('RISK_ASSESSMENT', 'Risk Assessment', 'Formal risk assessment record', {
    documentType: 'RISK_ASSESSMENT', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'SITE_MANAGER', defaultClassification: 'SAFETY_CRITICAL', defaultRetention: 'extended',
    ...CONTROLLED, requiresRiskAssessment: true,
  }),
  JSA: template('JSA', 'Job Safety Analysis', 'Job Safety Analysis (JSA/JHA)', {
    documentType: 'JSA', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'SUPERVISOR', defaultClassification: 'SAFETY_CRITICAL', defaultRetention: 'extended',
    ...CONTROLLED, requiresRiskAssessment: true,
  }),
  SWMS: template('SWMS', 'Safe Work Method Statement', 'Safe Work Method Statement', {
    documentType: 'SWMS', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'SITE_MANAGER', defaultClassification: 'SAFETY_CRITICAL', defaultRetention: 'extended',
    ...CONTROLLED, requiresRiskAssessment: true,
  }),
  PRESENTATION: template('PRESENTATION', 'Presentation', 'Training or briefing presentation', {
    documentType: 'PRESENTATION', defaultWorkflow: 'SIMPLE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'INTERNAL', defaultRetention: 'standard',
    requiresVersioning: true, supportsTranslation: true, supportsAI: true, supportsAttachments: true,
    supportsImages: true, supportsVideo: true, supportsPowerPoint: true, supportsRevisionHistory: true,
    supportsArchiving: true, supportsPublishing: true, supportsMetadata: true, supportsLifecycle: true, supportsAudit: true,
  }),
  HANDBOOK: template('HANDBOOK', 'Handbook', 'Employee or site handbook', {
    documentType: 'HANDBOOK', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'INTERNAL', defaultRetention: 'extended',
    ...CONTROLLED,
  }),
  TOOLBOX_TALK: template('TOOLBOX_TALK', 'Toolbox Talk', 'Short pre-start safety talk', {
    documentType: 'TOOLBOX_TALK', defaultWorkflow: 'SIMPLE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'SUPERVISOR', defaultClassification: 'INTERNAL', defaultRetention: 'standard',
    requiresVersioning: true, supportsTranslation: true, supportsReadAcknowledgement: true, supportsElectronicSignature: true,
    supportsAI: true, supportsAttachments: true, supportsImages: true, supportsRevisionHistory: true,
    supportsArchiving: true, supportsPublishing: true, supportsMetadata: true, supportsNumbering: true,
    supportsLifecycle: true, supportsAudit: true,
  }),
  ASSESSMENT: template('ASSESSMENT', 'Assessment', 'Knowledge or competency assessment', {
    documentType: 'ASSESSMENT', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'CONFIDENTIAL', defaultRetention: 'extended',
    ...CONTROLLED, supportsAssessment: true,
  }),
  REFERENCE: template('REFERENCE', 'Reference Material', 'Supporting reference / learning material', {
    documentType: 'REFERENCE', defaultWorkflow: 'NONE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'NONE',
    defaultApprovalLevel: 'NONE', defaultClassification: 'INTERNAL', defaultRetention: 'standard',
    supportsTranslation: true, supportsAttachments: true, supportsImages: true, supportsVideo: true,
    supportsArchiving: true, supportsMetadata: true, supportsAudit: true,
  }),
  AI_CONTENT: template('AI_CONTENT', 'AI Generated Content', 'AI-assisted generated content pending human verification', {
    documentType: 'AI_CONTENT', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'MANAGER', defaultClassification: 'AI_GENERATED', defaultRetention: 'standard',
    requiresVersioning: true, requiresApproval: true, requiresReview: true,
    supportsTranslation: true, supportsAI: true, supportsAttachments: true, supportsImages: true,
    supportsRevisionHistory: true, supportsArchiving: true, supportsPublishing: true,
    supportsMetadata: true, supportsNumbering: true, supportsLifecycle: true, supportsAudit: true,
  }),
  IMAGE: template('IMAGE', 'Image', 'Image or photographic asset', {
    documentType: 'IMAGE', defaultWorkflow: 'NONE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'NONE',
    defaultApprovalLevel: 'NONE', defaultClassification: 'INTERNAL', defaultRetention: 'standard',
    supportsAttachments: true, supportsImages: true, supportsMetadata: true, supportsArchiving: true, supportsAudit: true,
  }),
  VIDEO: template('VIDEO', 'Video', 'Video or recorded media asset', {
    documentType: 'VIDEO', defaultWorkflow: 'NONE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'NONE',
    defaultApprovalLevel: 'NONE', defaultClassification: 'INTERNAL', defaultRetention: 'standard',
    supportsTranslation: true, supportsAttachments: true, supportsVideo: true, supportsMetadata: true,
    supportsArchiving: true, supportsAudit: true,
  }),
  EXTERNAL_STANDARD: template('EXTERNAL_STANDARD', 'External Standard', 'Externally issued standard or regulation', {
    documentType: 'EXTERNAL_STANDARD', defaultWorkflow: 'NONE', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
    defaultApprovalLevel: 'NONE', defaultClassification: 'CONFIDENTIAL', defaultRetention: 'extended',
    requiresReview: true, supportsReadAcknowledgement: true, supportsAttachments: true,
    supportsArchiving: true, supportsMetadata: true, supportsAudit: true,
  }),
});

const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

// Most-restrictive fail-safe default for an unrecognised template id.
const SAFE_DEFAULT = deepFreeze(template('UNKNOWN', 'Unknown Template', 'Unrecognised template — most-restrictive safe default', {
  documentType: 'UNKNOWN', defaultWorkflow: 'STANDARD', defaultStatus: 'DRAFT', defaultReviewFrequency: 'YEARLY',
  defaultApprovalLevel: 'MANAGER', defaultClassification: 'CONFIDENTIAL', defaultRetention: 'standard',
  requiresVersioning: true, requiresApproval: true, requiresReview: true,
}));

// Deep copy — a fresh template object with a fresh futureReserved block.
function copyTemplate(t) {
  return Object.assign({}, t, { futureReserved: Object.assign({}, t.futureReserved) });
}

function getTemplate(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, id);
  return copyTemplate(known ? TEMPLATES[id] : SAFE_DEFAULT);
}

function listTemplates() {
  return TEMPLATE_IDS.map((k) => copyTemplate(TEMPLATES[k]));
}

function isKnownTemplate(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, id);
}

module.exports = { TEMPLATES, TEMPLATE_IDS, getTemplate, listTemplates, isKnownTemplate };
