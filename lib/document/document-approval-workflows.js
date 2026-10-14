// WP-17 · D6 — Enterprise document approval-workflow registry (document-management foundation).
//
// The immutable single source of truth for document approval-workflow patterns (review,
// approval, safety-critical, HR, AI, external, lifecycle, emergency). Each entry declares
// its required approval level, roles/permissions, approver rules, gating flags, and the
// status transition it drives, plus a reserved `futureReserved` extension block.
// Deep-frozen, copy-on-read (fresh objects AND fresh arrays), pure, dependency-free,
// CommonJS, never throws; unknown ids fall back to a safe default. UNWIRED — nothing in
// production runtime imports or consumes it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

const CATEGORIES = Object.freeze(['none', 'review', 'approval', 'safety', 'hr', 'ai', 'external', 'lifecycle', 'emergency']);

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    notificationTemplate: null,
    escalationRule: null,
    delegationRule: null,
    signoffRule: null,
    evidenceRule: null,
    workflowEngineRule: null,
    integrationHook: null,
    slaPolicy: null,
    parallelPolicy: null,
    exceptionPolicy: null,
  };
}

// Build a workflow. `w` carries the approval level, roles/permissions arrays (always
// arrays), minApprovers, gating flags, and status transition — always explicit here.
function workflow(id, displayName, description, category, w) {
  return {
    id,
    displayName,
    description,
    category,
    requiredApprovalLevel: w.requiredApprovalLevel,
    requiredRoles: [...w.requiredRoles],
    requiredPermissions: [...w.requiredPermissions],
    minApprovers: w.minApprovers,
    allowSelfApproval: !!w.allowSelfApproval,
    allowParallelApproval: !!w.allowParallelApproval,
    allowDelegation: !!w.allowDelegation,
    requiresReview: !!w.requiresReview,
    requiresChangeSummary: !!w.requiresChangeSummary,
    requiresEffectiveDate: !!w.requiresEffectiveDate,
    requiresExpiryDate: !!w.requiresExpiryDate,
    requiresReadAcknowledgement: !!w.requiresReadAcknowledgement,
    requiresElectronicSignature: !!w.requiresElectronicSignature,
    requiresAudit: !!w.requiresAudit,
    requiresVersionIncrement: !!w.requiresVersionIncrement,
    requiresPublishedSource: !!w.requiresPublishedSource,
    defaultStatusBefore: w.defaultStatusBefore,
    defaultStatusAfter: w.defaultStatusAfter,
    futureReserved: reserved(),
  };
}

