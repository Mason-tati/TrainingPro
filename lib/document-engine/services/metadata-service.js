// WP-18 · E4 — MetadataService (Enterprise Document Engine).
// Orchestrates MetadataRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class MetadataService extends BaseService {
  constructor(metadataRepository) {
    super(metadataRepository, ['set', 'get']);
  }

  setMetadata(documentId, fieldId, value) { return this.repository.set(documentId, fieldId, value); }
  getMetadata(documentId, fieldId) { return this.repository.get(documentId, fieldId); }
}

module.exports = MetadataService;
