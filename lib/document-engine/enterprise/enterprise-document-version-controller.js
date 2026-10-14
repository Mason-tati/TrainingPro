// WP-26 · Phase 4 — Enterprise Document Engine — Version Control — Controller.
//
// A thin HTTP controller over an INJECTED version service. NO business logic: each handler maps the
// request to a single service call and maps the result's { ok, code } to an HTTP status. Never-throw:
// any unexpected error becomes a 500 JSON response. UNWIRED.
'use strict';

const ERROR_STATUS = {
  VALIDATION: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  ERROR: 500,
};

function idFrom(req) {
  return Number(req.params.id);
}
function documentIdFrom(req) {
  return Number(req.params.documentId);
}

function handler(map, okStatus) {
  return async function versionHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseDocumentVersionController(service) {
  return {
    create: handler((req) => service.createVersion(req.body), 201),
    update: handler((req) => service.updateVersion(idFrom(req), req.body), 200),
    get: handler((req) => service.getVersion(idFrom(req)), 200),
    list: handler((req) => service.listVersions(documentIdFrom(req)), 200),
    current: handler((req) => service.getCurrentVersion(documentIdFrom(req)), 200),
    archive: handler((req) => service.archiveVersion(idFrom(req)), 200),
    restore: handler((req) => service.restoreVersion(idFrom(req)), 200),
    remove: handler((req) => service.deleteVersion(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentVersionController };
