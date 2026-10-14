// WP-18 · E3 — RelationshipRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
const COLS = ['FromDocumentID', 'RelationshipType', 'ToDocumentID', 'CreatedBy'];
class RelationshipRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocumentRelationship', data, COLS);
    const { lastID } = await this._run(sql, params);
    return this._get('SELECT * FROM tblDocumentRelationship WHERE RelationshipID = ?', [lastID]);
  }
  listFrom(documentId) { return this._all('SELECT * FROM tblDocumentRelationship WHERE FromDocumentID = ? ORDER BY RelationshipID', [documentId]); }
  listTo(documentId) { return this._all('SELECT * FROM tblDocumentRelationship WHERE ToDocumentID = ? ORDER BY RelationshipID', [documentId]); }
  delete(relationshipId) { return this._run('DELETE FROM tblDocumentRelationship WHERE RelationshipID = ?', [relationshipId]); }
}
module.exports = RelationshipRepository;
