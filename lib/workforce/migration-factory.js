// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Migration Factory.
//
// The ONE place every future Workforce table is defined, so the standard lifecycle / scope / timestamp
// columns are guaranteed identical across the whole platform and can NEVER drift (the duplication the
// WP-17→26 review flagged). `defineTable(spec)` returns a migration object with the same shape the
// certified engines use — { getTableName, getColumns, getCreateTableSql, migrate, verify, rollback } —
// built over an INJECTED sqlite3 connection. Idempotent (CREATE TABLE IF NOT EXISTS), never applied to
// production by this module, deterministic SQL builders (copy-on-read), never-throw.
//
// This module CREATES NO BUSINESS TABLE. It is only the tool. EWP-01a ships the factory alone; business
// tables (Person, Organisation, Position, …) are future work packages. UNWIRED.
'use strict';

const { isPlainObject } = require('./shared-validation');

// The standardized lifecycle block appended to every table (unless disabled). Defined ONCE.
const LIFECYCLE_COLUMNS = [
  { name: 'active', type: 'INTEGER', notNull: true, default: '1' },
  { name: 'archived', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'deleted', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'metadataJson', type: 'TEXT' },
  { name: 'createdAt', type: 'TEXT' },
  { name: 'updatedAt', type: 'TEXT' },
];
// Optional row-level-security / multi-tenancy scope block (future RLS). Nullable, off by default.
const SCOPE_COLUMNS = [
  { name: 'tenantId', type: 'INTEGER' },
  { name: 'companyId', type: 'INTEGER' },
  { name: 'siteId', type: 'INTEGER' },
];

function columnSql(col) {
  let sql = `${col.name} ${col.type || 'TEXT'}`;
  if (col.primaryKey) sql += ' PRIMARY KEY AUTOINCREMENT';
  if (col.notNull) sql += ' NOT NULL';
  if (col.default !== undefined) sql += ` DEFAULT ${col.default}`;
  return sql;
}

// Resolve the full, ordered column list for a spec: id (unless a user column is the PK), user columns,
// optional scope block, then the lifecycle block (unless disabled).
function resolveColumns(spec) {
  const userColumns = Array.isArray(spec.columns) ? spec.columns : [];
  const hasUserPk = userColumns.some((c) => c && c.primaryKey);
  const columns = [];
  if (!hasUserPk) {
    columns.push({ name: spec.idColumn || 'id', type: 'INTEGER', primaryKey: true });
  }
  for (const c of userColumns) columns.push(c);
  if (spec.includeScope) {
    for (const c of SCOPE_COLUMNS) columns.push(c);
  }
  if (spec.includeLifecycle !== false) {
    for (const c of LIFECYCLE_COLUMNS) columns.push(c);
  }
  return columns;
}

// ---- never-throw promisified primitives over an injected sqlite3 connection ----

function run(db, sql, params) {
  return new Promise((resolve) => {
    db.run(sql, params, function runCb(err) {
      if (err) return resolve({ ok: false, error: err.message });
      return resolve({ ok: true, lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(db, sql, params) {
  return new Promise((resolve) => {
    db.get(sql, params, (err, row) => resolve(err ? { ok: false, error: err.message } : { ok: true, row: row || null }));
  });
}
function all(db, sql, params) {
  return new Promise((resolve) => {
    db.all(sql, params, (err, rows) => resolve(err ? { ok: false, error: err.message } : { ok: true, rows: rows || [] }));
  });
}

// Build a migration object for one table from a declarative spec.
//   spec = { table, columns:[{name,type,notNull,default,primaryKey}], includeLifecycle=true,
//            includeScope=false, idColumn='id' }
function defineTable(spec) {
  const cfg = isPlainObject(spec) ? spec : {};
  const TABLE = cfg.table;
  if (typeof TABLE !== 'string' || TABLE.trim().length === 0) {
    throw new Error('defineTable requires a non-empty table name');
  }
  const columns = resolveColumns(cfg);

  function getTableName() {
    return TABLE;
  }
  function getColumns() {
    return columns.map((c) => c.name);
  }
  function getCreateTableSql() {
    const body = columns.map((c) => `  ${columnSql(c)}`).join(',\n');
    return `CREATE TABLE IF NOT EXISTS ${TABLE} (\n${body}\n)`;
  }

  async function migrate(db) {
    const result = await run(db, getCreateTableSql(), []);
    if (!result.ok) {
      return { migrated: false, table: TABLE, error: result.error };
    }
    return { migrated: true, table: TABLE };
  }
  async function verify(db) {
    const found = await get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [TABLE]);
    const exists = found.ok ? found.row !== null : false;
    const info = await all(db, `PRAGMA table_info(${TABLE})`, []);
    const cols = info.ok ? info.rows.map((c) => c.name) : [];
    return { verified: exists, exists, columns: cols };
  }
  async function rollback(db) {
    const result = await run(db, `DROP TABLE IF EXISTS ${TABLE}`, []);
    if (!result.ok) {
      return { rolledBack: false, table: TABLE, error: result.error };
    }
    return { rolledBack: true, table: TABLE };
  }

  return { getTableName, getColumns, getCreateTableSql, migrate, verify, rollback };
}

module.exports = {
  defineTable,
  LIFECYCLE_COLUMNS: LIFECYCLE_COLUMNS.map((c) => Object.assign({}, c)),
  SCOPE_COLUMNS: SCOPE_COLUMNS.map((c) => Object.assign({}, c)),
};
