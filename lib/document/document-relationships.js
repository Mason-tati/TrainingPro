// WP-17 · D5 — Enterprise document-relationship registry (document-management foundation).
//
// The immutable single source of truth describing how documents may relate to one
// another (supersession, hierarchy, references, translations, generation, citations,
// "…_FOR" purpose links, etc.). Each entry declares directionality, its reciprocal
// inverse (or null), multiplicity, and gating flags, plus a reserved `futureReserved`
// extension block. Deep-frozen, copy-on-read (fresh objects), pure, dependency-free,
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
    validationRule: null,
    workflowRule: null,
    approvalRule: null,
    dependencyRule: null,
    impactRule: null,
    notificationRule: null,
    aiRule: null,
    graphRule: null,
    integrationRule: null,
    visualisationRule: null,
  };
}

// Build a relationship. `o` carries directionality, inverse, and gating flags; it is
// always an explicit object supplied by the registry below.
function relationship(id, displayName, description, o) {
  return {
    id,
    displayName,
    description,
    directional: !!o.directional,
    inverseRelationship: o.inverseRelationship ?? null,
    allowsMultiple: !!o.allowsMultiple,
    requiresSameDocumentType: !!o.requiresSameDocumentType,
    requiresApproval: !!o.requiresApproval,
    requiresVersionMatch: !!o.requiresVersionMatch,
    requiresPublishedSource: !!o.requiresPublishedSource,
    requiresPublishedTarget: !!o.requiresPublishedTarget,
    futureReserved: reserved(),
  };
}

const DOCUMENT_RELATIONSHIPS = deepFreeze({
  SUPERSEDES: relationship('SUPERSEDES', 'Supersedes', 'This document supersedes the target', {
    directional: true, inverseRelationship: 'SUPERSEDED_BY', requiresSameDocumentType: true, requiresApproval: true, requiresPublishedTarget: true,
  }),
  SUPERSEDED_BY: relationship('SUPERSEDED_BY', 'Superseded By', 'This document is superseded by the target', {
    directional: true, inverseRelationship: 'SUPERSEDES', requiresSameDocumentType: true, requiresApproval: true, requiresPublishedSource: true,
  }),
  PARENT: relationship('PARENT', 'Parent', 'The target is the parent of this document', {
    directional: true, inverseRelationship: 'CHILD',
  }),
  CHILD: relationship('CHILD', 'Child', 'The target is a child of this document', {
    directional: true, inverseRelationship: 'PARENT', allowsMultiple: true,
  }),
  RELATED: relationship('RELATED', 'Related', 'Non-directional related document', {
    directional: false, inverseRelationship: 'RELATED', allowsMultiple: true,
  }),
  REFERENCE: relationship('REFERENCE', 'Reference', 'This document references the target', {
    directional: true, allowsMultiple: true, requiresPublishedTarget: true,
  }),
  ATTACHMENT: relationship('ATTACHMENT', 'Attachment', 'The target is an attachment of this document', {
    directional: true, allowsMultiple: true,
  }),
  TRANSLATION_OF: relationship('TRANSLATION_OF', 'Translation Of', 'This document is a translation of the target', {
    directional: true, inverseRelationship: 'TRANSLATED_BY', requiresSameDocumentType: true, requiresVersionMatch: true,
  }),
  TRANSLATED_BY: relationship('TRANSLATED_BY', 'Translated By', 'The target is a translation of this document', {
    directional: true, inverseRelationship: 'TRANSLATION_OF', allowsMultiple: true, requiresSameDocumentType: true, requiresVersionMatch: true,
  }),
  DERIVED_FROM: relationship('DERIVED_FROM', 'Derived From', 'This document is derived from the target', {
    directional: true, requiresPublishedSource: true,
  }),
  GENERATED_FROM: relationship('GENERATED_FROM', 'Generated From', 'This document was generated from the target', {
    directional: true, inverseRelationship: 'GENERATES', requiresPublishedSource: true,
  }),
  GENERATES: relationship('GENERATES', 'Generates', 'This document generates the target', {
    directional: true, inverseRelationship: 'GENERATED_FROM', allowsMultiple: true,
  }),
  REQUIRES: relationship('REQUIRES', 'Requires', 'This document requires the target', {
    directional: true, inverseRelationship: 'REQUIRED_BY', allowsMultiple: true,
  }),
  REQUIRED_BY: relationship('REQUIRED_BY', 'Required By', 'The target requires this document', {
    directional: true, inverseRelationship: 'REQUIRES', allowsMultiple: true,
  }),
  IMPLEMENTS: relationship('IMPLEMENTS', 'Implements', 'This document implements the target', {
    directional: true, inverseRelationship: 'IMPLEMENTED_BY', allowsMultiple: true,
  }),
  IMPLEMENTED_BY: relationship('IMPLEMENTED_BY', 'Implemented By', 'The target implements this document', {
    directional: true, inverseRelationship: 'IMPLEMENTS', allowsMultiple: true,
  }),
  SUPPORTED_BY: relationship('SUPPORTED_BY', 'Supported By', 'This document is supported by the target', {
    directional: true, inverseRelationship: 'SUPPORTS', allowsMultiple: true,
  }),
  SUPPORTS: relationship('SUPPORTS', 'Supports', 'This document supports the target', {
    directional: true, inverseRelationship: 'SUPPORTED_BY', allowsMultiple: true,
  }),
  REPLACES: relationship('REPLACES', 'Replaces', 'This document replaces the target', {
    directional: true, inverseRelationship: 'REPLACED_BY', requiresSameDocumentType: true, requiresApproval: true, requiresPublishedTarget: true,
  }),
  REPLACED_BY: relationship('REPLACED_BY', 'Replaced By', 'This document is replaced by the target', {
    directional: true, inverseRelationship: 'REPLACES', requiresSameDocumentType: true, requiresApproval: true, requiresPublishedSource: true,
  }),
  CITED_BY: relationship('CITED_BY', 'Cited By', 'This document is cited by the target', {
    directional: true, inverseRelationship: 'CITES', allowsMultiple: true,
  }),
  CITES: relationship('CITES', 'Cites', 'This document cites the target', {
    directional: true, inverseRelationship: 'CITED_BY', allowsMultiple: true, requiresPublishedTarget: true,
  }),
  DUPLICATE_OF: relationship('DUPLICATE_OF', 'Duplicate Of', 'This document is a duplicate of the target', {
    directional: false, inverseRelationship: 'DUPLICATE_OF', requiresSameDocumentType: true,
  }),
  ALTERNATE_VERSION: relationship('ALTERNATE_VERSION', 'Alternate Version', 'An alternate version of the same document', {
    directional: false, inverseRelationship: 'ALTERNATE_VERSION', allowsMultiple: true, requiresSameDocumentType: true,
  }),
  SOURCE_DOCUMENT: relationship('SOURCE_DOCUMENT', 'Source Document', 'The target is the source of this document', {
    directional: true, inverseRelationship: 'OUTPUT_DOCUMENT', requiresPublishedSource: true,
  }),
  OUTPUT_DOCUMENT: relationship('OUTPUT_DOCUMENT', 'Output Document', 'The target is an output of this document', {
    directional: true, inverseRelationship: 'SOURCE_DOCUMENT', allowsMultiple: true,
  }),
  TRAINING_PACKAGE: relationship('TRAINING_PACKAGE', 'Training Package', 'The target is a training package for this document', {
    directional: true, allowsMultiple: true,
  }),
  ASSESSMENT_FOR: relationship('ASSESSMENT_FOR', 'Assessment For', 'This document is an assessment for the target', {
    directional: true, allowsMultiple: true,
  }),
  RISK_ASSESSMENT_FOR: relationship('RISK_ASSESSMENT_FOR', 'Risk Assessment For', 'This document is a risk assessment for the target', {
    directional: true, allowsMultiple: true,
  }),
  WORK_INSTRUCTION_FOR: relationship('WORK_INSTRUCTION_FOR', 'Work Instruction For', 'This document is a work instruction for the target', {
    directional: true, allowsMultiple: true,
  }),
  POLICY_FOR: relationship('POLICY_FOR', 'Policy For', 'This document is a policy for the target', {
    directional: true, allowsMultiple: true,
  }),
  PROCEDURE_FOR: relationship('PROCEDURE_FOR', 'Procedure For', 'This document is a procedure for the target', {
    directional: true, allowsMultiple: true,
  }),
  STANDARD_FOR: relationship('STANDARD_FOR', 'Standard For', 'This document is a standard for the target', {
    directional: true, allowsMultiple: true,
  }),
});

const DOCUMENT_RELATIONSHIP_IDS = Object.freeze(Object.keys(DOCUMENT_RELATIONSHIPS));

// Most-restrictive fail-safe default for an unrecognised relationship id.
const SAFE_DEFAULT = deepFreeze(relationship('UNKNOWN', 'Unknown Relationship', 'Unrecognised relationship — most-restrictive safe default', {
  requiresApproval: true,
}));

// Deep copy — a fresh relationship with a fresh futureReserved block.
function copyRelationship(r) {
  return Object.assign({}, r, { futureReserved: Object.assign({}, r.futureReserved) });
}

function getDocumentRelationship(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_RELATIONSHIPS, id);
  return copyRelationship(known ? DOCUMENT_RELATIONSHIPS[id] : SAFE_DEFAULT);
}

function listDocumentRelationships() {
  return DOCUMENT_RELATIONSHIP_IDS.map((k) => copyRelationship(DOCUMENT_RELATIONSHIPS[k]));
}

function isKnownDocumentRelationship(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_RELATIONSHIPS, id);
}

module.exports = {
  DOCUMENT_RELATIONSHIPS,
  DOCUMENT_RELATIONSHIP_IDS,
  getDocumentRelationship,
  listDocumentRelationships,
  isKnownDocumentRelationship,
};
