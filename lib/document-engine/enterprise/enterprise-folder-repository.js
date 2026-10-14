// WP-26 · Phase 2 — Enterprise Document Engine — Folder Management — Repository.
//
// Parameterized SQL over tblEnterpriseFolder via an INJECTED sqlite3 connection, reusing the
// certified BaseRepository. It contains NO business logic: allow-listed columns, SQLite-stamped
// timestamps, and direct persistence operations only (hierarchy is expressed via parentFolderId /
// folderPath, both computed by the service). UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseFolder';

const INSERTABLE = [
  'parentFolderId', 'folderNumber', 'folderName', 'description', 'category', 'subCategory',
  'department', 'site', 'businessUnit', 'securityClassification', 'ownerId', 'folderPath',
  'folderDepth', 'sortOrder', 'retentionCategory', 'active', 'archived', 'deleted', 'metadataJson',
];
// folderNumber/id/createdAt immutable; folderPath/folderDepth/parentFolderId change only via moveFolder.
const UPDATABLE = [
  'folderName', 'description', 'category', 'subCategory', 'department', 'site', 'businessUnit',
  'securityClassification', 'ownerId', 'sortOrder', 'retentionCategory', 'active', 'archived',
  'deleted', 'metadataJson',
];
const FILTERABLE = [
  'parentFolderId', 'folderNumber', 'category', 'subCategory', 'department', 'site', 'businessUnit',
  'securityClassification', 'ownerId', 'retentionCategory', 'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseFolderRepository extends BaseRepository {
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

  findChildren(parentFolderId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE parentFolderId = ? AND deleted = 0 ORDER BY sortOrder, id`, [parentFolderId]);
  }

  findByPath(folderPath) {
    return this._get(`SELECT * FROM ${TABLE} WHERE folderPath = ? AND deleted = 0`, [folderPath]);
  }

  findRootFolders() {
    return this._all(`SELECT * FROM ${TABLE} WHERE parentFolderId IS NULL AND deleted = 0 ORDER BY sortOrder, id`, []);
  }

  moveFolder(id, target) {
    return this._run(
      `UPDATE ${TABLE} SET parentFolderId = ?, folderPath = ?, folderDepth = ?, updatedAt = datetime('now') WHERE id = ?`,
      [target.parentFolderId, target.folderPath, target.folderDepth, id],
    ).then(() => this.findById(id));
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

module.exports = EnterpriseFolderRepository;
