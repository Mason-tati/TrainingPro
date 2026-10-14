// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Generic Lifecycle Repository.
//
// The reusable persistence engine for EVERY future Workforce entity. Constructed from a declarative
// config (factory-based construction) over an INJECTED sqlite3 connection, it provides the full
// allow-listed CRUD + soft-delete + archive/restore + relationship/active queries + count that every
// certified engine hand-copied 18 times — defined ONCE here. NO business logic: it knows only columns,
// not rules. SQLite today, portable to PostgreSQL (no engine-specific SQL beyond datetime('now'), which
// is isolated to the timestamp stamps). Optional audit hook and optional row-level-security scope
// predicates support future multi-tenancy without forcing it. UNWIRED.
'use strict';

const { isPlainObject } = require('./shared-validation');

function isConnection(db) {
  return !!db && typeof db.run === 'function' && typeof db.get === 'function' && typeof db.all === 'function';
}

class GenericLifecycleRepository {
  // config = { table, insertable:[], updatable:[], filterable:[], scopeColumns:[], auditHook? }
  constructor(db, config) {
    if (!isConnection(db)) {
      throw new Error('GenericLifecycleRepository requires an injected sqlite3 database connection');
    }
    const cfg = isPlainObject(config) ? config : {};
    if (typeof cfg.table !== 'string' || cfg.table.trim().length === 0) {
      throw new Error('GenericLifecycleRepository requires a non-empty table name');
    }
    this.db = db;
    this.table = cfg.table;
    this.insertable = Array.isArray(cfg.insertable) ? cfg.insertable.slice() : [];
    this.updatable = Array.isArray(cfg.updatable) ? cfg.updatable.slice() : [];
    this.filterable = Array.isArray(cfg.filterable) ? cfg.filterable.slice() : [];
    this.scopeColumns = Array.isArray(cfg.scopeColumns) ? cfg.scopeColumns.slice() : [];
    this.auditHook = typeof cfg.auditHook === 'function' ? cfg.auditHook : null;
  }

  // ---- promisified primitives (reject on DB error; the service layer wraps never-throw) ----

  _run(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function runCb(err) {
        if (err) return reject(err);
        return resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
  _get(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
  }
  _all(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  // Fire the optional audit hook. Never allowed to break a repository operation.
  _audit(action, id) {
    if (!this.auditHook) return;
    try {
      this.auditHook({ action, table: this.table, id });
    } catch (e) {
      // audit is best-effort; a faulty hook must not corrupt the write path
    }
  }

  // A column may be used as a filter only if it is allow-listed (prevents identifier injection).
  _assertFilterable(column) {
    if (!this.filterable.includes(column) && !this.scopeColumns.includes(column)) {
      throw new Error(`column '${column}' is not filterable on ${this.table}`);
    }
  }

  create(data) {
    const src = isPlainObject(data) ? data : {};
    const insertCols = this.insertable.filter((c) => src[c] !== undefined);
    const scopeCols = this.scopeColumns.filter((c) => src[c] !== undefined && !insertCols.includes(c));
    const cols = insertCols.concat(scopeCols);
    const params = cols.map((c) => src[c]);
    const allCols = cols.concat(['createdAt', 'updatedAt']);
    const allVals = cols.map(() => '?').concat(["datetime('now')", "datetime('now')"]);
    const sql = `INSERT INTO ${this.table} (${allCols.join(', ')}) VALUES (${allVals.join(', ')})`;
    return this._run(sql, params).then((r) => {
      this._audit('create', r.lastID);
      return this.findById(r.lastID);
    });
  }

  update(id, patch) {
    const src = isPlainObject(patch) ? patch : {};
    const sets = [];
    const params = [];
    for (const col of this.updatable) {
      if (src[col] !== undefined) { sets.push(`${col} = ?`); params.push(src[col]); }
    }
    sets.push("updatedAt = datetime('now')");
    params.push(id);
    return this._run(`UPDATE ${this.table} SET ${sets.join(', ')} WHERE id = ? AND deleted = 0`, params)
      .then(() => { this._audit('update', id); return this.findById(id); });
  }

  findById(id) {
    return this._get(`SELECT * FROM ${this.table} WHERE id = ? AND deleted = 0`, [id]);
  }

  // Generic relationship query: rows where an allow-listed column equals a value (excludes deleted).
  findBy(column, value) {
    this._assertFilterable(column);
    return this._all(`SELECT * FROM ${this.table} WHERE ${column} = ? AND deleted = 0 ORDER BY id`, [value]);
  }

  // List rows matching an allow-listed filter map plus an optional RLS scope map (excludes deleted).
  findAll(filters, scope) {
    const where = ['deleted = 0'];
    const params = [];
    const f = isPlainObject(filters) ? filters : {};
    for (const col of this.filterable) {
      if (f[col] !== undefined) { where.push(`${col} = ?`); params.push(f[col]); }
    }
    const s = isPlainObject(scope) ? scope : {};
    for (const col of this.scopeColumns) {
      if (s[col] !== undefined) { where.push(`${col} = ?`); params.push(s[col]); }
    }
    return this._all(`SELECT * FROM ${this.table} WHERE ${where.join(' AND ')} ORDER BY id`, params);
  }

  findActive() {
    return this._all(`SELECT * FROM ${this.table} WHERE active = 1 AND deleted = 0 ORDER BY id`, []);
  }

  archive(id) {
    return this._run(`UPDATE ${this.table} SET archived = 1, updatedAt = datetime('now') WHERE id = ?`, [id])
      .then((r) => { this._audit('archive', id); return r; });
  }
  restore(id) {
    return this._run(`UPDATE ${this.table} SET deleted = 0, archived = 0, active = 1, updatedAt = datetime('now') WHERE id = ?`, [id])
      .then((r) => { this._audit('restore', id); return r; });
  }
  softDelete(id) {
    return this._run(`UPDATE ${this.table} SET deleted = 1, active = 0, updatedAt = datetime('now') WHERE id = ?`, [id])
      .then((r) => { this._audit('softDelete', id); return r; });
  }

  exists(id) {
    return this._get(`SELECT 1 AS present FROM ${this.table} WHERE id = ?`, [id]).then((row) => row !== null);
  }

  count(filters, scope) {
    const where = ['deleted = 0'];
    const params = [];
    const f = isPlainObject(filters) ? filters : {};
    for (const col of this.filterable) {
      if (f[col] !== undefined) { where.push(`${col} = ?`); params.push(f[col]); }
    }
    const s = isPlainObject(scope) ? scope : {};
    for (const col of this.scopeColumns) {
      if (s[col] !== undefined) { where.push(`${col} = ?`); params.push(s[col]); }
    }
    return this._get(`SELECT COUNT(*) AS total FROM ${this.table} WHERE ${where.join(' AND ')}`, params).then((row) => row.total);
  }
}

// Factory-based construction (the platform standard).
function createRepository(db, config) {
  return new GenericLifecycleRepository(db, config);
}

module.exports = { GenericLifecycleRepository, createRepository };
