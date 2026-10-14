// WP-18 · E4 — DocumentService (Enterprise Document Engine).
// Orchestrates DocumentRepository. Pure coordination — no SQL, no logging, no audit.
// Deletion is a soft-delete (business rule); inputs are passed through untouched. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class DocumentService extends BaseService {
  constructor(documentRepository) {
    super(documentRepository, ['create', 'getById', 'update', 'softDelete', 'restore', 'list']);
  }

  createDocument(data) { return this.repository.create(data); }
  getDocument(documentId) { return this.repository.getById(documentId); }
  updateDocument(documentId, patch) { return this.repository.update(documentId, patch); }
  deleteDocument(documentId) { return this.repository.softDelete(documentId); }
  restoreDocument(documentId) { return this.repository.restore(documentId); }
  listDocuments(filters) { return this.repository.list(filters); }
}

module.exports = DocumentService;
