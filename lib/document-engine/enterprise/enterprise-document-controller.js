// WP-26 · Phase 1 — Enterprise Document Engine Foundation — Controller.
//
// A thin HTTP controller over an INJECTED service. It contains NO business logic: each handler maps
// the request to a single service call and maps the service result's `{ ok, code }` to an HTTP
// status. Never-throw: any unexpected error becomes a 500 JSON response. UNWIRED — nothing in
// production imports it.
'use strict';

// Service result code -> HTTP status for non-ok results.
const ERROR_STATUS = {
  VALIDATION: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  ERROR: 500,
};

function idFrom(req) {
  return Number(req.params.id);
}

// Wrap a (req)->Promise<result> mapping into an Express handler with status mapping + never-throw.
function handler(map, okStatus) {
  return async function documentHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

// Build the controller over an injected service (dependency injection).
function createEnterpriseDocumentController(service) {
  return {
    create: handler((req) => service.createDocument(req.body), 201),
    update: handler((req) => service.updateDocument(idFrom(req), req.body), 200),
    get: handler((req) => service.getDocument(idFrom(req)), 200),
    list: handler((req) => service.listDocuments(req.query), 200),
    archive: handler((req) => service.archiveDocument(idFrom(req)), 200),
    restore: handler((req) => service.restoreDocument(idFrom(req)), 200),
    remove: handler((req) => service.deleteDocument(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentController };
