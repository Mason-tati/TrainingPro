// WP-26 · Phase 1 — Enterprise Document Engine Foundation — Routes.
//
// A REST-compliant Express router over an INJECTED controller, GATED behind the runtime feature flag:
// when DOCUMENT_ENGINE_ENABLED is unset/false (the default) every request short-circuits to 503 and
// no controller/service/repository runs. The router is created here but is NOT mounted anywhere
// (server.js is unchanged) — the engine stays invisible by default. No business logic. UNWIRED.
'use strict';

const express = require('express');
const runtimeFeatureFlag = require('../runtime-feature-flag');

const MOUNT_PATH = '/api/enterprise-documents';

// Build the router over an injected controller (dependency injection). The feature-flag gate runs
// first, so a disabled engine never reaches any route handler.
function createEnterpriseDocumentRoutes(controller) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!runtimeFeatureFlag.isEnabled()) {
      return res.status(503).json({ ok: false, error: 'document engine disabled', code: 'DISABLED' });
    }
    return next();
  });

  router.post('/', controller.create);
  router.get('/', controller.list);
  router.get('/:id', controller.get);
  router.put('/:id', controller.update);
  router.post('/:id/archive', controller.archive);
  router.post('/:id/restore', controller.restore);
  router.delete('/:id', controller.remove);

  return router;
}

module.exports = { createEnterpriseDocumentRoutes, MOUNT_PATH };
