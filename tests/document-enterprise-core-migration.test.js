// WP-26 · Phase 3 — Enterprise Document Core migration tests (ephemeral in-memory DB only).
// Additive, isolated: creates tblEnterpriseDocumentCore on an injected connection; never touches
// db.js, existing tables, or production.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));

const memDb = () => new sqlite3.Database(':memory:');
const faultyDb = {
  run(sql, params, cb) { cb(new Error('run failed')); },
  get(sql, params, cb) { cb(new Error('get failed')); },
  all(sql, params, cb) { cb(new Error('all failed')); },
};
const EXPECTED_COLUMNS = [
  'id', 'folderId', 'documentNumber', 'documentTitle', 'documentType', 'revision', 'status',
  'description', 'keywords', 'ownerId', 'department', 'site', 'businessUnit', 'securityClassification',
  'retentionCategory', 'effectiveDate', 'reviewDate', 'expiryDate', 'language', 'fileName',
  'fileExtension', 'mimeType', 'fileSize', 'checksum', 'storagePath', 'metadataJson', 'active',
  'archived', 'deleted', 'createdAt', 'updatedAt',
];

test('W26C-MIG-1. getTableName + getCreateTableSql', () => {
  assert.equal(Mig.getTableName(), 'tblEnterpriseDocumentCore');
  const sql = Mig.getCreateTableSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tblEnterpriseDocumentCore/);
  assert.match(sql, /folderId INTEGER/);
  assert.match(sql, /storagePath TEXT/);
});

test('W26C-MIG-2. getColumns returns the 31 columns and is copy-on-read', () => {
  assert.deepEqual(Mig.getColumns(), EXPECTED_COLUMNS);
  const a = Mig.getColumns(); a.push('HACK');
  assert.deepEqual(Mig.getColumns(), EXPECTED_COLUMNS);
});

test('W26C-MIG-3. migrate creates the table (idempotent)', async () => {
  const db = memDb();
  assert.deepEqual(await Mig.migrate(db), { migrated: true, table: 'tblEnterpriseDocumentCore' });
  assert.equal((await Mig.migrate(db)).migrated, true);
  db.close();
});

test('W26C-MIG-4. migrate degrades on a faulty connection', async () => {
  const r = await Mig.migrate(faultyDb);
  assert.equal(r.migrated, false);
  assert.match(r.error, /run failed/);
});

test('W26C-MIG-5. verify: absent before, present + 31 columns after', async () => {
  const db = memDb();
  assert.equal((await Mig.verify(db)).exists, false);
  await Mig.migrate(db);
  const after = await Mig.verify(db);
  assert.equal(after.verified, true);
  assert.deepEqual(after.columns.sort(), EXPECTED_COLUMNS.slice().sort());
  db.close();
});

test('W26C-MIG-6. verify degrades safely on a faulty connection', async () => {
  const r = await Mig.verify(faultyDb);
  assert.equal(r.verified, false);
  assert.deepEqual(r.columns, []);
});

test('W26C-MIG-7. verify normalises a null row-set to an empty column list', async () => {
  const nullRowsDb = {
    get(sql, params, cb) { cb(null, { name: 'tblEnterpriseDocumentCore' }); },
    all(sql, params, cb) { cb(null, null); },
  };
  const r = await Mig.verify(nullRowsDb);
  assert.equal(r.exists, true);
  assert.deepEqual(r.columns, []);
});

test('W26C-MIG-8. rollback drops the table', async () => {
  const db = memDb();
  await Mig.migrate(db);
  assert.deepEqual(await Mig.rollback(db), { rolledBack: true, table: 'tblEnterpriseDocumentCore' });
  assert.equal((await Mig.verify(db)).exists, false);
  db.close();
});

test('W26C-MIG-9. rollback degrades safely on a faulty connection', async () => {
  const r = await Mig.rollback(faultyDb);
  assert.equal(r.rolledBack, false);
  assert.match(r.error, /run failed/);
});
