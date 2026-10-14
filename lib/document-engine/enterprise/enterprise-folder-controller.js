// WP-26 · Phase 2 — Enterprise Document Engine — Folder Management — Controller.
//
// A thin HTTP controller over an INJECTED folder service. NO business logic: each handler maps the
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

function handler(map, okStatus) {
  return async function folderHandler(req, res) {
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
function createEnterpriseFolderController(service) {
  return {
    create: handler((req) => service.createFolder(req.body), 201),
    update: handler((req) => service.updateFolder(idFrom(req), req.body), 200),
    get: handler((req) => service.getFolder(idFrom(req)), 200),
    listRoot: handler(() => service.listRootFolders(), 200),
    listChildren: handler((req) => service.listChildren(idFrom(req)), 200),
    move: handler((req) => service.moveFolder(idFrom(req), req.body.parentFolderId), 200),
    archive: handler((req) => service.archiveFolder(idFrom(req)), 200),
    restore: handler((req) => service.restoreFolder(idFrom(req)), 200),
    remove: handler((req) => service.deleteFolder(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseFolderController };
