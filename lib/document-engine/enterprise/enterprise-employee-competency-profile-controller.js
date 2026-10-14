// WP-26 · Phase 12 — Enterprise Document Engine — Employee Competency Profile — Controller.
//
// A thin HTTP controller over an INJECTED profile service. NO business logic: each handler maps the
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
function employeeIdFrom(req) {
  return Number(req.params.employeeId);
}
function competencyIdFrom(req) {
  return Number(req.params.competencyId);
}
function withinDaysFrom(req) {
  return req.query.withinDays === undefined ? undefined : Number(req.query.withinDays);
}

function handler(map, okStatus) {
  return async function profileHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseEmployeeCompetencyProfileController(service) {
  return {
    create: handler((req) => service.createProfile(req.body), 201),
    update: handler((req) => service.updateProfile(idFrom(req), req.body), 200),
    get: handler((req) => service.getProfile(idFrom(req)), 200),
    listEmployee: handler((req) => service.listEmployeeProfiles(employeeIdFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyProfiles(competencyIdFrom(req)), 200),
    listCompliant: handler(() => service.compliantProfiles(), 200),
    listNonCompliant: handler(() => service.nonCompliantProfiles(), 200),
    listExpiring: handler((req) => service.expiringProfiles(withinDaysFrom(req)), 200),
    listExpired: handler(() => service.expiredProfiles(), 200),
    archive: handler((req) => service.archiveProfile(idFrom(req)), 200),
    restore: handler((req) => service.restoreProfile(idFrom(req)), 200),
    remove: handler((req) => service.deleteProfile(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseEmployeeCompetencyProfileController };
