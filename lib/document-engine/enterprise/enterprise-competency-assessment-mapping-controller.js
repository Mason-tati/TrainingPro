// WP-26 · Phase 10 — Enterprise Document Engine — Competency ↔ Assessment Mapping — Controller.
//
// A thin HTTP controller over an INJECTED mapping service. NO business logic: each handler maps the
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
function competencyIdFrom(req) {
  return Number(req.params.competencyId);
}
function assessmentIdFrom(req) {
  return Number(req.params.assessmentId);
}

function handler(map, okStatus) {
  return async function mappingHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseCompetencyAssessmentMappingController(service) {
  return {
    create: handler((req) => service.createMapping(req.body), 201),
    update: handler((req) => service.updateMapping(idFrom(req), req.body), 200),
    get: handler((req) => service.getMapping(idFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyMappings(competencyIdFrom(req)), 200),
    listAssessment: handler((req) => service.listAssessmentMappings(assessmentIdFrom(req)), 200),
    mandatory: handler(() => service.mandatoryMappings(), 200),
    expired: handler(() => service.expiredMappings(), 200),
    archive: handler((req) => service.archiveMapping(idFrom(req)), 200),
    restore: handler((req) => service.restoreMapping(idFrom(req)), 200),
    remove: handler((req) => service.deleteMapping(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseCompetencyAssessmentMappingController };
