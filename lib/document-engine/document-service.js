// WP-19 · E1 — Enterprise Document Service (single entry point / façade).
//
// The single stateless entry point to the entire WP-18 Enterprise Document Engine. It holds
// NO state, caches nothing, persists nothing, and implements NO business logic — every method
// is a direct delegation to the E18 orchestrator (document-engine.js), which itself delegates
// to the underlying engines. Pure, deterministic, never throws, copy-on-read. Its only import
// is the sibling orchestrator: no repositories, database, Express, routes, services,
// filesystem, uploads, logger, network, HTTP, or AI. UNWIRED — nothing in production imports it.
'use strict';

const engine = require('./document-engine');

// ---- document façade ----

function createDocument(input) { return engine.createDocument(input); }
function assembleDocument(input, options) { return engine.assembleDocument(input, options); }
function validateDocument(document) { return engine.validateDocument(document); }
function cloneDocument(document) { return engine.cloneDocument(document); }
function freezeDocument(document) { return engine.freezeDocument(document); }
function normalizeDocument(document) { return engine.normalizeDocument(document); }
function mergeDocument(base, incoming, options) { return engine.mergeDocument(base, incoming, options); }
function compareDocument(a, b) { return engine.compareDocument(a, b); }
function generateDocumentSnapshot(document) { return engine.generateDocumentSnapshot(document); }

// ---- component façade ----

function generateNumber(config) { return engine.generateNumber(config); }
function buildMetadata(input, options) { return engine.buildMetadata(input, options); }
function applyMetadataPolicy(metadata, policyOrId, options) { return engine.applyMetadataPolicy(metadata, policyOrId, options); }
function createVersion(input, options) { return engine.createVersion(input, options); }
function createApproval(input, options) { return engine.createApproval(input, options); }
function createReview(input, options) { return engine.createReview(input, options); }
function createAccess(input, options) { return engine.createAccess(input, options); }
function createStorage(input, options) { return engine.createStorage(input, options); }
function createCompliance(input, options) { return engine.createCompliance(input, options); }

// ---- information façade ----

function getEngineInformation() { return engine.getEngineInformation(); }
function listCapabilities() { return engine.listCapabilities(); }
function health() { return engine.health(); }

module.exports = {
  createDocument,
  assembleDocument,
  validateDocument,
  cloneDocument,
  freezeDocument,
  normalizeDocument,
  mergeDocument,
  compareDocument,
  generateDocumentSnapshot,
  generateNumber,
  buildMetadata,
  applyMetadataPolicy,
  createVersion,
  createApproval,
  createReview,
  createAccess,
  createStorage,
  createCompliance,
  getEngineInformation,
  listCapabilities,
  health,
};
