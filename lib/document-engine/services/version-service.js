// WP-18 · E4 — VersionService (Enterprise Document Engine).
// Orchestrates VersionRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class VersionService extends BaseService {
  constructor(versionRepository) {
    super(versionRepository, ['create', 'getLatest', 'listByDocument']);
  }

  createVersion(data) { return this.repository.create(data); }
  getLatestVersion(documentId) { return this.repository.getLatest(documentId); }
  listVersions(documentId) { return this.repository.listByDocument(documentId); }
}

module.exports = VersionService;
