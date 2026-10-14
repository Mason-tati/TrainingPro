// WP-26 · Phase 17 — Enterprise Document Engine — Certification — Controller.
//
// A thin HTTP controller over an INJECTED certification service. NO business logic: each handler maps the
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
function qualificationIdFrom(req) {
  return Number(req.params.qualificationId);
}
function learningPathIdFrom(req) {
  return Number(req.params.learningPathId);
}
function competencyIdFrom(req) {
  return Number(req.params.competencyId);
}

function handler(map, okStatus) {
  return async function certificationHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseCertificationController(service) {
  return {
    create: handler((req) => service.createCertification(req.body), 201),
    update: handler((req) => service.updateCertification(idFrom(req), req.body), 200),
    get: handler((req) => service.getCertification(idFrom(req)), 200),
    listRole: handler((req) => service.listRoleCertifications(roleIdFrom(req)), 200),
    listQualification: handler((req) => service.listQualificationCertifications(qualificationIdFrom(req)), 200),
    listLearningPath: handler((req) => service.listLearningPathCertifications(learningPathIdFrom(req)), 200),
    listCompetency: handler((req) => service.listCompetencyCertifications(competencyIdFrom(req)), 200),
    listActive: handler(() => service.activeCertifications(), 200),
    archive: handler((req) => service.archiveCertification(idFrom(req)), 200),
    restore: handler((req) => service.restoreCertification(idFrom(req)), 200),
    remove: handler((req) => service.deleteCertification(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseCertificationController };
