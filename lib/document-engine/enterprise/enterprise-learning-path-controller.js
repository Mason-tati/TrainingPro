// WP-26 · Phase 15 — Enterprise Document Engine — Learning Path — Controller.
//
// A thin HTTP controller over an INJECTED learning-path service. NO business logic: each handler maps the
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
function trainingProgramIdFrom(req) {
  return Number(req.params.trainingProgramId);
}
function competencyIdFrom(req) {
  return Number(req.params.competencyId);
}

function handler(map, okStatus) {
  return async function learningPathHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseLearningPathController(service) {
  return {
    create: handler((req) => service.createLearningPath(req.body), 201),
    update: handler((req) => service.updateLearningPath(idFrom(req), req.body), 200),
    get: handler((req) => service.getLearningPath(idFrom(req)), 200),
    listRole: handler((req) => service.listRolePaths(roleIdFrom(req)), 200),
    listProgram: handler((req) => service.listProgramPaths(trainingProgramIdFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyPaths(competencyIdFrom(req)), 200),
    listMandatory: handler(() => service.mandatoryPaths(), 200),
    listActive: handler(() => service.activePaths(), 200),
    archive: handler((req) => service.archiveLearningPath(idFrom(req)), 200),
    restore: handler((req) => service.restoreLearningPath(idFrom(req)), 200),
    remove: handler((req) => service.deleteLearningPath(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseLearningPathController };
