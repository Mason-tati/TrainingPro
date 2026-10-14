// WP-26 · Phase 8 — Enterprise Document Engine — Competency Management — Controller.
//
// A thin HTTP controller over an INJECTED competency service. NO business logic: each handler maps
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
  return async function competencyHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseDocumentCompetencyController(service) {
  return {
    create: handler((req) => service.createCompetency(req.body), 201),
    update: handler((req) => service.updateCompetency(idFrom(req), req.body), 200),
    get: handler((req) => service.getCompetency(idFrom(req)), 200),
    listVersion: handler((req) => service.listVersionCompetencies(versionIdFrom(req)), 200),
    mandatory: handler(() => service.mandatoryCompetencies(), 200),
    expired: handler(() => service.expiredCompetencies(), 200),
    archive: handler((req) => service.archiveCompetency(idFrom(req)), 200),
    restore: handler((req) => service.restoreCompetency(idFrom(req)), 200),
    remove: handler((req) => service.deleteCompetency(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentCompetencyController };
