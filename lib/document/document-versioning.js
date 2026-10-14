// WP-17 · D8 — Enterprise document versioning registry (document-management foundation).
//
// The immutable single source of truth for the supported document versioning schemes
// (semantic, major/minor, revision, controlled, ISO, training, AI, etc.) and their
// version-control policy flags, plus a reserved `futureReserved` extension block.
// Deep-frozen, copy-on-read (fresh objects), pure, dependency-free, CommonJS, never
// throws; unknown ids fall back to a safe default. UNWIRED — nothing consumes it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    mergePolicy: null,
    branchPolicy: null,
    conflictPolicy: null,
    retentionPolicy: null,
    approvalPolicy: null,
    aiPolicy: null,
    workflowPolicy: null,
    numberingPolicy: null,
    integrationPolicy: null,
    storagePolicy: null,
  };
}

// Build a versioning scheme. `f` carries the policy flags; always an explicit object.
function scheme(id, displayName, description, f) {
  return {
    id,
    displayName,
    description,
    majorSupported: !!f.majorSupported,
    minorSupported: !!f.minorSupported,
    patchSupported: !!f.patchSupported,
    revisionSupported: !!f.revisionSupported,
    allowRollback: !!f.allowRollback,
    allowParallelVersions: !!f.allowParallelVersions,
    allowDraftBranch: !!f.allowDraftBranch,
    requireApprovalOnMajor: !!f.requireApprovalOnMajor,
    requireApprovalOnMinor: !!f.requireApprovalOnMinor,
    requireApprovalOnPatch: !!f.requireApprovalOnPatch,
    requireReviewOnRevision: !!f.requireReviewOnRevision,
    trackChangeHistory: !!f.trackChangeHistory,
    trackAuthorHistory: !!f.trackAuthorHistory,
    trackApprovalHistory: !!f.trackApprovalHistory,
    trackReadHistory: !!f.trackReadHistory,
    trackRelationshipHistory: !!f.trackRelationshipHistory,
    supportsEffectiveDate: !!f.supportsEffectiveDate,
    supportsExpiryDate: !!f.supportsExpiryDate,
    supportsObsoleteDate: !!f.supportsObsoleteDate,
    futureReserved: reserved(),
  };
}

const DOCUMENT_VERSIONING = deepFreeze({
  NONE: scheme('NONE', 'No Versioning', 'No versioning applied', {}),
  SEMANTIC: scheme('SEMANTIC', 'Semantic Versioning', 'Semantic major.minor.patch versioning', {
    majorSupported: true, minorSupported: true, patchSupported: true, allowRollback: true, allowDraftBranch: true,
    requireApprovalOnMajor: true, trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, supportsEffectiveDate: true,
  }),
  MAJOR_MINOR: scheme('MAJOR_MINOR', 'Major/Minor Versioning', 'Two-part major.minor versioning', {
    majorSupported: true, minorSupported: true, allowRollback: true, requireApprovalOnMajor: true,
    trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, supportsEffectiveDate: true,
  }),
  MAJOR_MINOR_PATCH: scheme('MAJOR_MINOR_PATCH', 'Major/Minor/Patch Versioning', 'Three-part major.minor.patch versioning', {
    majorSupported: true, minorSupported: true, patchSupported: true, allowRollback: true, allowDraftBranch: true,
    requireApprovalOnMajor: true, trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, supportsEffectiveDate: true,
  }),
  REVISION: scheme('REVISION', 'Revision Versioning', 'Sequential revision-letter/number versioning', {
    revisionSupported: true, requireReviewOnRevision: true, trackChangeHistory: true, trackAuthorHistory: true,
  }),
  CONTROLLED_DOCUMENT: scheme('CONTROLLED_DOCUMENT', 'Controlled Document', 'Controlled-document version control with full history', {
    majorSupported: true, minorSupported: true, revisionSupported: true, allowRollback: true, allowDraftBranch: true,
    requireApprovalOnMajor: true, requireApprovalOnMinor: true, requireReviewOnRevision: true,
    trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, trackReadHistory: true, trackRelationshipHistory: true,
    supportsEffectiveDate: true, supportsExpiryDate: true, supportsObsoleteDate: true,
  }),
  ISO_DOCUMENT: scheme('ISO_DOCUMENT', 'ISO Controlled Document', 'ISO-style controlled document versioning', {
    majorSupported: true, minorSupported: true, revisionSupported: true, allowRollback: true, allowDraftBranch: true,
    requireApprovalOnMajor: true, requireApprovalOnMinor: true, requireApprovalOnPatch: true, requireReviewOnRevision: true,
    trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, trackReadHistory: true, trackRelationshipHistory: true,
    supportsEffectiveDate: true, supportsExpiryDate: true, supportsObsoleteDate: true,
  }),
  TRAINING_CONTENT: scheme('TRAINING_CONTENT', 'Training Content Versioning', 'Versioning for training and learning content', {
    majorSupported: true, minorSupported: true, patchSupported: true, allowRollback: true, allowParallelVersions: true, allowDraftBranch: true,
    requireApprovalOnMajor: true, trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, supportsEffectiveDate: true,
  }),
  AI_GENERATED: scheme('AI_GENERATED', 'AI Generated Versioning', 'Versioning for AI-assisted generated content', {
    majorSupported: true, minorSupported: true, revisionSupported: true, allowParallelVersions: true,
    requireApprovalOnMajor: true, requireReviewOnRevision: true, trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, supportsEffectiveDate: true,
  }),
  REFERENCE_ONLY: scheme('REFERENCE_ONLY', 'Reference Only', 'Minimal revision tracking for reference material', {
    revisionSupported: true, trackChangeHistory: true,
  }),
  ARCHIVED: scheme('ARCHIVED', 'Archived', 'Frozen archived document; no new versions', {
    trackChangeHistory: true, trackAuthorHistory: true, supportsObsoleteDate: true,
  }),
});

const DOCUMENT_VERSIONING_IDS = Object.freeze(Object.keys(DOCUMENT_VERSIONING));

// Safe default for an unrecognised versioning id (per D8 specification).
const SAFE_DEFAULT = deepFreeze(scheme('UNKNOWN', 'Unknown Versioning', 'Unrecognised versioning scheme — safe default', {
  majorSupported: true, minorSupported: true, patchSupported: false, revisionSupported: true,
  allowRollback: false, allowParallelVersions: false, allowDraftBranch: false,
  requireApprovalOnMajor: true, requireApprovalOnMinor: true, requireApprovalOnPatch: true, requireReviewOnRevision: true,
  trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, trackReadHistory: false, trackRelationshipHistory: false,
  supportsEffectiveDate: true, supportsExpiryDate: false, supportsObsoleteDate: true,
}));

// Deep copy — a fresh scheme with a fresh futureReserved block.
function copyScheme(s) {
  return Object.assign({}, s, { futureReserved: Object.assign({}, s.futureReserved) });
}

function getDocumentVersioning(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_VERSIONING, id);
  return copyScheme(known ? DOCUMENT_VERSIONING[id] : SAFE_DEFAULT);
}

function listDocumentVersioning() {
  return DOCUMENT_VERSIONING_IDS.map((k) => copyScheme(DOCUMENT_VERSIONING[k]));
}

function isKnownDocumentVersioning(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_VERSIONING, id);
}

module.exports = {
  DOCUMENT_VERSIONING,
  DOCUMENT_VERSIONING_IDS,
  getDocumentVersioning,
  listDocumentVersioning,
  isKnownDocumentVersioning,
};
