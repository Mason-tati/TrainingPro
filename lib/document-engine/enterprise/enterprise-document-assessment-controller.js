// WP-26 · Phase 9 — Enterprise Document Engine — Assessment Management — Controller.
//
// A thin HTTP controller over an INJECTED assessment service. NO business logic: each handler maps
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
function versionIdFrom(req) {
  return Number(req.params.versionId);
}

function handler(map, okStatus) {
  return async function assessmentHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseDocumentAssessmentController(service) {
  return {
    create: handler((req) => service.createAssessment(req.body), 201),
    update: handler((req) => service.updateAssessment(idFrom(req), req.body), 200),
    get: handler((req) => service.getAssessment(idFrom(req)), 200),
    listVersion: handler((req) => service.listVersionAssessments(versionIdFrom(req)), 200),
    published: handler(() => service.publishedAssessments(), 200),
    expired: handler(() => service.expiredAssessments(), 200),
    archive: handler((req) => service.archiveAssessment(idFrom(req)), 200),
    restore: handler((req) => service.restoreAssessment(idFrom(req)), 200),
    remove: handler((req) => service.deleteAssessment(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentAssessmentController };
