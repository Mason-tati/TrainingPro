// WP-18 · E7 — Metadata policy registry (Enterprise Document Engine).
//
// An immutable registry of metadata policies, one per document type. Follows the WP-17
// registry pattern: a deep-frozen map + frozen id list, copy-on-read accessors that return
// fresh objects and fresh nested arrays, a boolean membership test, and a most-restrictive
// UNKNOWN safe default that is NOT a registry member. Pure and dependency-free — imports
// nothing. Never throws. UNWIRED — nothing in production consumes it.
'use strict';

function deepFreeze(value) {
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    return Object.freeze(value);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = clone(value[k]);
    return out;
  }
  return value;
}

// Neutral, permissive defaults. Individual policies tighten only what they restrict.
const BASE = {
  id: '',
  displayName: '',
  description: '',
  requiredFields: ['Title'],
  optionalFields: [],
  readOnlyFields: [],
  inheritFields: [],
  allowedCustomFields: ['*'], // '*' = any custom field key permitted; [] = none
  allowUnknownFields: false,
  allowReservedFields: false,
  requireOwner: false,
  requireAuthor: false,
  requireDepartment: false,
  requireSite: false,
  requireReviewDate: false,
  requireEffectiveDate: false,
  requireClassification: false,
  requireCompliance: false,
  requireLanguage: false,
  requireVersion: false,
  futureReserved: [],
};

const READONLY_SYSTEM = ['CreatedBy', 'CreatedDate', 'UpdatedBy', 'UpdatedDate'];

// Most-restrictive safe default. NOT a registry member; isKnownMetadataPolicy('UNKNOWN') is false.
const UNKNOWN_POLICY = deepFreeze({
  ...BASE,
  id: 'UNKNOWN',
  displayName: 'Unknown Policy',
  description: 'Safe default: the most restrictive policy, applied to unrecognised document types.',
  requiredFields: ['Title', 'Owner', 'Author', 'Department', 'Site', 'Classification', 'EffectiveDate', 'ReviewDate', 'ComplianceFramework', 'Language', 'Version'],
  readOnlyFields: READONLY_SYSTEM.slice(),
  allowedCustomFields: [],
  allowUnknownFields: false,
  allowReservedFields: false,
  requireOwner: true,
  requireAuthor: true,
  requireDepartment: true,
  requireSite: true,
  requireReviewDate: true,
  requireEffectiveDate: true,
  requireClassification: true,
  requireCompliance: true,
  requireLanguage: true,
  requireVersion: true,
});

const METADATA_POLICIES = deepFreeze({
  NONE: {
    ...BASE, id: 'NONE', displayName: 'No Policy', description: 'Minimal metadata expectations.',
    requiredFields: ['Title'], allowUnknownFields: true, allowedCustomFields: ['*'],
  },
  CONTROLLED_DOCUMENT: {
    ...BASE, id: 'CONTROLLED_DOCUMENT', displayName: 'Controlled Document', description: 'Formally controlled, audited document.',
    requiredFields: ['Title', 'Owner', 'Department', 'Classification', 'EffectiveDate', 'ReviewDate', 'Version'],
    optionalFields: ['Description', 'Author', 'Site', 'ComplianceFramework', 'Language'],
    readOnlyFields: READONLY_SYSTEM.slice(), inheritFields: ['Department', 'Site', 'Classification', 'ComplianceFramework'],
    allowedCustomFields: [], allowUnknownFields: false,
    requireOwner: true, requireDepartment: true, requireClassification: true, requireEffectiveDate: true, requireReviewDate: true, requireVersion: true,
  },
  WORK_INSTRUCTION: {
    ...BASE, id: 'WORK_INSTRUCTION', displayName: 'Work Instruction', description: 'Task-level work instruction.',
    requiredFields: ['Title', 'Owner', 'Department', 'Version'], optionalFields: ['Site', 'Equipment', 'Classification'],
    readOnlyFields: READONLY_SYSTEM.slice(), inheritFields: ['Department', 'Site'], allowUnknownFields: false,
    requireOwner: true, requireDepartment: true, requireVersion: true,
  },
  STANDARD_OPERATING_PROCEDURE: {
    ...BASE, id: 'STANDARD_OPERATING_PROCEDURE', displayName: 'Standard Operating Procedure', description: 'Controlled SOP.',
    requiredFields: ['Title', 'Owner', 'Department', 'Classification', 'EffectiveDate', 'ReviewDate', 'Version'],
    readOnlyFields: READONLY_SYSTEM.slice(), inheritFields: ['Department', 'Site', 'Classification'], allowedCustomFields: [], allowUnknownFields: false,
    requireOwner: true, requireDepartment: true, requireClassification: true, requireEffectiveDate: true, requireReviewDate: true, requireVersion: true,
  },
  POLICY: {
    ...BASE, id: 'POLICY', displayName: 'Policy', description: 'Organisational policy document.',
    requiredFields: ['Title', 'Owner', 'Classification', 'EffectiveDate', 'ReviewDate', 'Version'],
    readOnlyFields: READONLY_SYSTEM.slice(), inheritFields: ['Classification', 'ComplianceFramework'], allowUnknownFields: false,
    requireOwner: true, requireClassification: true, requireEffectiveDate: true, requireReviewDate: true, requireVersion: true,
  },
  PROCEDURE: {
    ...BASE, id: 'PROCEDURE', displayName: 'Procedure', description: 'Operational procedure.',
    requiredFields: ['Title', 'Owner', 'Department', 'Version'], readOnlyFields: READONLY_SYSTEM.slice(),
    inheritFields: ['Department', 'Site'], allowUnknownFields: false,
    requireOwner: true, requireDepartment: true, requireVersion: true,
  },
  FORM: {
    ...BASE, id: 'FORM', displayName: 'Form', description: 'Fillable form.',
    requiredFields: ['Title', 'Owner'], optionalFields: ['Department', 'Site'], allowUnknownFields: true, allowedCustomFields: ['*'],
    requireOwner: true,
  },
  CHECKLIST: {
    ...BASE, id: 'CHECKLIST', displayName: 'Checklist', description: 'Operational checklist.',
    requiredFields: ['Title', 'Owner'], optionalFields: ['Department', 'Site'], allowUnknownFields: true, allowedCustomFields: ['*'],
    requireOwner: true,
  },
  RISK_ASSESSMENT: {
    ...BASE, id: 'RISK_ASSESSMENT', displayName: 'Risk Assessment', description: 'Risk assessment record.',
    requiredFields: ['Title', 'Owner', 'Department', 'Classification', 'ReviewDate'], readOnlyFields: READONLY_SYSTEM.slice(),
    inheritFields: ['Department', 'Site'], allowedCustomFields: [], allowUnknownFields: false,
    requireOwner: true, requireDepartment: true, requireClassification: true, requireReviewDate: true,
  },
  TRAINING: {
    ...BASE, id: 'TRAINING', displayName: 'Training Material', description: 'Training content.',
    requiredFields: ['Title', 'Owner', 'Language'], optionalFields: ['Department', 'Site', 'Version'], allowedCustomFields: ['*'],
    requireOwner: true, requireLanguage: true,
  },
  PRESENTATION: {
    ...BASE, id: 'PRESENTATION', displayName: 'Presentation', description: 'Slide deck / presentation.',
    requiredFields: ['Title', 'Author'], optionalFields: ['Owner', 'Department'], allowUnknownFields: true, allowedCustomFields: ['*'],
    requireAuthor: true,
  },
  ASSESSMENT: {
    ...BASE, id: 'ASSESSMENT', displayName: 'Assessment', description: 'Assessment / examination.',
    requiredFields: ['Title', 'Owner', 'Language'], optionalFields: ['Department'], allowedCustomFields: [],
    requireOwner: true, requireLanguage: true,
  },
  REFERENCE: {
    ...BASE, id: 'REFERENCE', displayName: 'Reference', description: 'Reference material.',
    requiredFields: ['Title'], allowUnknownFields: true, allowedCustomFields: ['*'],
  },
  TRANSLATION: {
    ...BASE, id: 'TRANSLATION', displayName: 'Translation', description: 'Translated document.',
    requiredFields: ['Title', 'Language', 'Owner'], readOnlyFields: READONLY_SYSTEM.slice(),
    inheritFields: ['Department', 'Site', 'Classification', 'ComplianceFramework'], allowUnknownFields: false,
    requireOwner: true, requireLanguage: true,
  },
  AI_GENERATED: {
    ...BASE, id: 'AI_GENERATED', displayName: 'AI-Generated Document', description: 'Document produced with AI assistance.',
    requiredFields: ['Title', 'Author'], readOnlyFields: READONLY_SYSTEM.slice(), allowUnknownFields: true, allowReservedFields: false, allowedCustomFields: ['*'],
    requireAuthor: true, futureReserved: ['AIProvenance', 'ModelVersion', 'PromptDigest'],
  },
  TEMPLATE: {
    ...BASE, id: 'TEMPLATE', displayName: 'Template', description: 'Reusable document template.',
    requiredFields: ['Title'], inheritFields: ['Department', 'Site', 'Classification', 'ComplianceFramework', 'Language'],
    allowUnknownFields: true, allowedCustomFields: ['*'],
  },
  ARCHIVE: {
    ...BASE, id: 'ARCHIVE', displayName: 'Archived Document', description: 'Read-only archived record.',
    requiredFields: ['Title'],
    readOnlyFields: ['Title', 'Owner', 'Department', 'Site', 'Classification', 'EffectiveDate', 'ReviewDate', 'ExpiryDate', 'Version', 'Revision', ...READONLY_SYSTEM],
    allowUnknownFields: false, allowReservedFields: true, allowedCustomFields: ['*'],
  },
  CUSTOM: {
    ...BASE, id: 'CUSTOM', displayName: 'Custom Document', description: 'User-defined document with flexible metadata.',
    requiredFields: ['Title'], inheritFields: ['Department', 'Site'], allowUnknownFields: true, allowReservedFields: true, allowedCustomFields: ['*'],
  },
});

const METADATA_POLICY_IDS = Object.freeze(Object.keys(METADATA_POLICIES));

function isKnownMetadataPolicy(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(METADATA_POLICIES, id);
}

// Copy-on-read: returns a fresh object with fresh nested arrays every call.
function getMetadataPolicy(id) {
  const source = isKnownMetadataPolicy(id) ? METADATA_POLICIES[id] : UNKNOWN_POLICY;
  return clone(source);
}

function listMetadataPolicies() {
  return METADATA_POLICY_IDS.map((id) => clone(METADATA_POLICIES[id]));
}

module.exports = {
  METADATA_POLICIES,
  METADATA_POLICY_IDS,
  getMetadataPolicy,
  listMetadataPolicies,
  isKnownMetadataPolicy,
};
