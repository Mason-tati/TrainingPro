// WP-26 · Phase 2 — Enterprise Document Engine — Folder Management — Migration.
//
// Creates the tblEnterpriseFolder table (unlimited folder hierarchy) on an INJECTED sqlite3
// connection. Idempotent (CREATE TABLE IF NOT EXISTS), additive, isolated: it does NOT modify
// database/db.js, touches no existing table, and is NEVER applied to production by this module.
// Uniqueness of folderNumber/folderPath is enforced by the service among non-deleted folders (so
// soft-deleted rows never block recreation and move-cascades never trip a DB constraint).
// Deterministic SQL builders (copy-on-read), never-throw. UNWIRED.
'use strict';

const TABLE = 'tblEnterpriseFolder';

const COLUMNS = [
  'id', 'parentFolderId', 'folderNumber', 'folderName', 'description', 'category', 'subCategory',
  'department', 'site', 'businessUnit', 'securityClassification', 'ownerId', 'folderPath',
  'folderDepth', 'sortOrder', 'retentionCategory', 'active', 'archived', 'deleted', 'metadataJson',
  'createdAt', 'updatedAt',
];

function getTableName() {
  return TABLE;
}

function getColumns() {
  return COLUMNS.slice();
}

function getCreateTableSql() {
  return `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parentFolderId INTEGER,
    folderNumber TEXT NOT NULL,
    folderName TEXT NOT NULL,
    description TEXT,
    category TEXT,
    subCategory TEXT,
    department TEXT,
    site TEXT,
    businessUnit TEXT,
    securityClassification TEXT NOT NULL DEFAULT 'INTERNAL',
    ownerId INTEGER,
    folderPath TEXT NOT NULL,
    folderDepth INTEGER NOT NULL DEFAULT 0,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    retentionCategory TEXT NOT NULL DEFAULT 'STANDARD',
    active INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    metadataJson TEXT,
    createdAt TEXT,
    updatedAt TEXT
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
  const columns = info.ok ? info.rows.map((c) => c.name) : [];
  return { verified: exists, exists, columns };
}

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
