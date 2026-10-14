// WP-26 · Phase 14 — Enterprise Document Engine — Training Program — Repository.
//
// Parameterized SQL over tblEnterpriseTrainingProgram via an INJECTED sqlite3 connection, reusing the
// certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped timestamps, and
// catalogue queries (by program code / competency / trainer; mandatory; active). programCode is the
// immutable business key (looked up for uniqueness enforcement in the service). UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseTrainingProgram';

const INSERTABLE = [
  'programCode', 'programName', 'description', 'trainingType', 'deliveryMethod', 'department', 'site',
  'businessUnit', 'ownerId', 'trainerId', 'competencyId', 'assessmentId', 'durationHours',
  'renewalPeriodMonths', 'mandatory', 'status', 'effectiveDate', 'expiryDate', 'metadataJson', 'active',
  'archived', 'deleted',
];
// programCode is the immutable business key and is never updated.
const UPDATABLE = [
  'programName', 'description', 'trainingType', 'deliveryMethod', 'department', 'site', 'businessUnit',
  'ownerId', 'trainerId', 'competencyId', 'assessmentId', 'durationHours', 'renewalPeriodMonths',
  'mandatory', 'status', 'effectiveDate', 'expiryDate', 'metadataJson', 'active', 'archived', 'deleted',
];
const FILTERABLE = [
  'trainingType', 'deliveryMethod', 'department', 'site', 'businessUnit', 'competencyId', 'trainerId',
  'mandatory', 'status', 'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseTrainingProgramRepository extends BaseRepository {
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

  findByProgramCode(programCode) {
    return this._get(`SELECT * FROM ${TABLE} WHERE programCode = ? AND deleted = 0`, [programCode]);
  }

  findByCompetency(competencyId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE competencyId = ? AND deleted = 0 ORDER BY id`, [competencyId]);
  }

  findByTrainer(trainerId) {
    return this._all(`SELECT * FROM ${TABLE} WHERE trainerId = ? AND deleted = 0 ORDER BY id`, [trainerId]);
  }

  findMandatory() {
    return this._all(`SELECT * FROM ${TABLE} WHERE mandatory = 1 AND deleted = 0 ORDER BY id`, []);
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

module.exports = EnterpriseTrainingProgramRepository;
