// WP-18 · E3 — DocumentRepository (Enterprise Document Engine).
// Parameterized SQL over tblDocument via an injected sqlite3 connection. UNWIRED.
'use strict';

const BaseRepository = require('./base-repository');

// Fixed allow-lists — column names are NEVER taken from untrusted input.
const INSERTABLE = [
  'DocumentNumber', 'Title', 'Description', 'DocumentType', 'DocumentStatus', 'WorkflowID',
  'VersionScheme', 'VersionMajor', 'VersionMinor', 'VersionPatch', 'Revision', 'Classification',
  'ComplianceFramework', 'Owner', 'Author', 'Department', 'Site', 'EffectiveDate', 'ReviewDate',
  'ExpiryDate', 'CreatedBy',
];
const UPDATABLE = [
  'Title', 'Description', 'DocumentType', 'DocumentStatus', 'WorkflowID', 'VersionScheme',
  'VersionMajor', 'VersionMinor', 'VersionPatch', 'Revision', 'Classification', 'ComplianceFramework',
  'Owner', 'Author', 'Department', 'Site', 'EffectiveDate', 'ReviewDate', 'ExpiryDate', 'UpdatedBy',
];
const FILTERABLE = ['DocumentType', 'DocumentStatus', 'WorkflowID', 'Owner', 'Author', 'Department', 'Site', 'Classification', 'ComplianceFramework'];

class DocumentRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocument', data, INSERTABLE);
    const { lastID } = await this._run(sql, params);
    return this.getById(lastID);
  }

  getById(documentId) {
    return this._get('SELECT * FROM tblDocument WHERE DocumentID = ? AND IsDeleted = 0', [documentId]);
  }

  getByNumber(documentNumber) {
    return this._get('SELECT * FROM tblDocument WHERE DocumentNumber = ? AND IsDeleted = 0', [documentNumber]);
  }

  // Filters use the allow-list ONLY; unknown keys are ignored (never become SQL).
  list(filters) {
    const src = (filters && typeof filters === 'object' && !Array.isArray(filters)) ? filters : {};
    const where = ['IsDeleted = 0'];
    const params = [];
    for (const col of FILTERABLE) {
      if (src[col] !== undefined) { where.push(`${col} = ?`); params.push(src[col]); }
    }
    return this._all(`SELECT * FROM tblDocument WHERE ${where.join(' AND ')} ORDER BY DocumentID`, params);
  }

  async update(documentId, patch) {
    const src = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch : {};
    const sets = [];
    const params = [];
    for (const col of UPDATABLE) {
      if (src[col] !== undefined) { sets.push(`${col} = ?`); params.push(src[col]); }
    }
    sets.push("UpdatedDate = datetime('now')");
    params.push(documentId);
    await this._run(`UPDATE tblDocument SET ${sets.join(', ')} WHERE DocumentID = ? AND IsDeleted = 0`, params);
    return this.getById(documentId);
  }

  softDelete(documentId) {
    return this._run("UPDATE tblDocument SET IsDeleted = 1, UpdatedDate = datetime('now') WHERE DocumentID = ? AND IsDeleted = 0", [documentId]);
  }

  restore(documentId) {
    return this._run("UPDATE tblDocument SET IsDeleted = 0, UpdatedDate = datetime('now') WHERE DocumentID = ? AND IsDeleted = 1", [documentId]);
  }
}

module.exports = DocumentRepository;
