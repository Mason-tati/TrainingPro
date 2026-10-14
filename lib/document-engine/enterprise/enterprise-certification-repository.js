// WP-26 · Phase 17 — Enterprise Document Engine — Certification — Repository.
//
// Parameterized SQL over tblEnterpriseCertification via an INJECTED sqlite3 connection, reusing the
// certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps, and
// certification queries (by certification code / qualification / learning path / competency / role;
// active). certificationCode is the immutable business key (looked up for uniqueness enforcement in the
// service). UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseCertification';

const INSERTABLE = [
  'certificationCode', 'certificationName', 'description', 'department', 'site', 'businessUnit', 'roleId',
  'qualificationId', 'learningPathId', 'competencyId', 'issuingAuthority', 'issueDate', 'expiryDate',
  'renewalRequired', 'status', 'metadataJson', 'active', 'archived', 'deleted',
];
// certificationCode is the immutable business key and is never updated.
const UPDATABLE = [
  'certificationName', 'description', 'department', 'site', 'businessUnit', 'roleId', 'qualificationId',
  'learningPathId', 'competencyId', 'issuingAuthority', 'issueDate', 'expiryDate', 'renewalRequired',
  'status', 'metadataJson', 'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'department', 'site', 'businessUnit', 'roleId', 'qualificationId', 'learningPathId', 'competencyId',
  'issuingAuthority', 'renewalRequired', 'status', 'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseCertificationRepository extends BaseRepository {
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

  findByCertificationCode(certificationCode) {
    return this._get(`SELECT * FROM ${TABLE} WHERE certificationCode = ? AND deleted = 0`, [certificationCode]);
  }

  findByQualification(qualificationId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE qualificationId = ? AND deleted = 0 ORDER BY id`, [qualificationId]);
  }

  findByLearningPath(learningPathId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE learningPathId = ? AND deleted = 0 ORDER BY id`, [learningPathId]);
  }

  findByCompetency(competencyId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE competencyId = ? AND deleted = 0 ORDER BY id`, [competencyId]);
  }

  findByRole(roleId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE roleId = ? AND deleted = 0 ORDER BY id`, [roleId]);
  }

  findActive() {
    return this._all(`SELECT * FROM ${TABLE} WHERE active = 1 AND deleted = 0 ORDER BY id`, []);
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

module.exports = EnterpriseCertificationRepository;
