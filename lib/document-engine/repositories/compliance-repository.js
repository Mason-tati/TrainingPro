// WP-18 · E3 — ComplianceRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
const COLS = ['DocumentID', 'Framework', 'LastAuditDate', 'NextAuditDate'];
class ComplianceRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocumentCompliance', data, COLS);
    const { lastID } = await this._run(sql, params);
    return this._get('SELECT * FROM tblDocumentCompliance WHERE ComplianceID = ?', [lastID]);
  }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentCompliance WHERE DocumentID = ? ORDER BY ComplianceID', [documentId]); }
}
module.exports = ComplianceRepository;
