// WP-26 · Phase 1 — Enterprise Document Engine Foundation — Repository.
//
// Parameterized SQL over tblEnterpriseDocument via an INJECTED sqlite3 connection. It reuses the
// certified BaseRepository (promisified run/get/all) — no duplicated persistence primitives. It
// contains NO business logic: column names come from fixed allow-lists (never from untrusted input),
// createdAt/updatedAt are stamped by SQLite (keeping callers deterministic), and every method is a
// direct persistence operation. UNWIRED — nothing in production imports it.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseDocument';

// Columns a caller may set on create (id/createdAt/updatedAt are managed here, never by input).
const INSERTABLE = [
  'documentNumber', 'title', 'description', 'category', 'subCategory', 'documentType',
  'versionMajor', 'versionMinor', 'status', 'ownerId', 'approverId', 'securityClassification',
  'language', 'approvedAt', 'effectiveDate', 'reviewDate', 'expiryDate', 'supersededBy',
  'currentVersion', 'archived', 'deleted', 'metadataJson',
];
// Columns a caller may change on update (id/documentNumber/createdAt immutable; updatedAt automatic).
const UPDATABLE = [
  'title', 'description', 'category', 'subCategory', 'documentType', 'versionMajor', 'versionMinor',
  'status', 'ownerId', 'approverId', 'securityClassification', 'language', 'approvedAt',
  'effectiveDate', 'reviewDate', 'expiryDate', 'supersededBy', 'currentVersion', 'archived',
  'deleted', 'metadataJson',
];
// Columns that may be used as equality filters in findAll/count (allow-list only).
const FILTERABLE = [
  'category', 'subCategory', 'documentType', 'status', 'ownerId', 'approverId',
  'securityClassification', 'language', 'currentVersion', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseDocumentRepository extends BaseRepository {
  // Insert an allow-listed row; createdAt/updatedAt are stamped by SQLite. Returns the new row.
  create(data) {
    const src = isPlainObject(data) ? data : {};
    const cols = INSERTABLE.filter((c) => src[c] !== undefined);
    const params = cols.map((c) => src[c]);
    const allCols = cols.concat(['createdAt', 'updatedAt']);
    const allVals = cols.map(() => '?').concat(["datetime('now')", "datetime('now')"]);
    const sql = `INSERT INTO ${TABLE} (${allCols.join(', ')}) VALUES (${allVals.join(', ')})`;
    return this._run(sql, params).then((r) => this.findById(r.lastID));
  }

  // Update allow-listed columns; updatedAt is always refreshed. Returns the updated (non-deleted) row.
  update(id, patch) {
    const src = isPlainObject(patch) ? patch : {};
    const sets = [];
    const params = [];
    for (const col of UPDATABLE) {
      if (src[col] !== undefined) { sets.push(`${col} = ?`); params.push(src[col]); }
    }
    sets.push("updatedAt = datetime('now')");
    params.push(id);
    return this._run(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ? AND deleted = 0`, params)
      .then(() => this.findById(id));
  }

  findById(id) {
    return this._get(`SELECT * FROM ${TABLE} WHERE id = ? AND deleted = 0`, [id]);
  }

  findByNumber(documentNumber) {
    return this._get(`SELECT * FROM ${TABLE} WHERE documentNumber = ? AND deleted = 0`, [documentNumber]);
  }

  findAll(filters) {
    const src = isPlainObject(filters) ? filters : {};
    const where = ['deleted = 0'];
    const params = [];
    for (const col of FILTERABLE) {
      if (src[col] !== undefined) { where.push(`${col} = ?`); params.push(src[col]); }
    }
    return this._all(`SELECT * FROM ${TABLE} WHERE ${where.join(' AND ')} ORDER BY id`, params);
  }

  archive(id) {
    return this._run(`UPDATE ${TABLE} SET archived = 1, updatedAt = datetime('now') WHERE id = ?`, [id]);
  }

  softDelete(id) {
    return this._run(`UPDATE ${TABLE} SET deleted = 1, updatedAt = datetime('now') WHERE id = ?`, [id]);
  }

  restore(id) {
    return this._run(`UPDATE ${TABLE} SET deleted = 0, archived = 0, updatedAt = datetime('now') WHERE id = ?`, [id]);
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

module.exports = EnterpriseDocumentRepository;
