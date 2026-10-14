// WP-18 · E4 — SearchService (Enterprise Document Engine).
// Orchestrates SearchRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class SearchService extends BaseService {
  constructor(searchRepository) {
    super(searchRepository, ['index', 'search']);
  }

  indexDocument(documentId, indexedText) { return this.repository.index(documentId, indexedText); }
  searchDocuments(query) { return this.repository.search(query); }
}

module.exports = SearchService;
