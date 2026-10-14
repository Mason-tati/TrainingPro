// WP-18 · E3 — MetadataRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
class MetadataRepository extends BaseRepository {
  async set(documentId, fieldId, value) {
    const existing = await this._get('SELECT MetadataID FROM tblDocumentMetadata WHERE DocumentID = ? AND FieldID = ?', [documentId, fieldId]);
    if (existing) await this._run('UPDATE tblDocumentMetadata SET FieldValue = ? WHERE MetadataID = ?', [value, existing.MetadataID]);
    else await this._run('INSERT INTO tblDocumentMetadata (DocumentID, FieldID, FieldValue) VALUES (?, ?, ?)', [documentId, fieldId, value]);
    return this.get(documentId, fieldId);
  }
  get(documentId, fieldId) { return this._get('SELECT * FROM tblDocumentMetadata WHERE DocumentID = ? AND FieldID = ?', [documentId, fieldId]); }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentMetadata WHERE DocumentID = ? ORDER BY MetadataID', [documentId]); }
  delete(documentId, fieldId) { return this._run('DELETE FROM tblDocumentMetadata WHERE DocumentID = ? AND FieldID = ?', [documentId, fieldId]); }
}
module.exports = MetadataRepository;
