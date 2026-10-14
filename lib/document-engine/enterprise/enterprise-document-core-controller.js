// WP-26 · Phase 3 — Enterprise Document Engine — Document Core — Controller.
//
// A thin HTTP controller over an INJECTED document-core service. NO business logic: each handler maps
// the request to a single service call and maps the result's { ok, code } to an HTTP status. Never-
// throw: any unexpected error becomes a 500 JSON response. UNWIRED.
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
function folderIdFrom(req) {
  return Number(req.params.folderId);
}

function handler(map, okStatus) {
  return async function documentCoreHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseDocumentCoreController(service) {
  return {
    create: handler((req) => service.createDocument(req.body), 201),
    update: handler((req) => service.updateDocument(idFrom(req), req.body), 200),
    get: handler((req) => service.getDocument(idFrom(req)), 200),
    search: handler((req) => service.searchDocuments(req.query), 200),
    listFolder: handler((req) => service.listFolderDocuments(folderIdFrom(req)), 200),
    archive: handler((req) => service.archiveDocument(idFrom(req)), 200),
    restore: handler((req) => service.restoreDocument(idFrom(req)), 200),
    remove: handler((req) => service.deleteDocument(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentCoreController };
