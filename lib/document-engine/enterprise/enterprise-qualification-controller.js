// WP-26 · Phase 16 — Enterprise Document Engine — Qualification — Controller.
//
// A thin HTTP controller over an INJECTED qualification service. NO business logic: each handler maps the
// request to a single service call and maps the result's { ok, code } to an HTTP status. Never-throw: any
// unexpected error becomes a 500 JSON response. UNWIRED.
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
function roleIdFrom(req) {
  return Number(req.params.roleId);
}
function learningPathIdFrom(req) {
  return Number(req.params.learningPathId);
}
function competencyIdFrom(req) {
  return Number(req.params.competencyId);
}

function handler(map, okStatus) {
  return async function qualificationHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseQualificationController(service) {
  return {
    create: handler((req) => service.createQualification(req.body), 201),
    update: handler((req) => service.updateQualification(idFrom(req), req.body), 200),
    get: handler((req) => service.getQualification(idFrom(req)), 200),
    listRole: handler((req) => service.listRoleQualifications(roleIdFrom(req)), 200),
    listLearningPath: handler((req) => service.listLearningPathQualifications(learningPathIdFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyQualifications(competencyIdFrom(req)), 200),
    listMandatory: handler(() => service.mandatoryQualifications(), 200),
    listActive: handler(() => service.activeQualifications(), 200),
    archive: handler((req) => service.archiveQualification(idFrom(req)), 200),
    restore: handler((req) => service.restoreQualification(idFrom(req)), 200),
    remove: handler((req) => service.deleteQualification(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseQualificationController };
