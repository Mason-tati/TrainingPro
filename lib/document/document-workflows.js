// WP-17 · D14 — Enterprise document workflow registry (document-management foundation).
//
// The immutable single source of truth for every supported document workflow — its
// category, initial/final status transition, and the review/approval/publication
// requirements and capabilities it entails — plus a reserved `futureReserved` block.
// Deep-frozen, copy-on-read (fresh objects), pure, dependency-free, CommonJS, never
// throws; unknown ids fall back to a safe, most-controlled default. UNWIRED — nothing
// consumes it (no workflow engine, state machine, routing, or notifications).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    approvalPolicy: null,
    reviewPolicy: null,
    routingPolicy: null,
    notificationPolicy: null,
    automationPolicy: null,
    workflowEnginePolicy: null,
    escalationPolicy: null,
    aiPolicy: null,
    integrationPolicy: null,
    extensionPolicy: null,
  };
}

// Build a workflow. `w` carries the boolean flags; category/status are explicit strings.
function workflow(id, displayName, description, category, initialStatus, finalStatus, w) {
  return {
    id,
    displayName,
    description,
    category,
    initialStatus,
    finalStatus,
    requiresReview: !!w.requiresReview,
    requiresApproval: !!w.requiresApproval,
    requiresPublication: !!w.requiresPublication,
    requiresReadAcknowledgement: !!w.requiresReadAcknowledgement,
    requiresElectronicSignature: !!w.requiresElectronicSignature,
    requiresVersionIncrement: !!w.requiresVersionIncrement,
    requiresDocumentNumber: !!w.requiresDocumentNumber,
    requiresOwner: !!w.requiresOwner,
    requiresReviewer: !!w.requiresReviewer,
    requiresApprover: !!w.requiresApprover,
    requiresPublishedSource: !!w.requiresPublishedSource,
    allowsParallelReview: !!w.allowsParallelReview,
    allowsDraftRevision: !!w.allowsDraftRevision,
    supportsRollback: !!w.supportsRollback,
    supportsEmergencyOverride: !!w.supportsEmergencyOverride,
    auditRequired: !!w.auditRequired,
    futureReserved: reserved(),
  };
}

// A fully-governed controlled-document capability bundle (shared by the strict flows).
const CONTROLLED = {
  requiresReview: true, requiresApproval: true, requiresPublication: true, requiresVersionIncrement: true,
  requiresDocumentNumber: true, requiresOwner: true, requiresReviewer: true, requiresApprover: true,
  allowsDraftRevision: true, supportsRollback: true, auditRequired: true,
};

