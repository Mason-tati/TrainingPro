// WP-17 · D17 — Enterprise document compliance/standards registry (document-management foundation).
//
// The immutable single source of truth describing the compliance frameworks (ISO, SOC2,
// GDPR, WHS, mining standards, corporate/site/project standards, …) that future document
// modules may reference, and the document-control obligations each entails — plus a
// reserved `futureReserved` extension block. Deep-frozen, copy-on-read (fresh objects),
// pure, dependency-free, CommonJS, never throws; unknown ids fall back to a safe default.
// UNWIRED — nothing consumes it (no compliance/ISO enforcement, workflow, or reporting).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    auditPolicy: null,
    reviewPolicy: null,
    retentionPolicy: null,
    trainingPolicy: null,
    approvalPolicy: null,
    aiPolicy: null,
    workflowPolicy: null,
    integrationPolicy: null,
    reportingPolicy: null,
    extensionPolicy: null,
  };
}

// Build a compliance framework. `c` carries the boolean flags; category is explicit.
function compliance(id, displayName, description, category, c) {
  return {
    id,
    displayName,
    description,
    category,
    requiresDocumentControl: !!c.requiresDocumentControl,
    requiresVersionControl: !!c.requiresVersionControl,
    requiresApproval: !!c.requiresApproval,
    requiresReview: !!c.requiresReview,
    requiresAudit: !!c.requiresAudit,
    requiresRetention: !!c.requiresRetention,
    requiresTraining: !!c.requiresTraining,
    requiresReadAcknowledgement: !!c.requiresReadAcknowledgement,
    futureReserved: reserved(),
  };
}

// The controlled-document obligations shared by every real framework.
const CONTROLLED = {
  requiresDocumentControl: true, requiresVersionControl: true, requiresApproval: true,
  requiresReview: true, requiresAudit: true, requiresRetention: true,
};

const DOCUMENT_COMPLIANCE = deepFreeze({
  NONE: compliance('NONE', 'None', 'No compliance framework', 'none', {}),
  ISO9001: compliance('ISO9001', 'ISO 9001', 'Quality management systems', 'quality', { ...CONTROLLED, requiresTraining: true }),
  ISO14001: compliance('ISO14001', 'ISO 14001', 'Environmental management systems', 'environment', { ...CONTROLLED, requiresTraining: true }),
  ISO45001: compliance('ISO45001', 'ISO 45001', 'Occupational health & safety management', 'safety', { ...CONTROLLED, requiresTraining: true, requiresReadAcknowledgement: true }),
  ISO27001: compliance('ISO27001', 'ISO 27001', 'Information security management', 'security', { ...CONTROLLED, requiresTraining: true, requiresReadAcknowledgement: true }),
  ISO31000: compliance('ISO31000', 'ISO 31000', 'Risk management', 'risk', { ...CONTROLLED }),
  ISO55001: compliance('ISO55001', 'ISO 55001', 'Asset management', 'asset', { ...CONTROLLED }),
  SOC2: compliance('SOC2', 'SOC 2', 'Service organisation controls (security/availability)', 'security', { ...CONTROLLED }),
  GDPR: compliance('GDPR', 'GDPR', 'EU General Data Protection Regulation', 'privacy', { ...CONTROLLED, requiresReadAcknowledgement: true }),
  AU_PRIVACY_ACT: compliance('AU_PRIVACY_ACT', 'Australian Privacy Act', 'Australian Privacy Act / APPs', 'privacy', { ...CONTROLLED, requiresReadAcknowledgement: true }),
  WHS_ACT: compliance('WHS_ACT', 'WHS Act', 'Work Health & Safety Act', 'safety', { ...CONTROLLED, requiresTraining: true, requiresReadAcknowledgement: true }),
  MINING_REGULATIONS: compliance('MINING_REGULATIONS', 'Mining Regulations', 'Jurisdictional mining safety regulations', 'industry', { ...CONTROLLED, requiresTraining: true, requiresReadAcknowledgement: true }),
  ICMM: compliance('ICMM', 'ICMM', 'International Council on Mining & Metals principles', 'industry', { ...CONTROLLED, requiresTraining: true }),
  TSM: compliance('TSM', 'Towards Sustainable Mining', 'Mining Association TSM protocol', 'industry', { ...CONTROLLED, requiresTraining: true }),
  COMPANY_STANDARD: compliance('COMPANY_STANDARD', 'Company Standard', 'Internal company standard', 'corporate', { ...CONTROLLED, requiresReadAcknowledgement: true }),
  SITE_STANDARD: compliance('SITE_STANDARD', 'Site Standard', 'Site-specific standard', 'site', { ...CONTROLLED }),
  PROJECT_STANDARD: compliance('PROJECT_STANDARD', 'Project Standard', 'Project-specific standard', 'project', { ...CONTROLLED }),
  CUSTOM: compliance('CUSTOM', 'Custom', 'Custom / user-defined compliance framework', 'custom', { ...CONTROLLED }),
});

const DOCUMENT_COMPLIANCE_IDS = Object.freeze(Object.keys(DOCUMENT_COMPLIANCE));

// Safe default for an unrecognised compliance id (per D17 specification).
const SAFE_DEFAULT = deepFreeze(compliance('UNKNOWN', 'Unknown Compliance', 'Unrecognised compliance framework — safe default', 'corporate', {
  requiresDocumentControl: true, requiresVersionControl: true, requiresApproval: true, requiresReview: true,
  requiresAudit: true, requiresRetention: true, requiresTraining: false, requiresReadAcknowledgement: false,
}));

// Deep copy — a fresh compliance object with a fresh futureReserved block.
function copyCompliance(c) {
  return Object.assign({}, c, { futureReserved: Object.assign({}, c.futureReserved) });
}

function getDocumentCompliance(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_COMPLIANCE, id);
  return copyCompliance(known ? DOCUMENT_COMPLIANCE[id] : SAFE_DEFAULT);
}

function listDocumentCompliance() {
  return DOCUMENT_COMPLIANCE_IDS.map((k) => copyCompliance(DOCUMENT_COMPLIANCE[k]));
}

function isKnownDocumentCompliance(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_COMPLIANCE, id);
}

module.exports = {
  DOCUMENT_COMPLIANCE,
  DOCUMENT_COMPLIANCE_IDS,
  getDocumentCompliance,
  listDocumentCompliance,
  isKnownDocumentCompliance,
};
