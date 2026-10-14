// WP-26 · Phase 7 — Enterprise Document Engine — Training Assignment — Repository.
//
// Parameterized SQL over tblEnterpriseDocumentTraining via an INJECTED sqlite3 connection, reusing
// the certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps,
// and status/overdue queries (by version / pending / completed / overdue). assignedDate is stamped
// at creation; completedDate is stamped by SQLite when update() is asked to. Overdue is evaluated in
// SQL (dueDate < now, not completed). UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseDocumentTraining';

const INSERTABLE = [
  'documentVersionId', 'trainingProgramId', 'courseId', 'competencyId', 'userId', 'dueDate',
  'trainingStatus', 'mandatoryTraining', 'assessmentRequired', 'assessmentPassed', 'score', 'attempts',
  'metadataJson', 'active', 'archived', 'deleted',
];
// documentVersionId/userId immutable; assignedDate at creation; completedDate stamped via SQL sentinel.
const UPDATABLE = [
  'trainingProgramId', 'courseId', 'competencyId', 'dueDate', 'trainingStatus', 'mandatoryTraining',
  'assessmentRequired', 'assessmentPassed', 'score', 'attempts', 'metadataJson', 'active', 'archived',
  'deleted',
];
const NOW_COLUMNS = ['completedDate'];
const FILTERABLE = [
  'documentVersionId', 'trainingProgramId', 'courseId', 'competencyId', 'userId', 'trainingStatus',
  'mandatoryTraining', 'assessmentRequired', 'assessmentPassed', 'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseDocumentTrainingRepository extends BaseRepository {
  create(data) {
    const src = isPlainObject(data) ? data : {};
    const cols = INSERTABLE.filter((c) => src[c] !== undefined);
    const params = cols.map((c) => src[c]);
    const allCols = cols.concat(['assignedDate', 'createdAt', 'updatedAt']);
    const allVals = cols.map(() => '?').concat(["datetime('now')", "datetime('now')", "datetime('now')"]);
    const sql = `INSERT INTO ${TABLE} (${allCols.join(', ')}) VALUES (${allVals.join(', ')})`;
    return this._run(sql, params).then((r) => this.findById(r.lastID));
  }

  // Update allow-listed columns; completedDate set to `true` is stamped via SQLite.
  update(id, patch) {
    const src = isPlainObject(patch) ? patch : {};
    const sets = [];
    const params = [];
    for (const col of UPDATABLE) {
      if (src[col] !== undefined) { sets.push(`${col} = ?`); params.push(src[col]); }
    }
    for (const col of NOW_COLUMNS) {
      if (src[col] === true) { sets.push(`${col} = datetime('now')`); }
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

  findPending() {
    return this._all(`SELECT * FROM ${TABLE} WHERE trainingStatus IN ('ASSIGNED', 'IN_PROGRESS') AND deleted = 0 ORDER BY dueDate, id`, []);
  }

  findCompleted() {
    return this._all(`SELECT * FROM ${TABLE} WHERE trainingStatus = 'COMPLETED' AND deleted = 0 ORDER BY completedDate, id`, []);
  }

  findOverdue() {
    return this._all(
      `SELECT * FROM ${TABLE} WHERE completedDate IS NULL AND dueDate IS NOT NULL AND dueDate < datetime('now') AND deleted = 0 ORDER BY dueDate, id`,
      [],
    );
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

module.exports = EnterpriseDocumentTrainingRepository;
