// WP-26 · Phase 13 — Enterprise Document Engine — Competency Recertification — Controller.
//
// A thin HTTP controller over an INJECTED recertification service. NO business logic: each handler maps
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
function employeeIdFrom(req) {
  return Number(req.params.employeeId);
}
function competencyIdFrom(req) {
  return Number(req.params.competencyId);
}

function handler(map, okStatus) {
  return async function recertificationHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseCompetencyRecertificationController(service) {
  return {
    create: handler((req) => service.createRecertification(req.body), 201),
    update: handler((req) => service.updateRecertification(idFrom(req), req.body), 200),
    get: handler((req) => service.getRecertification(idFrom(req)), 200),
    listEmployee: handler((req) => service.listEmployeeRecertifications(employeeIdFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyRecertifications(competencyIdFrom(req)), 200),
    listDue: handler(() => service.dueRecertifications(), 200),
    listScheduled: handler(() => service.scheduledRecertifications(), 200),
    listCompleted: handler(() => service.completedRecertifications(), 200),
    listOverdue: handler(() => service.overdueRecertifications(), 200),
    archive: handler((req) => service.archiveRecertification(idFrom(req)), 200),
    restore: handler((req) => service.restoreRecertification(idFrom(req)), 200),
    remove: handler((req) => service.deleteRecertification(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseCompetencyRecertificationController };
