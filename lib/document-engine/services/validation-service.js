// WP-18 · E4 — ValidationService (Enterprise Document Engine).
// Orchestrates ValidationRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class ValidationService extends BaseService {
  constructor(validationRepository) {
    super(validationRepository, ['create']);
  }

  validateDocument(data) { return this.repository.create(data); }
}

module.exports = ValidationService;
