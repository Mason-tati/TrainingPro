// WP-18 · E3 — ValidationRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
class ValidationRepository extends BaseRepository {
  async create(data) {
    const src = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    const { lastID } = await this._run(
      "INSERT INTO tblDocumentValidation (DocumentID, RuleID, Result, ValidatedDate) VALUES (?, ?, ?, COALESCE(?, datetime('now')))",
      [src.DocumentID, src.RuleID, src.Result, src.ValidatedDate === undefined ? null : src.ValidatedDate],
    );
    return this._get('SELECT * FROM tblDocumentValidation WHERE ValidationID = ?', [lastID]);
  }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentValidation WHERE DocumentID = ? ORDER BY ValidationID', [documentId]); }
}
module.exports = ValidationRepository;
