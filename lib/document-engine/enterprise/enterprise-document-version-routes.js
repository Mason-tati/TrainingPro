// WP-26 · Phase 4 — Enterprise Document Engine — Version Control — Routes.
//
// A REST-compliant Express router over an INJECTED controller, GATED behind the runtime feature flag:
// when DOCUMENT_ENGINE_ENABLED is unset/false (the default) every request short-circuits to 503 and
// no controller/service/repository runs. Created here for testing only; NOT mounted anywhere
// (server.js unchanged) — the engine stays invisible by default. No business logic. UNWIRED.
'use strict';

const express = require('express');
const runtimeFeatureFlag = require('../runtime-feature-flag');

const MOUNT_PATH = '/api/enterprise-document-versions';

function createEnterpriseDocumentVersionRoutes(controller) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!runtimeFeatureFlag.isEnabled()) {
      return res.status(503).json({ ok: false, error: 'document engine disabled', code: 'DISABLED' });
    }
    return next();
  });

  router.post('/', controller.create);
  // Document-scoped GETs are registered before '/:id' so they are not shadowed by the id matcher.
  router.get('/document/:documentId/current', controller.current);
  router.get('/document/:documentId', controller.list);
  router.get('/:id', controller.get);
  router.put('/:id', controller.update);
  router.post('/:id/archive', controller.archive);
  router.post('/:id/restore', controller.restore);
  router.delete('/:id', controller.remove);

  return router;
}

module.exports = { createEnterpriseDocumentVersionRoutes, MOUNT_PATH };
