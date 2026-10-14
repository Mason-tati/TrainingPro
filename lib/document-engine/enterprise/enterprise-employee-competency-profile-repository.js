// WP-26 · Phase 12 — Enterprise Document Engine — Employee Competency Profile — Repository.
//
// Parameterized SQL over tblEnterpriseEmployeeCompetencyProfile via an INJECTED sqlite3 connection,
// reusing the certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped
// timestamps, and relationship / compliance / expiry queries (by employee / competency; compliant /
// non-compliant; expiring within N days / expired; active). Expiring and expired windows are evaluated
// in SQL (datetime('now') + a bound day modifier). UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseEmployeeCompetencyProfile';

const INSERTABLE = [
  'employeeId', 'competencyId', 'currentEvidenceId', 'currentAssessmentId', 'currentMappingId',
  'status', 'achievedDate', 'expiryDate', 'lastVerifiedDate', 'nextReviewDate', 'riskLevel',
  'complianceStatus', 'metadataJson', 'active', 'archived', 'deleted',
];
// employeeId + competencyId form the profile identity and are immutable.
const UPDATABLE = [
  'currentEvidenceId', 'currentAssessmentId', 'currentMappingId', 'status', 'achievedDate', 'expiryDate',
  'lastVerifiedDate', 'nextReviewDate', 'riskLevel', 'complianceStatus', 'metadataJson', 'active',
  'archived', 'deleted',
];
const FILTERABLE = [
  'employeeId', 'competencyId', 'status', 'riskLevel', 'complianceStatus', 'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseEmployeeCompetencyProfileRepository extends BaseRepository {
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

  findByCompetency(competencyId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE competencyId = ? AND deleted = 0 ORDER BY id`, [competencyId]);
  }

  findCompliant() {
    return this._all(`SELECT * FROM ${TABLE} WHERE complianceStatus = 'COMPLIANT' AND deleted = 0 ORDER BY id`, []);
  }

  findNonCompliant() {
    return this._all(`SELECT * FROM ${TABLE} WHERE complianceStatus = 'NON_COMPLIANT' AND deleted = 0 ORDER BY id`, []);
  }

  // Profiles whose competency lapses within the next `withinDays` (not yet expired).
  findExpiring(withinDays) {
    const days = Number.isInteger(withinDays) && withinDays >= 0 ? withinDays : 30;
    return this._all(
      `SELECT * FROM ${TABLE} WHERE expiryDate IS NOT NULL AND expiryDate >= datetime('now') AND expiryDate <= datetime('now', ?) AND deleted = 0 ORDER BY expiryDate, id`,
      [`+${days} days`],
    );
  }

  findExpired() {
    return this._all(
      `SELECT * FROM ${TABLE} WHERE expiryDate IS NOT NULL AND expiryDate < datetime('now') AND deleted = 0 ORDER BY expiryDate, id`,
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

module.exports = EnterpriseEmployeeCompetencyProfileRepository;
