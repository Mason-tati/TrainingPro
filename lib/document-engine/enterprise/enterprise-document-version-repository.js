// WP-26 · Phase 4 — Enterprise Document Engine — Version Control — Repository.
//
// Parameterized SQL over tblEnterpriseDocumentVersion via an INJECTED sqlite3 connection, reusing the
// certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps, and
// direct persistence + query operations (by document, current, specific version). The current version
// is the non-superseded one; supersededDate is stamped by SQLite when update() is asked to supersede.
// UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseDocumentVersion';

const INSERTABLE = [
  'documentId', 'majorVersion', 'minorVersion', 'versionNumber', 'changeSummary', 'authorId',
  'approvalStatus', 'approvedBy', 'approvedDate', 'effectiveDate', 'fileName', 'fileExtension',
  'mimeType', 'fileSize', 'checksum', 'storagePath', 'metadataJson', 'active', 'archived', 'deleted',
];
// documentId + version identity (major/minor/versionNumber) immutable; supersededDate stamped by SQL.
const UPDATABLE = [
  'changeSummary', 'authorId', 'approvalStatus', 'approvedBy', 'approvedDate', 'effectiveDate',
  'fileName', 'fileExtension', 'mimeType', 'fileSize', 'checksum', 'storagePath', 'metadataJson',
  'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'documentId', 'approvalStatus', 'majorVersion', 'minorVersion', 'active', 'archived', 'authorId',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseDocumentVersionRepository extends BaseRepository {
  create(data) {
    const src = isPlainObject(data) ? data : {};
    const cols = INSERTABLE.filter((c) => src[c] !== undefined);
    const params = cols.map((c) => src[c]);
    const allCols = cols.concat(['createdAt', 'updatedAt']);
    const allVals = cols.map(() => '?').concat(["datetime('now')", "datetime('now')"]);
    const sql = `INSERT INTO ${TABLE} (${allCols.join(', ')}) VALUES (${allVals.join(', ')})`;
    return this._run(sql, params).then((r) => this.findById(r.lastID));
  }

  // Update allow-listed columns; `supersededDate: true` stamps the supersede time via SQLite.
  update(id, patch) {
    const src = isPlainObject(patch) ? patch : {};
    const sets = [];
    const params = [];
    for (const col of UPDATABLE) {
      if (src[col] !== undefined) { sets.push(`${col} = ?`); params.push(src[col]); }
    }
    if (src.supersededDate === true) { sets.push("supersededDate = datetime('now')"); }
    sets.push("updatedAt = datetime('now')");
    params.push(id);
    return this._run(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ? AND deleted = 0`, params)
      .then(() => this.findById(id));
  }

  findById(id) {
    return this._get(`SELECT * FROM ${TABLE} WHERE id = ? AND deleted = 0`, [id]);
  }

  findByDocument(documentId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE documentId = ? AND deleted = 0 ORDER BY majorVersion, minorVersion, id`, [documentId]);
  }

  findCurrent(documentId) {
    return this._get(
      `SELECT * FROM ${TABLE} WHERE documentId = ? AND deleted = 0 AND supersededDate IS NULL ORDER BY majorVersion DESC, minorVersion DESC LIMIT 1`,
      [documentId],
    );
  }

  findVersion(documentId, versionNumber) {
    return this._get(`SELECT * FROM ${TABLE} WHERE documentId = ? AND versionNumber = ? AND deleted = 0`, [documentId, versionNumber]);
  }

  archive(id) {
    return this._run(`UPDATE ${TABLE} SET archived = 1, updatedAt = datetime('now') WHERE id = ?`, [id]);
  }

  restore(id) {
    return this._run(`UPDATE ${TABLE} SET deleted = 0, archived = 0, active = 1, updatedAt = datetime('now') WHERE id = ?`, [id]);
  }

  softDelete(id) {
    return this._run(`UPDATE ${TABLE} SET deleted = 1, active = 0, updatedAt = datetime('now') WHERE id = ?`, [id]);
  }

  exists(id) {
    return this._get(`SELECT 1 AS present FROM ${TABLE} WHERE id = ?`, [id]).then((row) => row !== null);
  }

  count(filters) {
    const src = isPlainObject(filters) ? filters : {};
    const where = ['deleted = 0'];
    const params = [];
    for (const col of FILTERABLE) {
      if (src[col] !== undefined) { where.push(`${col} = ?`); params.push(src[col]); }
    }
    return this._get(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${where.join(' AND ')}`, params).then((row) => row.total);
  }
}

module.exports = EnterpriseDocumentVersionRepository;