const DOCUMENT_WORKFLOWS = deepFreeze({
  NONE: workflow('NONE', 'No Workflow', 'No workflow applied', 'none', 'DRAFT', 'DRAFT', {}),
  STANDARD: workflow('STANDARD', 'Standard', 'Standard review → approval → publication', 'standard', 'DRAFT', 'PUBLISHED', {
    requiresReview: true, requiresApproval: true, requiresPublication: true, requiresVersionIncrement: true,
    requiresDocumentNumber: true, requiresOwner: true, requiresReviewer: true, requiresApprover: true,
    allowsDraftRevision: true, supportsRollback: true, auditRequired: true,
  }),
  FAST_TRACK: workflow('FAST_TRACK', 'Fast Track', 'Expedited approval and publication', 'standard', 'DRAFT', 'PUBLISHED', {
    requiresApproval: true, requiresPublication: true, requiresVersionIncrement: true, requiresDocumentNumber: true,
    requiresOwner: true, requiresApprover: true, allowsDraftRevision: true, supportsEmergencyOverride: true, auditRequired: true,
  }),
  CONTROLLED_DOCUMENT: workflow('CONTROLLED_DOCUMENT', 'Controlled Document', 'Full controlled-document workflow', 'controlled', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED, requiresReadAcknowledgement: true, requiresElectronicSignature: true, allowsParallelReview: true,
  }),
  ISO_DOCUMENT: workflow('ISO_DOCUMENT', 'ISO Document', 'ISO-controlled document workflow', 'quality', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED, requiresElectronicSignature: true, allowsParallelReview: true,
  }),
  TRAINING_DOCUMENT: workflow('TRAINING_DOCUMENT', 'Training Document', 'Training content workflow', 'training', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED, requiresReadAcknowledgement: true,
  }),
  RISK_ASSESSMENT: workflow('RISK_ASSESSMENT', 'Risk Assessment', 'Risk assessment workflow', 'risk', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED, allowsParallelReview: true,
  }),
  WORK_INSTRUCTION: workflow('WORK_INSTRUCTION', 'Work Instruction', 'Work instruction workflow', 'procedure', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED,
  }),
  STANDARD_OPERATING_PROCEDURE: workflow('STANDARD_OPERATING_PROCEDURE', 'Standard Operating Procedure', 'SOP workflow', 'procedure', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED, requiresReadAcknowledgement: true,
  }),
  POLICY: workflow('POLICY', 'Policy', 'Policy workflow', 'policy', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED, requiresReadAcknowledgement: true,
  }),
  PROCEDURE: workflow('PROCEDURE', 'Procedure', 'Procedure workflow', 'procedure', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED,
  }),
  FORM: workflow('FORM', 'Form', 'Form workflow', 'standard', 'DRAFT', 'PUBLISHED', {
    requiresApproval: true, requiresPublication: true, requiresVersionIncrement: true, requiresDocumentNumber: true,
    requiresOwner: true, requiresApprover: true, allowsDraftRevision: true, auditRequired: true,
  }),
  CHECKLIST: workflow('CHECKLIST', 'Checklist', 'Checklist workflow', 'standard', 'DRAFT', 'PUBLISHED', {
    requiresApproval: true, requiresPublication: true, requiresVersionIncrement: true, requiresDocumentNumber: true,
    requiresOwner: true, requiresApprover: true, allowsDraftRevision: true, auditRequired: true,
  }),
  TRANSLATION: workflow('TRANSLATION', 'Translation', 'Translation workflow', 'translation', 'DRAFT', 'PUBLISHED', {
    requiresReview: true, requiresApproval: true, requiresPublication: true, requiresVersionIncrement: true,
    requiresDocumentNumber: true, requiresOwner: true, requiresReviewer: true, requiresApprover: true,
    requiresPublishedSource: true, allowsDraftRevision: true, auditRequired: true,
  }),
  AI_GENERATED: workflow('AI_GENERATED', 'AI Generated', 'AI-generated content workflow', 'ai', 'DRAFT', 'PUBLISHED', {
    requiresReview: true, requiresApproval: true, requiresPublication: true, requiresVersionIncrement: true,
    requiresDocumentNumber: true, requiresOwner: true, requiresReviewer: true, requiresApprover: true,
    allowsDraftRevision: true, supportsRollback: true, auditRequired: true,
  }),
  CONTROLLED_COPY: workflow('CONTROLLED_COPY', 'Controlled Copy', 'Controlled-copy distribution workflow', 'controlled', 'APPROVED', 'PUBLISHED', {
    requiresPublication: true, requiresReadAcknowledgement: true, requiresDocumentNumber: true, requiresOwner: true,
    requiresPublishedSource: true, auditRequired: true,
  }),
  EMERGENCY_RELEASE: workflow('EMERGENCY_RELEASE', 'Emergency Release', 'Fast-tracked emergency release workflow', 'emergency', 'DRAFT', 'PUBLISHED', {
    requiresApproval: true, requiresPublication: true, requiresReadAcknowledgement: true, requiresVersionIncrement: true,
    requiresDocumentNumber: true, requiresOwner: true, requiresApprover: true, supportsEmergencyOverride: true, auditRequired: true,
  }),
  READ_ACKNOWLEDGEMENT: workflow('READ_ACKNOWLEDGEMENT', 'Read Acknowledgement', 'Read-acknowledgement workflow on a published document', 'compliance', 'PUBLISHED', 'PUBLISHED', {
    requiresReadAcknowledgement: true, requiresDocumentNumber: true, requiresOwner: true, requiresPublishedSource: true, auditRequired: true,
  }),
  ELECTRONIC_SIGNATURE: workflow('ELECTRONIC_SIGNATURE', 'Electronic Signature', 'Electronic-signature approval workflow', 'compliance', 'UNDER_APPROVAL', 'APPROVED', {
    requiresApproval: true, requiresElectronicSignature: true, requiresVersionIncrement: true, requiresDocumentNumber: true,
    requiresOwner: true, requiresApprover: true, auditRequired: true,
  }),
  PERIODIC_REVIEW: workflow('PERIODIC_REVIEW', 'Periodic Review', 'Scheduled review of a published document', 'quality', 'PUBLISHED', 'PUBLISHED', {
    requiresReview: true, requiresDocumentNumber: true, requiresOwner: true, requiresReviewer: true,
    requiresPublishedSource: true, allowsDraftRevision: true, auditRequired: true,
  }),
  CHANGE_MANAGEMENT: workflow('CHANGE_MANAGEMENT', 'Change Management', 'Controlled change-management workflow', 'controlled', 'DRAFT', 'PUBLISHED', {
    ...CONTROLLED, allowsParallelReview: true,
  }),
  OBSOLESCENCE: workflow('OBSOLESCENCE', 'Obsolescence', 'Mark a published document obsolete', 'archival', 'PUBLISHED', 'OBSOLETE', {
    requiresApproval: true, requiresDocumentNumber: true, requiresOwner: true, requiresApprover: true,
    requiresPublishedSource: true, auditRequired: true,
  }),
  ARCHIVAL: workflow('ARCHIVAL', 'Archival', 'Archive a published document', 'archival', 'PUBLISHED', 'ARCHIVED', {
    requiresApproval: true, requiresDocumentNumber: true, requiresOwner: true, requiresApprover: true,
    requiresPublishedSource: true, auditRequired: true,
  }),
});

