// WP-17 · D7 — Enterprise document layout-template registry (document-management foundation).
//
// The immutable single source of truth for the standard document TEMPLATE LAYOUTS that
// future document-creation modules will instantiate. Each entry declares its default
// document type / classification / approval workflow / review frequency / lifecycle, and
// the layout capabilities it supports, plus a reserved `futureReserved` extension block.
// Deep-frozen, copy-on-read (fresh objects), pure, dependency-free, CommonJS, never
// throws; unknown ids fall back to a safe default. UNWIRED — nothing consumes it.
//
// NOTE: this D7 layout registry lives at `document-layout-templates.js`; the approved D3
// document-type template registry keeps `document-templates.js`. Both are distinct and
// retained (D7 placed here to avoid overwriting D3 — see the D7 report). The safe default
// substitutes valid registry ids for the spec's ANNUALLY → YEARLY and ACTIVE → publish
// (neither ANNUALLY nor ACTIVE exists in the referenced registries).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    layoutEngine: null,
    brandingRule: null,
    renderRule: null,
    translationRule: null,
    numberingRule: null,
    approvalRule: null,
    metadataRule: null,
    workflowRule: null,
    aiRule: null,
    integrationRule: null,
  };
}

// Build a template. `d` carries the default ids and the supports* flags; always an
// explicit object supplied by the registry below.
function template(id, displayName, description, d) {
  return {
    id,
    displayName,
    description,
    defaultDocumentType: d.defaultDocumentType,
    defaultClassification: d.defaultClassification,
    defaultApprovalWorkflow: d.defaultApprovalWorkflow,
    defaultReviewFrequency: d.defaultReviewFrequency,
    defaultLifecycle: d.defaultLifecycle,
    supportsHeader: !!d.supportsHeader,
    supportsFooter: !!d.supportsFooter,
    supportsRevisionTable: !!d.supportsRevisionTable,
    supportsApprovals: !!d.supportsApprovals,
    supportsElectronicSignature: !!d.supportsElectronicSignature,
    supportsReadAcknowledgement: !!d.supportsReadAcknowledgement,
    supportsTableOfContents: !!d.supportsTableOfContents,
    supportsImages: !!d.supportsImages,
    supportsTables: !!d.supportsTables,
    supportsAttachments: !!d.supportsAttachments,
    supportsRiskMatrix: !!d.supportsRiskMatrix,
    supportsAssessment: !!d.supportsAssessment,
    supportsTranslation: !!d.supportsTranslation,
    supportsAIContent: !!d.supportsAIContent,
    supportsVersionHistory: !!d.supportsVersionHistory,
    supportsMetadata: !!d.supportsMetadata,
    supportsReferences: !!d.supportsReferences,
    supportsRelationships: !!d.supportsRelationships,
    futureReserved: reserved(),
  };
}

// Every template has a header, footer, and metadata.
const COMMON = { supportsHeader: true, supportsFooter: true, supportsMetadata: true };
// Fully-controlled document layout capability bundle.
const CONTROLLED = {
  ...COMMON,
  supportsRevisionTable: true, supportsApprovals: true, supportsElectronicSignature: true,
  supportsReadAcknowledgement: true, supportsImages: true, supportsTables: true, supportsAttachments: true,
  supportsTranslation: true, supportsVersionHistory: true, supportsReferences: true, supportsRelationships: true,
};

