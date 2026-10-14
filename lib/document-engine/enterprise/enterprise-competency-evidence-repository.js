// WP-26 · Phase 11 — Enterprise Document Engine — Competency Evidence — Repository.
//
// Parameterized SQL over tblEnterpriseCompetencyEvidence via an INJECTED sqlite3 connection, reusing
// the certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps,
// relationship / verification / expiry queries (by employee / competency / assessment; pending /
// verified; expired / active). verifiedDate supports a boolean sentinel (true → datetime('now')) so
// the verification instant is stamped by SQLite. Expiry is evaluated in SQL (expiryDate < now). UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseCompetencyEvidence';

const INSERTABLE = [
  'competencyId', 'assessmentId', 'mappingId', 'employeeId', 'evidenceType', 'evidenceReference',
  'evidenceTitle', 'evidenceDescription', 'verifiedBy', 'verifiedDate', 'verificationStatus',
  'effectiveDate', 'expiryDate', 'metadataJson', 'active', 'archived', 'deleted',
];
// competencyId + assessmentId + mappingId + employeeId form the evidence identity and are immutable.
const UPDATABLE = [
  'evidenceType', 'evidenceReference', 'evidenceTitle', 'evidenceDescription', 'verifiedBy',
  'verificationStatus', 'effectiveDate', 'expiryDate', 'metadataJson', 'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'competencyId', 'assessmentId', 'mappingId', 'employeeId', 'evidenceType', 'verificationStatus',
  'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseCompetencyEvidenceRepository extends BaseRepository {
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
    // Boolean sentinel: verifiedDate === true stamps the verification instant via SQLite.
    if (src.verifiedDate === true) {
      sets.push("verifiedDate = datetime('now')");
    } else if (src.verifiedDate !== undefined) {
      sets.push('verifiedDate = ?'); params.push(src.verifiedDate);
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

  findByAssessment(assessmentId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE assessmentId = ? AND deleted = 0 ORDER BY id`, [assessmentId]);
  }

  findPendingVerification() {
    return this._all(`SELECT * FROM ${TABLE} WHERE verificationStatus = 'PENDING' AND deleted = 0 ORDER BY id`, []);
  }

  findVerified() {
    return this._all(`SELECT * FROM ${TABLE} WHERE verificationStatus = 'VERIFIED' AND deleted = 0 ORDER BY id`, []);
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

module.exports = EnterpriseCompetencyEvidenceRepository;
