// WP-26 · Phase 6 — Enterprise Document Engine — Distribution — Controller.
//
// A thin HTTP controller over an INJECTED distribution service. NO business logic: each handler maps
// the request to a single service call and maps the result's { ok, code } to an HTTP status. Never-
// throw: any unexpected error becomes a 500 JSON response. UNWIRED.
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
function versionIdFrom(req) {
  return Number(req.params.versionId);
}

function handler(map, okStatus) {
  return async function distributionHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseDocumentDistributionController(service) {
  return {
    create: handler((req) => service.createDistribution(req.body), 201),
    update: handler((req) => service.updateDistribution(idFrom(req), req.body), 200),
    get: handler((req) => service.getDistribution(idFrom(req)), 200),
    listVersion: handler((req) => service.listVersionDistributions(versionIdFrom(req)), 200),
    pending: handler(() => service.pendingDistributions(), 200),
    outstanding: handler(() => service.outstandingDistributions(), 200),
    acknowledge: handler((req) => service.acknowledgeDistribution(idFrom(req)), 200),
    archive: handler((req) => service.archiveDistribution(idFrom(req)), 200),
    restore: handler((req) => service.restoreDistribution(idFrom(req)), 200),
    remove: handler((req) => service.deleteDistribution(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentDistributionController };
