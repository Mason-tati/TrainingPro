// WP-17 · D15 — Enterprise document validation-rule registry (document-management foundation).
//
// The immutable single source of truth for every document validation rule — its
// category, severity, and blocking / audit / approval / notification requirements —
// plus a reserved `futureReserved` extension block. Deep-frozen, copy-on-read (fresh
// objects), pure, dependency-free, CommonJS, never throws; unknown ids fall back to a
// safe, most-critical default. UNWIRED — nothing consumes it (no validation engine).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    validationPolicy: null,
    ruleEnginePolicy: null,
    workflowPolicy: null,
    notificationPolicy: null,
    approvalPolicy: null,
    aiPolicy: null,
    integrationPolicy: null,
    overridePolicy: null,
    reportingPolicy: null,
    extensionPolicy: null,
  };
}

// Build a validation rule. `v` carries the boolean flags; category/severity explicit.
function validation(id, displayName, description, category, severity, v) {
  return {
    id,
    displayName,
    description,
    category,
    severity,
    blocking: !!v.blocking,
    requiresAudit: !!v.requiresAudit,
    requiresApproval: !!v.requiresApproval,
    requiresNotification: !!v.requiresNotification,
    futureReserved: reserved(),
  };
}

const DOCUMENT_VALIDATION = deepFreeze({
  NONE: validation('NONE', 'None', 'No validation', 'none', 'info', {}),
  DOCUMENT_NUMBER_REQUIRED: validation('DOCUMENT_NUMBER_REQUIRED', 'Document Number Required', 'A document number is required', 'metadata', 'error', {
    blocking: true, requiresAudit: true,
  }),
  TITLE_REQUIRED: validation('TITLE_REQUIRED', 'Title Required', 'A title is required', 'metadata', 'error', {
    blocking: true, requiresAudit: true,
  }),
  DESCRIPTION_REQUIRED: validation('DESCRIPTION_REQUIRED', 'Description Required', 'A description is required', 'metadata', 'warning', {}),
  OWNER_REQUIRED: validation('OWNER_REQUIRED', 'Owner Required', 'An owner is required', 'metadata', 'error', {
    blocking: true, requiresAudit: true,
  }),
  AUTHOR_REQUIRED: validation('AUTHOR_REQUIRED', 'Author Required', 'An author is required', 'metadata', 'warning', {}),
  REVIEWER_REQUIRED: validation('REVIEWER_REQUIRED', 'Reviewer Required', 'A reviewer is required', 'workflow', 'error', {
    blocking: true, requiresAudit: true, requiresNotification: true,
  }),
  APPROVER_REQUIRED: validation('APPROVER_REQUIRED', 'Approver Required', 'An approver is required', 'approval', 'error', {
    blocking: true, requiresAudit: true, requiresApproval: true, requiresNotification: true,
  }),
  VERSION_REQUIRED: validation('VERSION_REQUIRED', 'Version Required', 'A version is required', 'metadata', 'error', {
    blocking: true, requiresAudit: true,
  }),
  STATUS_REQUIRED: validation('STATUS_REQUIRED', 'Status Required', 'A status is required', 'workflow', 'error', {
    blocking: true, requiresAudit: true,
  }),
  WORKFLOW_REQUIRED: validation('WORKFLOW_REQUIRED', 'Workflow Required', 'A workflow is required', 'workflow', 'error', {
    blocking: true, requiresAudit: true,
  }),
  CATEGORY_REQUIRED: validation('CATEGORY_REQUIRED', 'Category Required', 'A category is required', 'metadata', 'warning', {}),
  TYPE_REQUIRED: validation('TYPE_REQUIRED', 'Type Required', 'A document type is required', 'metadata', 'error', {
    blocking: true, requiresAudit: true,
  }),
  CLASSIFICATION_REQUIRED: validation('CLASSIFICATION_REQUIRED', 'Classification Required', 'A classification is required', 'security', 'error', {
    blocking: true, requiresAudit: true, requiresApproval: true,
  }),
  RETENTION_REQUIRED: validation('RETENTION_REQUIRED', 'Retention Required', 'A retention policy is required', 'compliance', 'error', {
    blocking: true, requiresAudit: true,
  }),
  ACCESS_REQUIRED: validation('ACCESS_REQUIRED', 'Access Required', 'An access mode is required', 'security', 'error', {
    blocking: true, requiresAudit: true, requiresApproval: true,
  }),
  STORAGE_REQUIRED: validation('STORAGE_REQUIRED', 'Storage Required', 'A storage mode is required', 'storage', 'error', {
    blocking: true, requiresAudit: true,
  }),
  PUBLISHING_REQUIRED: validation('PUBLISHING_REQUIRED', 'Publishing Required', 'A publishing mode is required', 'publication', 'error', {
    blocking: true, requiresAudit: true, requiresApproval: true,
  }),
  NOTIFICATION_REQUIRED: validation('NOTIFICATION_REQUIRED', 'Notification Required', 'A notification is required', 'workflow', 'info', {
    requiresNotification: true,
  }),
  RELATIONSHIP_REQUIRED: validation('RELATIONSHIP_REQUIRED', 'Relationship Required', 'A relationship is required', 'relationship', 'warning', {}),
  METADATA_REQUIRED: validation('METADATA_REQUIRED', 'Metadata Required', 'Required metadata is missing', 'metadata', 'error', {
    blocking: true, requiresAudit: true,
  }),
  ATTACHMENT_REQUIRED: validation('ATTACHMENT_REQUIRED', 'Attachment Required', 'An attachment is required', 'content', 'warning', {}),
  READ_ACKNOWLEDGEMENT_REQUIRED: validation('READ_ACKNOWLEDGEMENT_REQUIRED', 'Read Acknowledgement Required', 'A read acknowledgement is required', 'compliance', 'error', {
    blocking: true, requiresAudit: true, requiresApproval: true, requiresNotification: true,
  }),
  SIGNATURE_REQUIRED: validation('SIGNATURE_REQUIRED', 'Signature Required', 'An electronic signature is required', 'approval', 'critical', {
    blocking: true, requiresAudit: true, requiresApproval: true, requiresNotification: true,
  }),
  TRANSLATION_REQUIRED: validation('TRANSLATION_REQUIRED', 'Translation Required', 'A translation is required', 'translation', 'warning', {}),
  AI_REVIEW_REQUIRED: validation('AI_REVIEW_REQUIRED', 'AI Review Required', 'AI-generated content requires review', 'ai', 'error', {
    blocking: true, requiresAudit: true, requiresNotification: true,
  }),
  FILE_FORMAT_VALIDATION: validation('FILE_FORMAT_VALIDATION', 'File Format Validation', 'The file format must be allowed', 'content', 'error', {
    blocking: true, requiresAudit: true,
  }),
  FILE_SIZE_VALIDATION: validation('FILE_SIZE_VALIDATION', 'File Size Validation', 'The file size must be within limits', 'storage', 'warning', {}),
  CHECKSUM_VALIDATION: validation('CHECKSUM_VALIDATION', 'Checksum Validation', 'The file checksum must match', 'security', 'critical', {
    blocking: true, requiresAudit: true,
  }),
  VIRUS_SCAN_VALIDATION: validation('VIRUS_SCAN_VALIDATION', 'Virus Scan Validation', 'The file must pass a virus scan', 'security', 'critical', {
    blocking: true, requiresAudit: true, requiresNotification: true,
  }),
  DUPLICATE_VALIDATION: validation('DUPLICATE_VALIDATION', 'Duplicate Validation', 'The document must not be a duplicate', 'content', 'warning', {}),
});

const DOCUMENT_VALIDATION_IDS = Object.freeze(Object.keys(DOCUMENT_VALIDATION));

// Safe, most-critical fallback for an unrecognised validation id (per D15 spec).
const SAFE_DEFAULT = deepFreeze(validation('UNKNOWN', 'Unknown Validation', 'Unrecognised validation — most-critical default', 'compliance', 'critical', {
  blocking: true, requiresAudit: true, requiresApproval: true, requiresNotification: false,
}));

// Deep copy — a fresh validation object with a fresh futureReserved block.
function copyValidation(v) {
  return Object.assign({}, v, { futureReserved: Object.assign({}, v.futureReserved) });
}

function getDocumentValidation(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_VALIDATION, id);
  return copyValidation(known ? DOCUMENT_VALIDATION[id] : SAFE_DEFAULT);
}

function listDocumentValidations() {
  return DOCUMENT_VALIDATION_IDS.map((k) => copyValidation(DOCUMENT_VALIDATION[k]));
}

function isKnownDocumentValidation(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_VALIDATION, id);
}

module.exports = {
  DOCUMENT_VALIDATION,
  DOCUMENT_VALIDATION_IDS,
  getDocumentValidation,
  listDocumentValidations,
  isKnownDocumentValidation,
};
