// WP-18 · E4 — AccessService (Enterprise Document Engine).
// Orchestrates AccessRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class AccessService extends BaseService {
  constructor(accessRepository) {
    super(accessRepository, ['create']);
  }

  grantAccess(data) { return this.repository.create(data); }
}

module.exports = AccessService;
