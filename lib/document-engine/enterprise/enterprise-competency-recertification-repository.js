// WP-26 · Phase 13 — Enterprise Document Engine — Competency Recertification — Repository.
//
// Parameterized SQL over tblEnterpriseCompetencyRecertification via an INJECTED sqlite3 connection,
// reusing the certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped
// timestamps, and workflow / scheduling / overdue queries (by employee / competency; due / scheduled /
// completed; overdue; active). completedDate supports a boolean sentinel (true → datetime('now')) so the
// completion instant is stamped by SQLite. Overdue is evaluated in SQL (dueDate < now, not yet closed).
// UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseCompetencyRecertification';

const INSERTABLE = [
  'employeeProfileId', 'employeeId', 'competencyId', 'currentEvidenceId', 'currentAssessmentId',
  'currentMappingId', 'recertificationType', 'dueDate', 'scheduledDate', 'completedDate', 'status',
  'result', 'assignedTrainerId', 'assignedAssessorId', 'comments', 'metadataJson', 'active', 'archived',
  'deleted',
];
// employeeProfileId + employeeId + competencyId form the recertification identity and are immutable.
const UPDATABLE = [
  'currentEvidenceId', 'currentAssessmentId', 'currentMappingId', 'recertificationType', 'dueDate',
  'scheduledDate', 'status', 'result', 'assignedTrainerId', 'assignedAssessorId', 'comments',
  'metadataJson', 'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'employeeProfileId', 'employeeId', 'competencyId', 'recertificationType', 'status', 'result', 'active',
  'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseCompetencyRecertificationRepository extends BaseRepository {
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
    // Boolean sentinel: completedDate === true stamps the completion instant via SQLite.
    if (src.completedDate === true) {
      sets.push("completedDate = datetime('now')");
    } else if (src.completedDate !== undefined) {
      sets.push('completedDate = ?'); params.push(src.completedDate);
    }
    sets.push("updatedAt = datetime('now')");
    params.push(id);
    return this._run(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ? AND deleted = 0`, params)
      .then(() => this.findById(id));
  }

  findById(id) {
    return this._get(`SELECT * FROM ${TABLE} WHERE id = ? AND deleted = 0`, [id]);
  }

  findByEmployee(employeeId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE employeeId = ? AND deleted = 0 ORDER BY id`, [employeeId]);
  }

  findByCompetency(competencyId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE competencyId = ? AND deleted = 0 ORDER BY id`, [competencyId]);
  }

  findDue() {
    return this._all(`SELECT * FROM ${TABLE} WHERE status = 'PENDING' AND deleted = 0 ORDER BY dueDate, id`, []);
  }

  findScheduled() {
    return this._all(`SELECT * FROM ${TABLE} WHERE status = 'SCHEDULED' AND deleted = 0 ORDER BY scheduledDate, id`, []);
  }

  findCompleted() {
    return this._all(`SELECT * FROM ${TABLE} WHERE status = 'COMPLETED' AND deleted = 0 ORDER BY completedDate, id`, []);
  }

  // Overdue: past the due date and not yet closed (completed or cancelled).
  findOverdue() {
    return this._all(
      `SELECT * FROM ${TABLE} WHERE dueDate IS NOT NULL AND dueDate < datetime('now') AND status NOT IN ('COMPLETED', 'CANCELLED') AND deleted = 0 ORDER BY dueDate, id`,
      [],
    );
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

module.exports = EnterpriseCompetencyRecertificationRepository;
