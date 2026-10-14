// WP-26 · Phase 7 — Enterprise Document Engine — Training Assignment — Controller.
//
// A thin HTTP controller over an INJECTED training service. NO business logic: each handler maps the
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
function versionIdFrom(req) {
  return Number(req.params.versionId);
}

function handler(map, okStatus) {
  return async function trainingHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseDocumentTrainingController(service) {
  return {
    create: handler((req) => service.createTraining(req.body), 201),
    update: handler((req) => service.updateTraining(idFrom(req), req.body), 200),
    get: handler((req) => service.getTraining(idFrom(req)), 200),
    listVersion: handler((req) => service.listVersionTraining(versionIdFrom(req)), 200),
    pending: handler(() => service.pendingTraining(), 200),
    completed: handler(() => service.completedTraining(), 200),
    overdue: handler(() => service.overdueTraining(), 200),
    complete: handler((req) => service.completeTraining(idFrom(req), req.body), 200),
    archive: handler((req) => service.archiveTraining(idFrom(req)), 200),
    restore: handler((req) => service.restoreTraining(idFrom(req)), 200),
    remove: handler((req) => service.deleteTraining(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentTrainingController };
