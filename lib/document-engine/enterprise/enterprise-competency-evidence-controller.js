// WP-26 · Phase 11 — Enterprise Document Engine — Competency Evidence — Controller.
//
// A thin HTTP controller over an INJECTED evidence service. NO business logic: each handler maps the
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
function assessmentIdFrom(req) {
  return Number(req.params.assessmentId);
}

function handler(map, okStatus) {
  return async function evidenceHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseCompetencyEvidenceController(service) {
  return {
    create: handler((req) => service.createEvidence(req.body), 201),
    update: handler((req) => service.updateEvidence(idFrom(req), req.body), 200),
    verify: handler((req) => service.verifyEvidence(idFrom(req), req.body), 200),
    get: handler((req) => service.getEvidence(idFrom(req)), 200),
    listEmployee: handler((req) => service.listEmployeeEvidence(employeeIdFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyEvidence(competencyIdFrom(req)), 200),
    listAssessment: handler((req) => service.listAssessmentEvidence(assessmentIdFrom(req)), 200),
    pending: handler(() => service.pendingEvidence(), 200),
    verified: handler(() => service.verifiedEvidence(), 200),
    expired: handler(() => service.expiredEvidence(), 200),
    archive: handler((req) => service.archiveEvidence(idFrom(req)), 200),
    restore: handler((req) => service.restoreEvidence(idFrom(req)), 200),
    remove: handler((req) => service.deleteEvidence(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseCompetencyEvidenceController };
