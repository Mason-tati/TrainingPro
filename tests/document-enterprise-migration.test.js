// WP-26 · Phase 1 — Enterprise Document migration tests (ephemeral in-memory DB only).
// The migration is additive and isolated: it creates tblEnterpriseDocument on an injected sqlite3
// connection, never touches db.js or any existing table, and never runs against production.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-migration.js'));

const memDb = () => new sqlite3.Database(':memory:');
// A connection whose primitives always error — proves the never-throw negative paths.
const faultyDb = {
  run(sql, params, cb) { cb(new Error('run failed')); },
  get(sql, params, cb) { cb(new Error('get failed')); },
  all(sql, params, cb) { cb(new Error('all failed')); },
};
const EXPECTED_COLUMNS = [
  'id', 'documentNumber', 'title', 'description', 'category', 'subCategory', 'documentType',
  'versionMajor', 'versionMinor', 'status', 'ownerId', 'approverId', 'securityClassification',
  'language', 'createdAt', 'updatedAt', 'approvedAt', 'effectiveDate', 'reviewDate', 'expiryDate',
  'supersededBy', 'currentVersion', 'archived', 'deleted', 'metadataJson',
];

test('W26-MIG-1. getTableName + getCreateTableSql (idempotent DDL for the enterprise table)', () => {
  assert.equal(Mig.getTableName(), 'tblEnterpriseDocument');
  const sql = Mig.getCreateTableSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tblEnterpriseDocument/);
  assert.match(sql, /documentNumber TEXT NOT NULL UNIQUE/);
  assert.match(sql, /metadataJson TEXT/);
});

test('W26-MIG-2. getColumns returns the 25 WP-26 columns and is copy-on-read', () => {
  assert.deepEqual(Mig.getColumns(), EXPECTED_COLUMNS);
  const a = Mig.getColumns();
  a.push('HACK');
  assert.deepEqual(Mig.getColumns(), EXPECTED_COLUMNS, 'internal list is not mutated');
});

test('W26-MIG-3. migrate creates the table (and is idempotent)', async () => {
  const db = memDb();
  const first = await Mig.migrate(db);
  assert.deepEqual(first, { migrated: true, table: 'tblEnterpriseDocument' });
  const second = await Mig.migrate(db); // IF NOT EXISTS → safe to re-run
  assert.equal(second.migrated, true);
  db.close();
});

test('W26-MIG-4. migrate degrades to a negative result on a faulty connection (never throws)', async () => {
  const r = await Mig.migrate(faultyDb);
  assert.equal(r.migrated, false);
  assert.equal(r.table, 'tblEnterpriseDocument');
  assert.match(r.error, /run failed/);
});

test('W26-MIG-5. verify reports absence before migrate and presence + columns after', async () => {
  const db = memDb();
  const before = await Mig.verify(db);
  assert.equal(before.exists, false);
  assert.deepEqual(before.columns, []);
  await Mig.migrate(db);
  const after = await Mig.verify(db);
  assert.equal(after.verified, true);
  assert.equal(after.exists, true);
  assert.deepEqual(after.columns.sort(), EXPECTED_COLUMNS.slice().sort());
  db.close();
});

test('W26-MIG-6. verify degrades safely on a faulty connection', async () => {
  const r = await Mig.verify(faultyDb);
  assert.equal(r.verified, false);
  assert.equal(r.exists, false);
  assert.deepEqual(r.columns, []);
});

test('W26-MIG-7. rollback drops the table', async () => {
  const db = memDb();
  await Mig.migrate(db);
  const r = await Mig.rollback(db);
  assert.deepEqual(r, { rolledBack: true, table: 'tblEnterpriseDocument' });
  assert.equal((await Mig.verify(db)).exists, false);
  db.close();
});

test('W26-MIG-8. rollback degrades safely on a faulty connection', async () => {
  const r = await Mig.rollback(faultyDb);
  assert.equal(r.rolledBack, false);
  assert.match(r.error, /run failed/);
});

test('W26-MIG-9. verify normalises a null row-set to an empty column list', async () => {
  // A connection whose all() yields null rows (no error) exercises the defensive rows||[] fallback.
  const nullRowsDb = {
    get(sql, params, cb) { cb(null, { name: 'tblEnterpriseDocument' }); },
    all(sql, params, cb) { cb(null, null); },
  };
  const r = await Mig.verify(nullRowsDb);
  assert.equal(r.exists, true);
  assert.deepEqual(r.columns, []);
});
