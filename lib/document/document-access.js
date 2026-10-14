// WP-17 · D11 — Enterprise document access-control registry (document-management foundation).
//
// The immutable single source of truth for the future document access model — the
// read/write/lifecycle capabilities and access preconditions of each access mode
// (public, authenticated, owner, editor, approver, admin, system, AI agent, …), plus a
// reserved `futureReserved` extension block. Deep-frozen, copy-on-read (fresh objects),
// pure, dependency-free, CommonJS, never throws; unknown ids fall back to a safe,
// deny-by-default mode. UNWIRED — nothing consumes it (no RBAC/enforcement integration).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    workflowPolicy: null,
    ownershipPolicy: null,
    approvalPolicy: null,
    translationPolicy: null,
    relationshipPolicy: null,
    metadataPolicy: null,
    exportPolicy: null,
    trainingPolicy: null,
    assessmentPolicy: null,
    integrationPolicy: null,
  };
}

// Build an access mode. `a` carries the can*/requires* boolean flags; always explicit.
function access(id, displayName, description, category, a) {
  return {
    id,
    displayName,
    description,
    category,
    canRead: !!a.canRead,
    canCreate: !!a.canCreate,
    canEdit: !!a.canEdit,
    canDelete: !!a.canDelete,
    canReview: !!a.canReview,
    canApprove: !!a.canApprove,
    canPublish: !!a.canPublish,
    canArchive: !!a.canArchive,
    canRestore: !!a.canRestore,
    canSupersede: !!a.canSupersede,
    canTranslate: !!a.canTranslate,
    canExport: !!a.canExport,
    canPrint: !!a.canPrint,
    canDownload: !!a.canDownload,
    canAssignTraining: !!a.canAssignTraining,
    canAssignAssessment: !!a.canAssignAssessment,
    canManageRelationships: !!a.canManageRelationships,
    canManageMetadata: !!a.canManageMetadata,
    requiresAuthentication: !!a.requiresAuthentication,
    requiresOwnership: !!a.requiresOwnership,
    requiresApprovalRole: !!a.requiresApprovalRole,
    requiresPublishedDocument: !!a.requiresPublishedDocument,
    requiresActiveEmployment: !!a.requiresActiveEmployment,
    futureReserved: reserved(),
  };
}

// Full capability set (all can* true) shared by super-user modes.
const ALL_CAN = {
  canRead: true, canCreate: true, canEdit: true, canDelete: true, canReview: true, canApprove: true,
  canPublish: true, canArchive: true, canRestore: true, canSupersede: true, canTranslate: true,
  canExport: true, canPrint: true, canDownload: true, canAssignTraining: true, canAssignAssessment: true,
  canManageRelationships: true, canManageMetadata: true,
};

const DOCUMENT_ACCESS = deepFreeze({
  NONE: access('NONE', 'No Access', 'No access to the document', 'none', {}),
  PUBLIC: access('PUBLIC', 'Public', 'Public read access', 'public', {
    canRead: true, canPrint: true, canDownload: true,
  }),
  AUTHENTICATED: access('AUTHENTICATED', 'Authenticated', 'Any authenticated user', 'authenticated', {
    canRead: true, canExport: true, canPrint: true, canDownload: true, requiresAuthentication: true,
  }),
  EMPLOYEE: access('EMPLOYEE', 'Employee', 'Active employee access', 'employment', {
    canRead: true, canPrint: true, canDownload: true, requiresAuthentication: true, requiresActiveEmployment: true,
  }),
  CONTRACTOR: access('CONTRACTOR', 'Contractor', 'Contractor access', 'employment', {
    canRead: true, canDownload: true, requiresAuthentication: true,
  }),
  OWNER: access('OWNER', 'Owner', 'Document owner', 'ownership', {
    canRead: true, canCreate: true, canEdit: true, canDelete: true, canTranslate: true, canExport: true,
    canPrint: true, canDownload: true, canManageRelationships: true, canManageMetadata: true,
    requiresAuthentication: true, requiresOwnership: true,
  }),
  AUTHOR: access('AUTHOR', 'Author', 'Document author', 'editing', {
    canRead: true, canCreate: true, canEdit: true, canExport: true, canPrint: true, canDownload: true, canManageMetadata: true,
    requiresAuthentication: true,
  }),
  EDITOR: access('EDITOR', 'Editor', 'Document editor', 'editing', {
    canRead: true, canEdit: true, canTranslate: true, canExport: true, canPrint: true, canDownload: true,
    canManageRelationships: true, canManageMetadata: true, requiresAuthentication: true,
  }),
  REVIEWER: access('REVIEWER', 'Reviewer', 'Document reviewer', 'review', {
    canRead: true, canReview: true, canExport: true, canPrint: true, canDownload: true, requiresAuthentication: true,
  }),
  APPROVER: access('APPROVER', 'Approver', 'Document approver', 'approval', {
    canRead: true, canReview: true, canApprove: true, canExport: true, canPrint: true, canDownload: true,
    requiresAuthentication: true, requiresApprovalRole: true,
  }),
  PUBLISHER: access('PUBLISHER', 'Publisher', 'Document publisher', 'publishing', {
    canRead: true, canPublish: true, canArchive: true, canSupersede: true, canExport: true, canPrint: true, canDownload: true,
    requiresAuthentication: true, requiresApprovalRole: true, requiresPublishedDocument: true,
  }),
  TRAINER: access('TRAINER', 'Trainer', 'Training assignment access', 'training', {
    canRead: true, canAssignTraining: true, canExport: true, canPrint: true, canDownload: true, requiresAuthentication: true,
  }),
  ASSESSOR: access('ASSESSOR', 'Assessor', 'Assessment assignment access', 'assessment', {
    canRead: true, canAssignAssessment: true, canExport: true, canPrint: true, canDownload: true, requiresAuthentication: true,
  }),
  SUPERVISOR: access('SUPERVISOR', 'Supervisor', 'Supervisor access', 'management', {
    canRead: true, canReview: true, canAssignTraining: true, canExport: true, canPrint: true, canDownload: true, requiresAuthentication: true,
  }),
  MANAGER: access('MANAGER', 'Manager', 'Manager access', 'management', {
    canRead: true, canReview: true, canApprove: true, canPublish: true, canAssignTraining: true, canAssignAssessment: true,
    canExport: true, canPrint: true, canDownload: true, requiresAuthentication: true, requiresApprovalRole: true,
  }),
  HSEQ: access('HSEQ', 'HSEQ', 'HSEQ access', 'management', {
    canRead: true, canReview: true, canApprove: true, canExport: true, canPrint: true, canDownload: true,
    requiresAuthentication: true, requiresApprovalRole: true,
  }),
  HR: access('HR', 'HR', 'HR access', 'management', {
    canRead: true, canReview: true, canExport: true, canPrint: true, canDownload: true, requiresAuthentication: true,
  }),
  ADMIN: access('ADMIN', 'Administrator', 'Administrator — full access', 'administration', {
    ...ALL_CAN, requiresAuthentication: true,
  }),
  SYSTEM: access('SYSTEM', 'System', 'Internal system access', 'system', {
    ...ALL_CAN,
  }),
  AI_AGENT: access('AI_AGENT', 'AI Agent', 'AI agent draft/generation access', 'ai', {
    canRead: true, canCreate: true, canEdit: true, canTranslate: true, canManageMetadata: true, requiresAuthentication: true,
  }),
  CONTROLLED_DOCUMENT: access('CONTROLLED_DOCUMENT', 'Controlled Document', 'Controlled-copy read access', 'controlled', {
    canRead: true, canPrint: true, canDownload: true,
    requiresAuthentication: true, requiresPublishedDocument: true, requiresActiveEmployment: true,
  }),
  READ_ONLY: access('READ_ONLY', 'Read Only', 'Read-only access', 'controlled', {
    canRead: true, requiresAuthentication: true,
  }),
});

const DOCUMENT_ACCESS_IDS = Object.freeze(Object.keys(DOCUMENT_ACCESS));

// Safe, deny-by-default fallback for an unrecognised access mode (per D11 spec).
const SAFE_DEFAULT = deepFreeze(access('UNKNOWN', 'Unknown Access', 'Unrecognised access mode — deny-by-default', 'controlled', {
  requiresAuthentication: true, requiresOwnership: false, requiresApprovalRole: true,
  requiresPublishedDocument: false, requiresActiveEmployment: true,
}));

// Deep copy — a fresh access object with a fresh futureReserved block.
function copyAccess(a) {
  return Object.assign({}, a, { futureReserved: Object.assign({}, a.futureReserved) });
}

function getDocumentAccess(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_ACCESS, id);
  return copyAccess(known ? DOCUMENT_ACCESS[id] : SAFE_DEFAULT);
}

function listDocumentAccess() {
  return DOCUMENT_ACCESS_IDS.map((k) => copyAccess(DOCUMENT_ACCESS[k]));
}

function isKnownDocumentAccess(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_ACCESS, id);
}

module.exports = {
  DOCUMENT_ACCESS,
  DOCUMENT_ACCESS_IDS,
  getDocumentAccess,
  listDocumentAccess,
  isKnownDocumentAccess,
};
