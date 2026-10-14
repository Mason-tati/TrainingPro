// WP-26 · Phase 18 (FINAL) — Enterprise Document Engine — Compliance — Repository.
//
// Parameterized SQL over tblEnterpriseCompliance via an INJECTED sqlite3 connection, reusing the
// certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps, and
// compliance queries (by employee / role / qualification / certification / learning path / competency;
// compliant / non-compliant; expired / overdue). The `overdue` flag is stored (derived by the service);
// `findExpired` evaluates expiryDate < now in SQL, `findOverdue` filters the stored overdue flag. UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseCompliance';

const INSERTABLE = [
  'employeeId', 'roleId', 'qualificationId', 'certificationId', 'learningPathId', 'competencyId',
  'complianceStatus', 'compliantDate', 'expiryDate', 'renewalRequired', 'overdue', 'riskLevel',
  'department', 'site', 'businessUnit', 'metadataJson', 'active', 'archived', 'deleted',
];
// employeeId is the anchoring identity and is immutable.
const UPDATABLE = [
  'roleId', 'qualificationId', 'certificationId', 'learningPathId', 'competencyId', 'complianceStatus',
  'compliantDate', 'expiryDate', 'renewalRequired', 'overdue', 'riskLevel', 'department', 'site',
  'businessUnit', 'metadataJson', 'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'employeeId', 'roleId', 'qualificationId', 'certificationId', 'learningPathId', 'competencyId',
  'complianceStatus', 'renewalRequired', 'overdue', 'riskLevel', 'department', 'site', 'businessUnit',
  'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseComplianceRepository extends BaseRepository {
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

  findByEmployee(employeeId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE employeeId = ? AND deleted = 0 ORDER BY id`, [employeeId]);
  }

  findByRole(roleId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE roleId = ? AND deleted = 0 ORDER BY id`, [roleId]);
  }

  findByQualification(qualificationId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE qualificationId = ? AND deleted = 0 ORDER BY id`, [qualificationId]);
  }

  findByCertification(certificationId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE certificationId = ? AND deleted = 0 ORDER BY id`, [certificationId]);
  }

  findByLearningPath(learningPathId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE learningPathId = ? AND deleted = 0 ORDER BY id`, [learningPathId]);
  }

  findByCompetency(competencyId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE competencyId = ? AND deleted = 0 ORDER BY id`, [competencyId]);
  }

  findCompliant() {
    return this._all(`SELECT * FROM ${TABLE} WHERE complianceStatus = 'COMPLIANT' AND deleted = 0 ORDER BY id`, []);
  }

  findNonCompliant() {
    return this._all(`SELECT * FROM ${TABLE} WHERE complianceStatus = 'NON_COMPLIANT' AND deleted = 0 ORDER BY id`, []);
  }

  findExpired() {
    return this._all(
      `SELECT * FROM ${TABLE} WHERE expiryDate IS NOT NULL AND expiryDate < datetime('now') AND deleted = 0 ORDER BY expiryDate, id`,
      [],
    );
  }

  findOverdue() {
    return this._all(`SELECT * FROM ${TABLE} WHERE overdue = 1 AND deleted = 0 ORDER BY id`, []);
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

module.exports = EnterpriseComplianceRepository;
