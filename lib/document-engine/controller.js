// WP-19 · E4 — Enterprise Route Controller (pure controller abstraction).
//
// A pure controller façade that will eventually sit BEHIND Express routes — but it is NOT an
// Express controller: there are NO routes, NO Express, NO HTTP request/response objects, NO
// middleware, and NO runtime wiring. It contains NO business logic, NO validation, NO
// persistence, NO state, NO caching, and NO mutation — every method is a direct delegation to
// api-adapter. Its only import is the sibling api-adapter: no Express, routes, middleware, HTTP,
// database, repositories, services, filesystem, uploads, logger, or AI. UNWIRED — nothing in
// production imports it.
'use strict';

const api = require('./api-adapter');

// ---- document actions ----

function create(input, options) { return api.createDocument(input, options); }
function update(base, patch, options) { return api.updateDocument(base, patch, options); }
function del(document) { return api.deleteDocument(document); }
function get(document) { return api.getDocument(document); }
function list(input) { return api.listDocuments(input); }
function search(input) { return api.searchDocuments(input); }
function validate(document) { return api.validateDocument(document); }
function clone(document) { return api.cloneDocument(document); }
function snapshot(document) { return api.snapshotDocument(document); }
function archive(document) { return api.archiveDocument(document); }
function restore(document) { return api.restoreDocument(document); }

// ---- component actions ----

function version(input, options) { return api.versionDocument(input, options); }
function approve(input, options) { return api.approveDocument(input, options); }
function review(input, options) { return api.reviewDocument(input, options); }
function access(input, options) { return api.accessDocument(input, options); }
function storage(input, options) { return api.storageDocument(input, options); }
function compliance(input, options) { return api.complianceDocument(input, options); }

// ---- information actions ----

function health() { return api.health(); }
function capabilities() { return api.capabilities(); }

module.exports = {
  create,
  update,
  delete: del,
  get,
  list,
  search,
  validate,
  clone,
  snapshot,
  archive,
  restore,
  version,
  approve,
  review,
  access,
  storage,
  compliance,
  health,
  capabilities,
};
