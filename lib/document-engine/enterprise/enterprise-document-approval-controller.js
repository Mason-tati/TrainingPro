// WP-26 · Phase 5 — Enterprise Document Engine — Approval Workflow — Controller.
//
// A thin HTTP controller over an INJECTED approval service. NO business logic: each handler maps the
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
function versionIdFrom(req) {
  return Number(req.params.versionId);
}

function handler(map, okStatus) {
  return async function approvalHandler(req, res) {
    try {
      const result = await map(req);
      const status = result.ok ? okStatus : (ERROR_STATUS[result.code] || 500);
      return res.status(status).json(result);
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' });
    }
  };
}

function createEnterpriseDocumentApprovalController(service) {
  return {
    create: handler((req) => service.createApproval(req.body), 201),
    update: handler((req) => service.updateApproval(idFrom(req), req.body), 200),
    get: handler((req) => service.getApproval(idFrom(req)), 200),
    listVersion: handler((req) => service.listVersionApprovals(versionIdFrom(req)), 200),
    pending: handler(() => service.pendingApprovals(), 200),
    approve: handler((req) => service.approveApproval(idFrom(req)), 200),
    reject: handler((req) => service.rejectApproval(idFrom(req)), 200),
    delegate: handler((req) => service.delegateApproval(idFrom(req), req.body.delegatedTo), 200),
    archive: handler((req) => service.archiveApproval(idFrom(req)), 200),
    restore: handler((req) => service.restoreApproval(idFrom(req)), 200),
    remove: handler((req) => service.deleteApproval(idFrom(req)), 200),
  };
}

module.exports = { createEnterpriseDocumentApprovalController };