const DOCUMENT_TEMPLATES = deepFreeze({
  BLANK: template('BLANK', 'Blank Template', 'Minimal blank layout', {
    defaultDocumentType: 'REFERENCE', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'NONE',
    defaultReviewFrequency: 'NONE', defaultLifecycle: 'create', ...COMMON,
  }),
  STANDARD: template('STANDARD', 'Standard Template', 'General-purpose standard layout', {
    defaultDocumentType: 'REFERENCE', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'SIMPLE_REVIEW',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...COMMON,
    supportsRevisionTable: true, supportsApprovals: true, supportsImages: true, supportsTables: true,
    supportsAttachments: true, supportsVersionHistory: true,
  }),
  SOP: template('SOP', 'SOP Template', 'Standard Operating Procedure layout', {
    defaultDocumentType: 'SOP', defaultClassification: 'SAFETY_CRITICAL', defaultApprovalWorkflow: 'MANAGER_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsTableOfContents: true, supportsAIContent: true,
  }),
  WORK_INSTRUCTION: template('WORK_INSTRUCTION', 'Work Instruction Template', 'Task-level work instruction layout', {
    defaultDocumentType: 'WORK_INSTRUCTION', defaultClassification: 'SAFETY_CRITICAL', defaultApprovalWorkflow: 'SUPERVISOR_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsAIContent: true,
  }),
  TRAINING_MANUAL: template('TRAINING_MANUAL', 'Training Manual Template', 'Structured training manual layout', {
    defaultDocumentType: 'TRAINING_MANUAL', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'TRAINING_MANAGER_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsTableOfContents: true, supportsAssessment: true, supportsAIContent: true,
  }),
  POLICY: template('POLICY', 'Policy Template', 'Organisational policy layout', {
    defaultDocumentType: 'POLICY', defaultClassification: 'CONFIDENTIAL', defaultApprovalWorkflow: 'MANAGER_APPROVAL',
    defaultReviewFrequency: 'TWO_YEAR', defaultLifecycle: 'create', ...CONTROLLED, supportsTableOfContents: true,
  }),
  PROCEDURE: template('PROCEDURE', 'Procedure Template', 'Controlled procedure layout', {
    defaultDocumentType: 'PROCEDURE', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'MANAGER_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsTableOfContents: true,
  }),
  STANDARD_DOCUMENT: template('STANDARD_DOCUMENT', 'Standard Document Template', 'Internal standard layout', {
    defaultDocumentType: 'STANDARD', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'MANAGER_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsTableOfContents: true,
  }),
  FORM: template('FORM', 'Form Template', 'Controlled form layout', {
    defaultDocumentType: 'FORM', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'SUPERVISOR_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...COMMON,
    supportsRevisionTable: true, supportsApprovals: true, supportsElectronicSignature: true, supportsTables: true,
    supportsAttachments: true, supportsVersionHistory: true, supportsTranslation: true,
  }),
  CHECKLIST: template('CHECKLIST', 'Checklist Template', 'Controlled checklist layout', {
    defaultDocumentType: 'CHECKLIST', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'SUPERVISOR_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...COMMON,
    supportsRevisionTable: true, supportsApprovals: true, supportsElectronicSignature: true, supportsTables: true,
    supportsVersionHistory: true, supportsTranslation: true,
  }),
  RISK_ASSESSMENT: template('RISK_ASSESSMENT', 'Risk Assessment Template', 'Formal risk assessment layout', {
    defaultDocumentType: 'RISK_ASSESSMENT', defaultClassification: 'SAFETY_CRITICAL', defaultApprovalWorkflow: 'SAFETY_CRITICAL_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsRiskMatrix: true, supportsTableOfContents: true, supportsAIContent: true,
  }),
  JSA: template('JSA', 'JSA Template', 'Job Safety Analysis layout', {
    defaultDocumentType: 'JSA', defaultClassification: 'SAFETY_CRITICAL', defaultApprovalWorkflow: 'SAFETY_CRITICAL_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsRiskMatrix: true, supportsAIContent: true,
  }),
  SWMS: template('SWMS', 'SWMS Template', 'Safe Work Method Statement layout', {
    defaultDocumentType: 'SWMS', defaultClassification: 'SAFETY_CRITICAL', defaultApprovalWorkflow: 'SAFETY_CRITICAL_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsRiskMatrix: true, supportsAIContent: true,
  }),
  PRESENTATION: template('PRESENTATION', 'Presentation Template', 'Training or briefing presentation layout', {
    defaultDocumentType: 'PRESENTATION', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'SIMPLE_REVIEW',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...COMMON,
    supportsImages: true, supportsTables: true, supportsAttachments: true, supportsVersionHistory: true,
    supportsTranslation: true, supportsAIContent: true,
  }),
  HANDBOOK: template('HANDBOOK', 'Handbook Template', 'Employee or site handbook layout', {
    defaultDocumentType: 'HANDBOOK', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'MANAGER_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsTableOfContents: true,
  }),
  TOOLBOX_TALK: template('TOOLBOX_TALK', 'Toolbox Talk Template', 'Short pre-start safety talk layout', {
    defaultDocumentType: 'TOOLBOX_TALK', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'SIMPLE_REVIEW',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...COMMON,
    supportsImages: true, supportsAttachments: true, supportsReadAcknowledgement: true, supportsElectronicSignature: true,
    supportsTranslation: true, supportsAIContent: true, supportsVersionHistory: true,
  }),
  ASSESSMENT: template('ASSESSMENT', 'Assessment Template', 'Knowledge or competency assessment layout', {
    defaultDocumentType: 'ASSESSMENT', defaultClassification: 'CONFIDENTIAL', defaultApprovalWorkflow: 'MANAGER_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsAssessment: true, supportsAIContent: true,
  }),
  REFERENCE: template('REFERENCE', 'Reference Template', 'Supporting reference / learning material layout', {
    defaultDocumentType: 'REFERENCE', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'NONE',
    defaultReviewFrequency: 'NONE', defaultLifecycle: 'create', ...COMMON,
    supportsImages: true, supportsTables: true, supportsAttachments: true, supportsTranslation: true, supportsReferences: true,
  }),
  AI_GENERATED: template('AI_GENERATED', 'AI Generated Template', 'AI-assisted generated content layout', {
    defaultDocumentType: 'AI_CONTENT', defaultClassification: 'AI_GENERATED', defaultApprovalWorkflow: 'AI_CONTENT_APPROVAL',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...CONTROLLED, supportsAIContent: true, supportsTableOfContents: true,
  }),
  EXTERNAL_STANDARD: template('EXTERNAL_STANDARD', 'External Standard Template', 'Externally issued standard layout', {
    defaultDocumentType: 'EXTERNAL_STANDARD', defaultClassification: 'CONFIDENTIAL', defaultApprovalWorkflow: 'EXTERNAL_STANDARD_REVIEW',
    defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'create', ...COMMON,
    supportsReadAcknowledgement: true, supportsAttachments: true, supportsReferences: true, supportsVersionHistory: true,
  }),
});

const DOCUMENT_TEMPLATE_IDS = Object.freeze(Object.keys(DOCUMENT_TEMPLATES));

// Safe default for an unrecognised template id (per D7 spec, with ANNUALLY→YEARLY and
// ACTIVE→publish substituted for the two ids that do not exist in their registries).
const SAFE_DEFAULT = deepFreeze(template('UNKNOWN', 'Unknown Template', 'Unrecognised template — safe default', {
  defaultDocumentType: 'REFERENCE', defaultClassification: 'INTERNAL', defaultApprovalWorkflow: 'MANAGER_APPROVAL',
  defaultReviewFrequency: 'YEARLY', defaultLifecycle: 'publish',
  supportsHeader: true, supportsFooter: true, supportsRevisionTable: true, supportsApprovals: true,
  supportsElectronicSignature: true, supportsReadAcknowledgement: false, supportsTableOfContents: false,
  supportsImages: true, supportsTables: true, supportsAttachments: false, supportsRiskMatrix: false,
  supportsAssessment: false, supportsTranslation: false, supportsAIContent: false, supportsVersionHistory: true,
  supportsMetadata: true, supportsReferences: false, supportsRelationships: false,
}));

// Deep copy — a fresh template with a fresh futureReserved block.
function copyTemplate(t) {
  return Object.assign({}, t, { futureReserved: Object.assign({}, t.futureReserved) });
}

function getDocumentTemplate(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_TEMPLATES, id);
  return copyTemplate(known ? DOCUMENT_TEMPLATES[id] : SAFE_DEFAULT);
}

function listDocumentTemplates() {
  return DOCUMENT_TEMPLATE_IDS.map((k) => copyTemplate(DOCUMENT_TEMPLATES[k]));
}

function isKnownDocumentTemplate(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_TEMPLATES, id);
}

module.exports = {
  DOCUMENT_TEMPLATES,
  DOCUMENT_TEMPLATE_IDS,
  getDocumentTemplate,
  listDocumentTemplates,
  isKnownDocumentTemplate,
};
