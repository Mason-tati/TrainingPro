// WP-18 · E3 — SearchRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
class SearchRepository extends BaseRepository {
  async index(documentId, indexedText) {
    const existing = await this._get('SELECT IndexID FROM tblDocumentSearchIndex WHERE DocumentID = ?', [documentId]);
    if (existing) await this._run("UPDATE tblDocumentSearchIndex SET IndexedText = ?, IndexedDate = datetime('now') WHERE IndexID = ?", [indexedText, existing.IndexID]);
    else await this._run("INSERT INTO tblDocumentSearchIndex (DocumentID, IndexedText, IndexedDate) VALUES (?, ?, datetime('now'))", [documentId, indexedText]);
    return this.getByDocument(documentId);
  }
  getByDocument(documentId) { return this._get('SELECT * FROM tblDocumentSearchIndex WHERE DocumentID = ?', [documentId]); }
  search(query) { return this._all('SELECT * FROM tblDocumentSearchIndex WHERE IndexedText LIKE ? ORDER BY DocumentID', ['%' + String(query == null ? '' : query) + '%']); }
}
module.exports = SearchRepository;
