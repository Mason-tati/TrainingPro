// WP-18 · E3 — DistributionRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
const COLS = ['DocumentID', 'DistributionType', 'Target'];
class DistributionRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocumentDistribution', data, COLS);
    const { lastID } = await this._run(sql, params);
    return this._get('SELECT * FROM tblDocumentDistribution WHERE DistributionID = ?', [lastID]);
  }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentDistribution WHERE DocumentID = ? ORDER BY DistributionID', [documentId]); }
  delete(distributionId) { return this._run('DELETE FROM tblDocumentDistribution WHERE DistributionID = ?', [distributionId]); }
}
module.exports = DistributionRepository;
