// WP-19 · E2 — Enterprise Repository Adapter (delegation layer).
//
// Adapts repository-style calls (create/update/delete/get/list/search/…) onto the Enterprise
// Document Service. It contains NO business logic, NO persistence, NO SQL, NO state, NO caching,
// and NO mutation — every method is a direct delegation to document-service. Read-style verbs
// return copy-on-read fresh copies; archive returns an immutable frozen copy. Its only import is
// the sibling document-service: no repositories, database, Express, routes, middleware,
// filesystem, uploads, logger, HTTP, network, or AI. UNWIRED — nothing in production imports it.
//
// Note: persistence-dependent verbs (delete/get/list/search/archive/restore) map to the closest
// pure in-memory service operation in this unwired foundation; real persistence is wired later.
'use strict';

const service = require('./document-service');

// ---- write-style ----

function create(input, options) { return service.assembleDocument(input, options); }
function update(base, patch, options) { return service.mergeDocument(base, patch, options); }
function version(input, options) { return service.createVersion(input, options); }
function approve(input, options) { return service.createApproval(input, options); }
function review(input, options) { return service.createReview(input, options); }
function access(input, options) { return service.createAccess(input, options); }
function storage(input, options) { return service.createStorage(input, options); }
function compliance(input, options) { return service.createCompliance(input, options); }

// ---- read-style (copy-on-read: fresh copies) ----

function get(document) { return service.cloneDocument(document); }
function list(input) { return service.cloneDocument(input); }
function search(input) { return service.cloneDocument(input); }
function restore(document) { return service.cloneDocument(document); }
function del(document) { return service.cloneDocument(document); }
function clone(document) { return service.cloneDocument(document); }

// ---- evaluation-style ----

function validate(document) { return service.validateDocument(document); }
function snapshot(document) { return service.generateDocumentSnapshot(document); }
function archive(document) { return service.freezeDocument(document); }

// ---- information-style ----

function health() { return service.health(); }
function capabilities() { return service.listCapabilities(); }

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
