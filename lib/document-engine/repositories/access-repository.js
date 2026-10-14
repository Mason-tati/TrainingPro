// WP-18 · E3 — AccessRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
const COLS = ['DocumentID', 'AccessMode', 'Principal'];
class AccessRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocumentAccess', data, COLS);
    const { lastID } = await this._run(sql, params);
    return this._get('SELECT * FROM tblDocumentAccess WHERE AccessID = ?', [lastID]);
  }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentAccess WHERE DocumentID = ? ORDER BY AccessID', [documentId]); }
  delete(accessId) { return this._run('DELETE FROM tblDocumentAccess WHERE AccessID = ?', [accessId]); }
}
module.exports = AccessRepository;
