// WP-26 · Phase 18 (FINAL) — Enterprise Document Engine — Compliance — Routes.
//
// A REST-compliant Express router over an INJECTED controller, GATED behind the runtime feature flag:
// when DOCUMENT_ENGINE_ENABLED is unset/false (the default) every request short-circuits to 503 and no
// controller/service/repository runs. Created here for testing only; NOT mounted anywhere (server.js
// unchanged) — the engine stays invisible by default. No business logic. UNWIRED.
'use strict';

const express = require('express');
const runtimeFeatureFlag = require('../runtime-feature-flag');

const MOUNT_PATH = '/api/enterprise-compliance';

function createEnterpriseComplianceRoutes(controller) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!runtimeFeatureFlag.isEnabled()) {
      return res.status(503).json({ ok: false, error: 'document engine disabled', code: 'DISABLED' });
    }
    return next();
  });

  router.post('/', controller.create);
  // Specific GETs are registered before '/:id' so they are not shadowed by the id matcher.
  router.get('/compliant', controller.listCompliant);
  router.get('/non-compliant', controller.listNonCompliant);
  router.get('/expired', controller.listExpired);
  router.get('/overdue', controller.listOverdue);
  router.get('/employee/:employeeId', controller.listEmployee);
  router.get('/role/:roleId', controller.listRole);
  router.get('/qualification/:qualificationId', controller.listQualification);
  router.get('/certification/:certificationId', controller.listCertification);
  router.get('/learning-path/:learningPathId', controller.listLearningPath);
  router.get('/competency/:competencyId', controller.listCompetency);
  router.get('/:id', controller.get);
  router.put('/:id', controller.update);
  router.post('/:id/archive', controller.archive);
  router.post('/:id/restore', controller.restore);
  router.delete('/:id', controller.remove);

  return router;
}

module.exports = { createEnterpriseComplianceRoutes, MOUNT_PATH };
