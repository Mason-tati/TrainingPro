// WP-18 · E4 — ComplianceService (Enterprise Document Engine).
// Orchestrates ComplianceRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class ComplianceService extends BaseService {
  constructor(complianceRepository) {
    super(complianceRepository, ['create']);
  }

  recordCompliance(data) { return this.repository.create(data); }
}

module.exports = ComplianceService;
