// WP-18 · E18 — Enterprise Document Engine Orchestrator (façade).
//
// A single façade over every Enterprise Document Engine (E1–E17). It performs NO persistence,
// routing, workflow execution, HTTP, Express, database, filesystem, or cloud access, and holds
// NO state (no caching). Every method simply delegates to an existing engine, which already
// returns fresh copies and never throws. The application's behaviour is unchanged. UNWIRED.
//
// NOTE (disclosed): the E18 spec lists the metadata engine import as
// './document-metadata/metadata-engine', but that path does not exist — the E6 metadata engine
// lives at './metadata/metadata-engine' (matching its sibling './metadata/metadata-policy-engine').
// This resolves the spec's evident path typo to the actual, only, existing location.
'use strict';

const builder = require('./document-builder');
const assembly = require('./document-assembly');
const versionManager = require('./document-version-manager');
const metadataEngine = require('./metadata/metadata-engine');
const policyEngine = require('./metadata/metadata-policy-engine');
const NumberGenerator = require('./numbering/document-number-generator');
const approvalManager = require('./document-approval-manager');
const reviewManager = require('./document-review-manager');
const accessManager = require('./document-access-manager');
const storageManager = require('./document-storage-manager');
const complianceManager = require('./document-compliance-manager');

const ENGINE_VERSION = '1.0.0-foundation';
const SCHEMA_VERSION = 'enterprise-document.v1';

// The composed engines, with a representative method used for the health check.
const MODULES = [
  { name: 'documentBuilder', ref: builder, method: 'createDocument', isClass: false },
  { name: 'documentAssembly', ref: assembly, method: 'assembleDocument', isClass: false },
  { name: 'versionManager', ref: versionManager, method: 'createVersion', isClass: false },
  { name: 'metadataEngine', ref: metadataEngine, method: 'createMetadata', isClass: false },
  { name: 'metadataPolicyEngine', ref: policyEngine, method: 'getPolicy', isClass: false },
  { name: 'numberGenerator', ref: NumberGenerator, method: null, isClass: true },
  { name: 'approvalManager', ref: approvalManager, method: 'createApproval', isClass: false },
  { name: 'reviewManager', ref: reviewManager, method: 'createReview', isClass: false },
  { name: 'accessManager', ref: accessManager, method: 'createAccess', isClass: false },
  { name: 'storageManager', ref: storageManager, method: 'createStorage', isClass: false },
  { name: 'complianceManager', ref: complianceManager, method: 'createCompliance', isClass: false },
];

const SUPPORTED_FEATURES = ['numbering', 'metadata', 'policy', 'assembly', 'versioning', 'approval', 'review', 'access', 'storage', 'compliance', 'validation', 'snapshot', 'comparison', 'normalization', 'cloning', 'immutability'];
const CAPABILITY_NAMES = ['Numbering', 'Metadata', 'Policy', 'Assembly', 'Versioning', 'Approval', 'Review', 'Access', 'Storage', 'Compliance', 'Validation', 'Snapshots', 'Comparison', 'Normalization', 'Cloning', 'Immutability'];

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }

// ---- delegation: document ----

function createDocument(input) { return builder.createDocument(input); }
function assembleDocument(input, options) { return assembly.assembleDocument(input, options); }
function normalizeDocument(document) { return builder.normalizeDocument(document); }
function cloneDocument(document) { return builder.cloneDocument(document); }
function freezeDocument(document) { return builder.freezeDocument(document); }
function mergeDocument(base, incoming, options) { return builder.mergeDocuments(base, incoming, options); }
function compareDocument(a, b) { return builder.compareDocuments(a, b); }
function validateDocument(document) { return builder.validateStructure(document); }
function generateDocumentSnapshot(document) { return builder.generateDocumentSnapshot(document); }

// ---- delegation: components ----

function generateNumber(config) {
  const cfg = obj(config);
  const generator = new NumberGenerator(cfg);
  return generator.generate(obj(cfg.context));
}
function buildMetadata(input, options) { return metadataEngine.createMetadata(input, options); }
function applyMetadataPolicy(metadata, policyOrId, options) { return policyEngine.applyDefaults(metadata, policyOrId, options); }
function createVersion(input, options) { return versionManager.createVersion(input, options); }
function createApproval(input, options) { return approvalManager.createApproval(input, options); }
function createReview(input, options) { return reviewManager.createReview(input, options); }
function createAccess(input, options) { return accessManager.createAccess(input, options); }
function createStorage(input, options) { return storageManager.createStorage(input, options); }
function createCompliance(input, options) { return complianceManager.createCompliance(input, options); }

// ---- orchestrator information (fresh copy each call) ----

function getEngineInformation() {
  return {
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    supportedModules: MODULES.map((m) => m.name),
    supportedFeatures: SUPPORTED_FEATURES.slice(),
    futureReserved: [],
  };
}

function listCapabilities() {
  return CAPABILITY_NAMES.map((name) => ({ name, supported: true }));
}

function health() {
  const checks = MODULES.map((m) => (m.isClass ? typeof m.ref === 'function' : typeof m.ref[m.method] === 'function'));
  const modulesLoaded = checks.filter(Boolean).length;
  return {
    healthy: modulesLoaded === MODULES.length,
    modulesLoaded,
    modulesAvailable: MODULES.map((m) => m.name),
    warnings: [],
    futureReserved: [],
  };
}

module.exports = {
  createDocument,
  assembleDocument,
  generateNumber,
  buildMetadata,
  applyMetadataPolicy,
  createVersion,
  createApproval,
  createReview,
  createAccess,
  createStorage,
  createCompliance,
  validateDocument,
  normalizeDocument,
  cloneDocument,
  freezeDocument,
  mergeDocument,
  compareDocument,
  generateDocumentSnapshot,
  getEngineInformation,
  listCapabilities,
  health,
};
