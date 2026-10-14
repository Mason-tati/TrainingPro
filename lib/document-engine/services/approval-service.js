// WP-18 · E4 — ApprovalService (Enterprise Document Engine).
// Orchestrates ApprovalRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class ApprovalService extends BaseService {
  constructor(approvalRepository) {
    super(approvalRepository, ['create', 'recordDecision']);
  }

  createApproval(data) { return this.repository.create(data); }
  recordApprovalDecision(approvalId, decision, comments, approver) {
    return this.repository.recordDecision(approvalId, decision, comments, approver);
  }
}

module.exports = ApprovalService;
