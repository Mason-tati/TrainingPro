// WP-19 · E3 — Enterprise API Adapter (API-style façade).
//
// Exposes an API-style interface (createDocument/updateDocument/…) over the Repository Adapter.
// It contains NO business logic, NO validation logic, NO persistence, NO state, NO caching, and
// NO mutation — every method is a direct delegation to repository-adapter. There are NO Express
// routes, HTTP listeners, or route registrations. Its only import is the sibling
// repository-adapter: no database, Express, routes, middleware, services, repositories,
// filesystem, uploads, logger, HTTP, network, or AI. UNWIRED — nothing in production imports it.
'use strict';

const repo = require('./repository-adapter');

// ---- document operations ----

function createDocument(input, options) { return repo.create(input, options); }
function updateDocument(base, patch, options) { return repo.update(base, patch, options); }
function deleteDocument(document) { return repo.delete(document); }
function getDocument(document) { return repo.get(document); }
function listDocuments(input) { return repo.list(input); }
function searchDocuments(input) { return repo.search(input); }
function validateDocument(document) { return repo.validate(document); }
function cloneDocument(document) { return repo.clone(document); }
function snapshotDocument(document) { return repo.snapshot(document); }
function archiveDocument(document) { return repo.archive(document); }
function restoreDocument(document) { return repo.restore(document); }

// ---- component operations ----

function versionDocument(input, options) { return repo.version(input, options); }
function approveDocument(input, options) { return repo.approve(input, options); }
function reviewDocument(input, options) { return repo.review(input, options); }
function accessDocument(input, options) { return repo.access(input, options); }
function storageDocument(input, options) { return repo.storage(input, options); }
function complianceDocument(input, options) { return repo.compliance(input, options); }

// ---- information ----

function health() { return repo.health(); }
function capabilities() { return repo.capabilities(); }

module.exports = {
  createDocument,
  updateDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  searchDocuments,
  validateDocument,
  cloneDocument,
  snapshotDocument,
  archiveDocument,
  restoreDocument,
  versionDocument,
  approveDocument,
  reviewDocument,
  accessDocument,
  storageDocument,
  complianceDocument,
  health,
  capabilities,
};