const DOCUMENT_APPROVAL_WORKFLOWS = deepFreeze({
  NONE: workflow('NONE', 'No Approval', 'No approval required; direct publish', 'none', {
    requiredApprovalLevel: 'NONE', requiredRoles: [], requiredPermissions: [], minApprovers: 0,
    allowSelfApproval: true, requiresAudit: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'PUBLISHED',
  }),
  SIMPLE_REVIEW: workflow('SIMPLE_REVIEW', 'Simple Review', 'Lightweight peer review', 'review', {
    requiredApprovalLevel: 'NONE', requiredRoles: [], requiredPermissions: ['document.review'], minApprovers: 1,
    requiresReview: true, requiresAudit: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'IN_REVIEW',
  }),
  SUPERVISOR_APPROVAL: workflow('SUPERVISOR_APPROVAL', 'Supervisor Approval', 'Approval by a supervisor', 'approval', {
    requiredApprovalLevel: 'SUPERVISOR', requiredRoles: ['SUPERVISOR'], requiredPermissions: ['document.approve'], minApprovers: 1,
    requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true, requiresAudit: true,
    requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  TRAINING_MANAGER_APPROVAL: workflow('TRAINING_MANAGER_APPROVAL', 'Training Manager Approval', 'Approval by a training manager', 'approval', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['TRAINING_MANAGER'], requiredPermissions: ['document.approve'], minApprovers: 1,
    requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true, requiresAudit: true,
    requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  DOCUMENT_OWNER_APPROVAL: workflow('DOCUMENT_OWNER_APPROVAL', 'Document Owner Approval', 'Approval by the document owner', 'approval', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['DOCUMENT_OWNER'], requiredPermissions: ['document.approve'], minApprovers: 1,
    allowSelfApproval: true, requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true,
    requiresAudit: true, requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  HSEQ_APPROVAL: workflow('HSEQ_APPROVAL', 'HSEQ Approval', 'Approval by HSEQ / safety function', 'safety', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['SAFETY'], requiredPermissions: ['document.approve'], minApprovers: 1,
    requiresReview: true, requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true,
    requiresAudit: true, requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  MANAGER_APPROVAL: workflow('MANAGER_APPROVAL', 'Manager Approval', 'Approval by a manager', 'approval', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['MANAGER'], requiredPermissions: ['document.approve'], minApprovers: 1,
    allowDelegation: true, requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true,
    requiresAudit: true, requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  SITE_MANAGER_APPROVAL: workflow('SITE_MANAGER_APPROVAL', 'Site Manager Approval', 'Approval by a site manager', 'approval', {
    requiredApprovalLevel: 'SITE_MANAGER', requiredRoles: ['SITE_MANAGER'], requiredPermissions: ['document.approve'], minApprovers: 1,
    requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true, requiresAudit: true,
    requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  MULTI_LEVEL_APPROVAL: workflow('MULTI_LEVEL_APPROVAL', 'Multi-Level Approval', 'Sequential multi-level approval', 'approval', {
    requiredApprovalLevel: 'MULTI_LEVEL', requiredRoles: ['MANAGER', 'SITE_MANAGER'], requiredPermissions: ['document.approve'], minApprovers: 2,
    allowParallelApproval: true, requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true,
    requiresAudit: true, requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  SAFETY_CRITICAL_APPROVAL: workflow('SAFETY_CRITICAL_APPROVAL', 'Safety-Critical Approval', 'Approval for safety-critical documents', 'safety', {
    requiredApprovalLevel: 'SITE_MANAGER', requiredRoles: ['SAFETY', 'SITE_MANAGER'], requiredPermissions: ['document.approve'], minApprovers: 2,
    allowParallelApproval: true, requiresReview: true, requiresChangeSummary: true, requiresEffectiveDate: true,
    requiresReadAcknowledgement: true, requiresElectronicSignature: true, requiresAudit: true, requiresVersionIncrement: true,
    defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  HR_CONFIDENTIAL_APPROVAL: workflow('HR_CONFIDENTIAL_APPROVAL', 'HR Confidential Approval', 'Approval for HR-confidential documents', 'hr', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['HR'], requiredPermissions: ['document.approve'], minApprovers: 1,
    requiresChangeSummary: true, requiresEffectiveDate: true, requiresReadAcknowledgement: true, requiresElectronicSignature: true,
    requiresAudit: true, requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  AI_CONTENT_APPROVAL: workflow('AI_CONTENT_APPROVAL', 'AI Content Approval', 'Human verification of AI-generated content', 'ai', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['TRAINING_MANAGER'], requiredPermissions: ['document.approve', 'ai.verify'], minApprovers: 1,
    requiresReview: true, requiresChangeSummary: true, requiresAudit: true, requiresVersionIncrement: true,
    defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
  }),
  EXTERNAL_STANDARD_REVIEW: workflow('EXTERNAL_STANDARD_REVIEW', 'External Standard Review', 'Review of externally issued standards', 'external', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['MANAGER'], requiredPermissions: ['document.review'], minApprovers: 1,
    requiresReview: true, requiresEffectiveDate: true, requiresExpiryDate: true, requiresAudit: true,
    defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'IN_REVIEW',
  }),
  PERIODIC_REVIEW: workflow('PERIODIC_REVIEW', 'Periodic Review', 'Scheduled review of a published document', 'review', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['MANAGER'], requiredPermissions: ['document.review'], minApprovers: 1,
    requiresReview: true, requiresAudit: true, requiresPublishedSource: true,
    defaultStatusBefore: 'PUBLISHED', defaultStatusAfter: 'IN_REVIEW',
  }),
  EMERGENCY_CHANGE: workflow('EMERGENCY_CHANGE', 'Emergency Change', 'Fast-tracked emergency change', 'emergency', {
    requiredApprovalLevel: 'SITE_MANAGER', requiredRoles: ['SITE_MANAGER'], requiredPermissions: ['document.approve'], minApprovers: 1,
    allowDelegation: true, requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true,
    requiresAudit: true, requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'APPROVED',
  }),
  ARCHIVE_APPROVAL: workflow('ARCHIVE_APPROVAL', 'Archive Approval', 'Approval to archive a published document', 'lifecycle', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['MANAGER'], requiredPermissions: ['document.archive'], minApprovers: 1,
    requiresChangeSummary: true, requiresAudit: true, requiresPublishedSource: true,
    defaultStatusBefore: 'PUBLISHED', defaultStatusAfter: 'ARCHIVED',
  }),
  OBSOLETE_APPROVAL: workflow('OBSOLETE_APPROVAL', 'Obsolete Approval', 'Approval to mark a document obsolete', 'lifecycle', {
    requiredApprovalLevel: 'MANAGER', requiredRoles: ['MANAGER'], requiredPermissions: ['document.obsolete'], minApprovers: 1,
    requiresChangeSummary: true, requiresAudit: true, requiresPublishedSource: true,
    defaultStatusBefore: 'PUBLISHED', defaultStatusAfter: 'OBSOLETE',
  }),
});

const DOCUMENT_APPROVAL_WORKFLOW_IDS = Object.freeze(Object.keys(DOCUMENT_APPROVAL_WORKFLOWS));

// Safe default for an unrecognised workflow id (per D6 specification).
const SAFE_DEFAULT = deepFreeze(workflow('UNKNOWN', 'Unknown Approval Workflow', 'Unrecognised approval workflow — safe default', 'approval', {
  requiredApprovalLevel: 'MANAGER', requiredRoles: [], requiredPermissions: [], minApprovers: 1,
  requiresReview: true, requiresChangeSummary: true, requiresEffectiveDate: true, requiresElectronicSignature: true,
  requiresAudit: true, requiresVersionIncrement: true, defaultStatusBefore: 'DRAFT', defaultStatusAfter: 'UNDER_APPROVAL',
}));

// Deep copy — fresh workflow with fresh roles/permissions arrays + fresh futureReserved.
function copyWorkflow(w) {
  return Object.assign({}, w, {
    requiredRoles: [...w.requiredRoles],
    requiredPermissions: [...w.requiredPermissions],
    futureReserved: Object.assign({}, w.futureReserved),
  });
}

function getDocumentApprovalWorkflow(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_APPROVAL_WORKFLOWS, id);
  return copyWorkflow(known ? DOCUMENT_APPROVAL_WORKFLOWS[id] : SAFE_DEFAULT);
}

function listDocumentApprovalWorkflows() {
  return DOCUMENT_APPROVAL_WORKFLOW_IDS.map((k) => copyWorkflow(DOCUMENT_APPROVAL_WORKFLOWS[k]));
}

function isKnownDocumentApprovalWorkflow(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_APPROVAL_WORKFLOWS, id);
}

module.exports = {
  DOCUMENT_APPROVAL_WORKFLOWS,
  DOCUMENT_APPROVAL_WORKFLOW_IDS,
  getDocumentApprovalWorkflow,
  listDocumentApprovalWorkflows,
  isKnownDocumentApprovalWorkflow,
};