const DOCUMENT_WORKFLOW_IDS = Object.freeze(Object.keys(DOCUMENT_WORKFLOWS));

// Safe, most-controlled fallback for an unrecognised workflow id (per D14 spec).
const SAFE_DEFAULT = deepFreeze(workflow('UNKNOWN', 'Unknown Workflow', 'Unrecognised workflow — most-controlled default', 'controlled', 'DRAFT', 'ARCHIVED', {
  requiresReview: true, requiresApproval: true, requiresPublication: true, requiresReadAcknowledgement: false,
  requiresElectronicSignature: false, requiresVersionIncrement: true, requiresDocumentNumber: true, requiresOwner: true,
  requiresReviewer: true, requiresApprover: true, requiresPublishedSource: false, allowsParallelReview: false,
  allowsDraftRevision: false, supportsRollback: false, supportsEmergencyOverride: false, auditRequired: true,
}));

// Deep copy — a fresh workflow object with a fresh futureReserved block.
function copyWorkflow(w) {
  return Object.assign({}, w, { futureReserved: Object.assign({}, w.futureReserved) });
}

function getDocumentWorkflow(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_WORKFLOWS, id);
  return copyWorkflow(known ? DOCUMENT_WORKFLOWS[id] : SAFE_DEFAULT);
}

function listDocumentWorkflows() {
  return DOCUMENT_WORKFLOW_IDS.map((k) => copyWorkflow(DOCUMENT_WORKFLOWS[k]));
}

function isKnownDocumentWorkflow(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_WORKFLOWS, id);
}

module.exports = {
  DOCUMENT_WORKFLOWS,
  DOCUMENT_WORKFLOW_IDS,
  getDocumentWorkflow,
  listDocumentWorkflows,
  isKnownDocumentWorkflow,
};
