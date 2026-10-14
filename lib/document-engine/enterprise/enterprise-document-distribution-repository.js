// WP-26 · Phase 6 — Enterprise Document Engine — Distribution — Repository.
//
// Parameterized SQL over tblEnterpriseDocumentDistribution via an INJECTED sqlite3 connection,
// reusing the certified BaseRepository. NO business logic: allow-listed columns, SQLite-stamped
// timestamps, and status/acknowledgement queries (by version / pending / acknowledged / outstanding).
// acknowledgedDate/lastNotificationDate are stamped by SQLite when update() is asked to. UNWIRED.
'use strict';

const BaseRepository = require('../repositories/base-repository');

const TABLE = 'tblEnterpriseDocumentDistribution';

const INSERTABLE = [
  'documentVersionId', 'distributionGroupId', 'userId', 'distributionType', 'deliveryMethod',
  'distributionStatus', 'sentDate', 'receivedDate', 'expiryDate', 'acknowledged', 'mandatoryRead',
  'notificationCount', 'metadataJson', 'active', 'archived', 'deleted',
];
// documentVersionId immutable; acknowledgedDate/lastNotificationDate stamped via SQL sentinels below.
const UPDATABLE = [
  'distributionGroupId', 'userId', 'distributionType', 'deliveryMethod', 'distributionStatus',
  'sentDate', 'receivedDate', 'expiryDate', 'acknowledged', 'mandatoryRead', 'notificationCount',
  'metadataJson', 'active', 'archived', 'deleted',
];
// Columns stamped with datetime('now') when the patch sets them to the boolean sentinel `true`.
const NOW_COLUMNS = ['acknowledgedDate', 'lastNotificationDate'];
const FILTERABLE = [
  'documentVersionId', 'distributionGroupId', 'userId', 'distributionType', 'deliveryMethod',
  'distributionStatus', 'acknowledged', 'mandatoryRead', 'active', 'archived',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class EnterpriseDocumentDistributionRepository extends BaseRepository {
  create(data) {
    const src = isPlainObject(data) ? data : {};
    const cols = INSERTABLE.filter((c) => src[c] !== undefined);
    const params = cols.map((c) => src[c]);
    const allCols = cols.concat(['createdAt', 'updatedAt']);
    const allVals = cols.map(() => '?').concat(["datetime('now')", "datetime('now')"]);
    const sql = `INSERT INTO ${TABLE} (${allCols.join(', ')}) VALUES (${allVals.join(', ')})`;
    return this._run(sql, params).then((r) => this.findById(r.lastID));
  }

  // Update allow-listed columns; a NOW_COLUMNS field set to `true` is stamped via SQLite.
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
    return this._all(`SELECT * FROM ${TABLE} WHERE distributionStatus = 'PENDING' AND deleted = 0 ORDER BY id`, []);
  }

  findAcknowledged() {
    return this._all(`SELECT * FROM ${TABLE} WHERE acknowledged = 1 AND deleted = 0 ORDER BY acknowledgedDate, id`, []);
  }

  findOutstanding() {
    return this._all(`SELECT * FROM ${TABLE} WHERE acknowledged = 0 AND deleted = 0 ORDER BY id`, []);
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

module.exports = EnterpriseDocumentDistributionRepository;
