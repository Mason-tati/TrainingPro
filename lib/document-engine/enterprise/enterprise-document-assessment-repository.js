// WP-26 · Phase 9 — Enterprise Document Engine — Assessment Management — Repository.
//
// Parameterized SQL over tblEnterpriseDocumentAssessment via an INJECTED sqlite3 connection, reusing
// the certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps,
// and lifecycle/expiry queries (by version / active / expired / published). Expiry is evaluated in
// SQL (expiryDate < now). UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseDocumentAssessment';

const INSERTABLE = [
  'documentVersionId', 'assessmentId', 'assessmentCode', 'assessmentTitle', 'assessmentType',
  'passMark', 'maximumAttempts', 'timeLimitMinutes', 'questionCount', 'randomizeQuestions',
  'randomizeAnswers', 'assessmentStatus', 'effectiveDate', 'expiryDate', 'metadataJson', 'active',
  'archived', 'deleted',
];
// documentVersionId immutable.
const UPDATABLE = [
  'assessmentId', 'assessmentCode', 'assessmentTitle', 'assessmentType', 'passMark', 'maximumAttempts',
  'timeLimitMinutes', 'questionCount', 'randomizeQuestions', 'randomizeAnswers', 'assessmentStatus',
  'effectiveDate', 'expiryDate', 'metadataJson', 'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'documentVersionId', 'assessmentId', 'assessmentCode', 'assessmentType', 'assessmentStatus',
  'randomizeQuestions', 'randomizeAnswers', 'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseDocumentAssessmentRepository extends BaseRepository {
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

  findByVersion(documentVersionId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE documentVersionId = ? AND deleted = 0 ORDER BY id`, [documentVersionId]);
  }

  findActive() {
    return this._all(`SELECT * FROM ${TABLE} WHERE active = 1 AND deleted = 0 ORDER BY id`, []);
  }

  findExpired() {
    return this._all(
      `SELECT * FROM ${TABLE} WHERE expiryDate IS NOT NULL AND expiryDate < datetime('now') AND deleted = 0 ORDER BY expiryDate, id`,
      [],
    );
  }

  findPublished() {
    return this._all(`SELECT * FROM ${TABLE} WHERE assessmentStatus = 'PUBLISHED' AND deleted = 0 ORDER BY id`, []);
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

module.exports = EnterpriseDocumentAssessmentRepository;
