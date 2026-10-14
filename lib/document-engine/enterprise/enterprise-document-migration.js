// WP-26 · Phase 1 — Enterprise Document Engine Foundation — Migration.
//
// Creates the tblEnterpriseDocument table (the core document-management domain) on an INJECTED
// sqlite3 connection. It is idempotent (CREATE TABLE IF NOT EXISTS), additive, and isolated: it does
// NOT modify database/db.js, does NOT touch any existing table, and is NEVER applied to the
// production database by this module — production application is a future, explicitly-gated step.
// Deterministic SQL builders (copy-on-read), never-throw (DB errors resolve to an explicit negative
// result rather than rejecting). UNWIRED — nothing in production imports it.
'use strict';

const TABLE = 'tblEnterpriseDocument';

// The full ordered column list of the Enterprise Document table (WP-26 field list).
const COLUMNS = [
  'id', 'documentNumber', 'title', 'description', 'category', 'subCategory', 'documentType',
  'versionMajor', 'versionMinor', 'status', 'ownerId', 'approverId', 'securityClassification',
  'language', 'createdAt', 'updatedAt', 'approvedAt', 'effectiveDate', 'reviewDate', 'expiryDate',
  'supersededBy', 'currentVersion', 'archived', 'deleted', 'metadataJson',
];

// The table name (constant).
function getTableName() {
  return TABLE;
}

// A fresh copy of the column list every call (copy-on-read).
function getColumns() {
  return COLUMNS.slice();
}

// The idempotent CREATE TABLE statement for the Enterprise Document table.
function getCreateTableSql() {
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    documentNumber TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT,
    subCategory TEXT,
    documentType TEXT,
    versionMajor INTEGER NOT NULL DEFAULT 1,
    versionMinor INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    ownerId INTEGER,
    approverId INTEGER,
    securityClassification TEXT NOT NULL DEFAULT 'INTERNAL',
    language TEXT NOT NULL DEFAULT 'en',
    createdAt TEXT,
    updatedAt TEXT,
    approvedAt TEXT,
    effectiveDate TEXT,
    reviewDate TEXT,
    expiryDate TEXT,
    supersededBy INTEGER,
    currentVersion INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    metadataJson TEXT
  )`;
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

// Apply the migration (create the table) on the injected connection. Never throws.
async function migrate(db) {
  const result = await run(db, getCreateTableSql(), []);
  if (!result.ok) {
    return { migrated: false, table: TABLE, error: result.error };
  }
  return { migrated: true, table: TABLE };
}

// Verify the table exists and report its columns. Never throws.
async function verify(db) {
  const found = await get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [TABLE]);
  const exists = found.ok ? found.row !== null : false;
  const info = await all(db, `PRAGMA table_info(${TABLE})`, []);
  const columns = info.ok ? info.rows.map((c) => c.name) : [];
  return { verified: exists, exists, columns };
}

// Drop the table (test/rollback only). Never throws.
async function rollback(db) {
  const result = await run(db, `DROP TABLE IF EXISTS ${TABLE}`, []);
  if (!result.ok) {
    return { rolledBack: false, table: TABLE, error: result.error };
  }
  return { rolledBack: true, table: TABLE };
}

module.exports = {
  getTableName,
  getColumns,
  getCreateTableSql,
  migrate,
  verify,
  rollback,
};
