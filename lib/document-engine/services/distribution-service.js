// WP-18 · E4 — DistributionService (Enterprise Document Engine).
// Orchestrates DistributionRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class DistributionService extends BaseService {
  constructor(distributionRepository) {
    super(distributionRepository, ['create']);
  }

  createDistribution(data) { return this.repository.create(data); }
}

module.exports = DistributionService;
