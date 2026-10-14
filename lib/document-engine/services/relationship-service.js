// WP-18 · E4 — RelationshipService (Enterprise Document Engine).
// Orchestrates RelationshipRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class RelationshipService extends BaseService {
  constructor(relationshipRepository) {
    super(relationshipRepository, ['create', 'delete']);
  }

  linkDocuments(data) { return this.repository.create(data); }
  unlinkDocuments(relationshipId) { return this.repository.delete(relationshipId); }
}

module.exports = RelationshipService;
