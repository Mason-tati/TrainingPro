// WP-26 · Phase 14 — Enterprise Document Engine — Training Program — Controller.
//
// A thin HTTP controller over an INJECTED training-program service. NO business logic: each handler maps
// the request to a single service call and maps the result's { ok, code } to an HTTP status. Never-throw:
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
function trainerIdFrom(req) {
  return Number(req.params.trainerId);
}

function handler(map, okStatus) {
  return async function programHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseTrainingProgramController(service) {
  return {
    create: handler((req) => service.createProgram(req.body), 201),
    update: handler((req) => service.updateProgram(idFrom(req), req.body), 200),
    get: handler((req) => service.getProgram(idFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyPrograms(competencyIdFrom(req)), 200),
    listTrainer: handler((req) => service.listTrainerPrograms(trainerIdFrom(req)), 200),
    listMandatory: handler(() => service.mandatoryPrograms(), 200),
    listActive: handler(() => service.activePrograms(), 200),
    archive: handler((req) => service.archiveProgram(idFrom(req)), 200),
    restore: handler((req) => service.restoreProgram(idFrom(req)), 200),
    remove: handler((req) => service.deleteProgram(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseTrainingProgramController };
