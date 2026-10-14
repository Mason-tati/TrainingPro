// WP-26 · Phase 3 — Enterprise Document Engine — Document Core — Repository.
//
// Parameterized SQL over tblEnterpriseDocumentCore via an INJECTED sqlite3 connection, reusing the
// certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps, and
// direct persistence + query operations (by number/folder/status, plus an allow-listed search).
// UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseDocumentCore';

const INSERTABLE = [
  'folderId', 'documentNumber', 'documentTitle', 'documentType', 'revision', 'status', 'description',
  'keywords', 'ownerId', 'department', 'site', 'businessUnit', 'securityClassification',
  'retentionCategory', 'effectiveDate', 'reviewDate', 'expiryDate', 'language', 'fileName',
  'fileExtension', 'mimeType', 'fileSize', 'checksum', 'storagePath', 'metadataJson', 'active',
  'archived', 'deleted',
];
// documentNumber/id/createdAt immutable; updatedAt automatic.
const UPDATABLE = [
  'folderId', 'documentTitle', 'documentType', 'revision', 'status', 'description', 'keywords',
  'ownerId', 'department', 'site', 'businessUnit', 'securityClassification', 'retentionCategory',
  'effectiveDate', 'reviewDate', 'expiryDate', 'language', 'fileName', 'fileExtension', 'mimeType',
  'fileSize', 'checksum', 'storagePath', 'metadataJson', 'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'folderId', 'status', 'documentType', 'department', 'site', 'businessUnit', 'securityClassification',
  'retentionCategory', 'ownerId', 'language', 'active', 'archived', 'revision',
];
// Fields usable as exact-match search criteria.
const SEARCHABLE = [
  'folderId', 'status', 'documentType', 'department', 'site', 'businessUnit', 'securityClassification',
  'retentionCategory', 'ownerId', 'language',
];
// Fields matched by a free-text `text` search term (LIKE).
const TEXT_FIELDS = ['documentTitle', 'keywords', 'documentNumber'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseDocumentCoreRepository extends BaseRepository {
  create(data) {
    const src = isPlainObject(data) ? data : {};
    const cols = INSERTABLE.filter((c) => src[c] !== undefined);
    const params = cols.map((c) => src[c]);
    const allCols = cols.concat(['createdAt', 'updatedAt']);
    const allVals = cols.map(() => '?').concat(["datetime('now')", "datetime('now')"]);
    const sql = `INSERT INTO ${TABLE} (${allCols.join(', ')}) VALUES (${allVals.join(', ')})`;
    return this._run(sql, params).then((r) => this.findById(r.lastID));
  }

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

  findByFolder(folderId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE folderId = ? AND deleted = 0 ORDER BY id`, [folderId]);
  }

  findByStatus(status) {
    return this._all(`SELECT * FROM ${TABLE} WHERE status = ? AND deleted = 0 ORDER BY id`, [status]);
  }

  // Allow-listed search: exact-match filters plus an optional free-text term over title/keywords/number.
  search(criteria) {
    const src = isPlainObject(criteria) ? criteria : {};
    const where = ['deleted = 0'];
    const params = [];
    for (const col of SEARCHABLE) {
      if (src[col] !== undefined) { where.push(`${col} = ?`); params.push(src[col]); }
    }
    if (src.text !== undefined) {
      where.push(`(${TEXT_FIELDS.map((f) => `${f} LIKE ?`).join(' OR ')})`);
      const like = `%${src.text}%`;
      for (let i = 0; i < TEXT_FIELDS.length; i += 1) params.push(like);
    }
    return this._all(`SELECT * FROM ${TABLE} WHERE ${where.join(' AND ')} ORDER BY id`, params);
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

module.exports = EnterpriseDocumentCoreRepository;
