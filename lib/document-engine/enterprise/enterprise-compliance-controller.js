// WP-26 · Phase 18 (FINAL) — Enterprise Document Engine — Compliance — Controller.
//
// A thin HTTP controller over an INJECTED compliance service. NO business logic: each handler maps the
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
function employeeIdFrom(req) {
  return Number(req.params.employeeId);
}
function roleIdFrom(req) {
  return Number(req.params.roleId);
}
function qualificationIdFrom(req) {
  return Number(req.params.qualificationId);
}
function certificationIdFrom(req) {
  return Number(req.params.certificationId);
}
function learningPathIdFrom(req) {
  return Number(req.params.learningPathId);
}
function competencyIdFrom(req) {
  return Number(req.params.competencyId);
}

function handler(map, okStatus) {
  return async function complianceHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseComplianceController(service) {
  return {
    create: handler((req) => service.createCompliance(req.body), 201),
    update: handler((req) => service.updateCompliance(idFrom(req), req.body), 200),
    get: handler((req) => service.getCompliance(idFrom(req)), 200),
    listEmployee: handler((req) => service.listEmployeeCompliance(employeeIdFrom(req)), 200),
    listRole: handler((req) => service.listRoleCompliance(roleIdFrom(req)), 200),
    listQualification: handler((req) => service.listQualificationCompliance(qualificationIdFrom(req)), 200),
    listCertification: handler((req) => service.listCertificationCompliance(certificationIdFrom(req)), 200),
    listLearningPath: handler((req) => service.listLearningPathCompliance(learningPathIdFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyCompliance(competencyIdFrom(req)), 200),
    listCompliant: handler(() => service.compliantRecords(), 200),
    listNonCompliant: handler(() => service.nonCompliantRecords(), 200),
    listExpired: handler(() => service.expiredRecords(), 200),
    listOverdue: handler(() => service.overdueRecords(), 200),
    archive: handler((req) => service.archiveCompliance(idFrom(req)), 200),
    restore: handler((req) => service.restoreCompliance(idFrom(req)), 200),
    remove: handler((req) => service.deleteCompliance(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseComplianceController };
