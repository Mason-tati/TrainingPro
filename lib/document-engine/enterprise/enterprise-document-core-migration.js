// WP-26 · Phase 3 — Enterprise Document Engine — Document Core — Migration.
//
// Creates the tblEnterpriseDocumentCore table (folder-linked, file-backed documents) on an INJECTED
// sqlite3 connection. Idempotent (CREATE TABLE IF NOT EXISTS), additive, isolated: it does NOT modify
// database/db.js, touches no existing table, and is NEVER applied to production by this module.
// Uniqueness of documentNumber is enforced by the service among non-deleted rows. Deterministic SQL
// builders (copy-on-read), never-throw. UNWIRED.
'use strict';

const TABLE = 'tblEnterpriseDocumentCore';

const COLUMNS = [
  'id', 'folderId', 'documentNumber', 'documentTitle', 'documentType', 'revision', 'status',
  'description', 'keywords', 'ownerId', 'department', 'site', 'businessUnit', 'securityClassification',
  'retentionCategory', 'effectiveDate', 'reviewDate', 'expiryDate', 'language', 'fileName',
  'fileExtension', 'mimeType', 'fileSize', 'checksum', 'storagePath', 'metadataJson', 'active',
  'archived', 'deleted', 'createdAt', 'updatedAt',
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
    folderId INTEGER,
    documentNumber TEXT NOT NULL,
    documentTitle TEXT NOT NULL,
    documentType TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    description TEXT,
    keywords TEXT,
    ownerId INTEGER,
    department TEXT,
    site TEXT,
    businessUnit TEXT,
    securityClassification TEXT NOT NULL DEFAULT 'INTERNAL',
    retentionCategory TEXT NOT NULL DEFAULT 'STANDARD',
    effectiveDate TEXT,
    reviewDate TEXT,
    expiryDate TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    fileName TEXT,
    fileExtension TEXT,
    mimeType TEXT,
    fileSize INTEGER,
    checksum TEXT,
    storagePath TEXT,
    metadataJson TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
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
