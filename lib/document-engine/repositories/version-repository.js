// WP-18 · E3 — VersionRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
const COLS = ['DocumentID', 'VersionString', 'StoredName', 'OriginalName', 'MimeType', 'FileSize', 'Checksum', 'CreatedBy', 'Status'];
class VersionRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocumentVersion', data, COLS);
    const { lastID } = await this._run(sql, params);
    return this.getById(lastID);
  }
  getById(versionId) { return this._get('SELECT * FROM tblDocumentVersion WHERE VersionID = ?', [versionId]); }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentVersion WHERE DocumentID = ? ORDER BY VersionID', [documentId]); }
  getLatest(documentId) { return this._get('SELECT * FROM tblDocumentVersion WHERE DocumentID = ? ORDER BY VersionID DESC LIMIT 1', [documentId]); }
  delete(versionId) { return this._run('DELETE FROM tblDocumentVersion WHERE VersionID = ?', [versionId]); }
}
module.exports = VersionRepository;
