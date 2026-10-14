// WP-26 · Phase 8 — Enterprise Document Competency migration tests (ephemeral in-memory DB only).
// Additive, isolated: creates tblEnterpriseDocumentCompetency on an injected connection; never
// touches db.js, existing tables, or production.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-competency-migration.js'));

const memDb = () => new sqlite3.Database(':memory:');
const faultyDb = {
  run(sql, params, cb) { cb(new Error('run failed')); },
  get(sql, params, cb) { cb(new Error('get failed')); },
  all(sql, params, cb) { cb(new Error('all failed')); },
};
const EXPECTED_COLUMNS = [
  'id', 'documentVersionId', 'competencyId', 'competencyCode', 'competencyName', 'competencyLevel',
  'requiredScore', 'minimumAttempts', 'assessmentRequired', 'trainingRequired', 'mandatoryCompetency',
  'validationPeriodMonths', 'effectiveDate', 'expiryDate', 'metadataJson', 'active', 'archived',
  'deleted', 'createdAt', 'updatedAt',
];

test('W26K-MIG-1. getTableName + getCreateTableSql', () => {
  assert.equal(Mig.getTableName(), 'tblEnterpriseDocumentCompetency');
  const sql = Mig.getCreateTableSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tblEnterpriseDocumentCompetency/);
  assert.match(sql, /documentVersionId INTEGER NOT NULL/);
  assert.match(sql, /validationPeriodMonths INTEGER/);
});

test('W26K-MIG-2. getColumns returns the 20 columns and is copy-on-read', () => {
  assert.deepEqual(Mig.getColumns(), EXPECTED_COLUMNS);
  const a = Mig.getColumns(); a.push('HACK');
  assert.deepEqual(Mig.getColumns(), EXPECTED_COLUMNS);
});

test('W26K-MIG-3. migrate creates the table (idempotent)', async () => {
  const db = memDb();
  assert.deepEqual(await Mig.migrate(db), { migrated: true, table: 'tblEnterpriseDocumentCompetency' });
  assert.equal((await Mig.migrate(db)).migrated, true);
  db.close();
});

test('W26K-MIG-4. migrate degrades on a faulty connection', async () => {
  const r = await Mig.migrate(faultyDb);
  assert.equal(r.migrated, false);
  assert.match(r.error, /run failed/);
});

test('W26K-MIG-5. verify: absent before, present + 20 columns after', async () => {
  const db = memDb();
  assert.equal((await Mig.verify(db)).exists, false);
  await Mig.migrate(db);
  const after = await Mig.verify(db);
  assert.equal(after.verified, true);
  assert.deepEqual(after.columns.sort(), EXPECTED_COLUMNS.slice().sort());
  db.close();
});

test('W26K-MIG-6. verify degrades safely on a faulty connection', async () => {
  const r = await Mig.verify(faultyDb);
  assert.equal(r.verified, false);
  assert.deepEqual(r.columns, []);
});

test('W26K-MIG-7. verify normalises a null row-set to an empty column list', async () => {
  const nullRowsDb = {
    get(sql, params, cb) { cb(null, { name: 'tblEnterpriseDocumentCompetency' }); },
    all(sql, params, cb) { cb(null, null); },
  };
  const r = await Mig.verify(nullRowsDb);
  assert.equal(r.exists, true);
  assert.deepEqual(r.columns, []);
});

test('W26K-MIG-8. rollback drops the table', async () => {
  const db = memDb();
  await Mig.migrate(db);
  assert.deepEqual(await Mig.rollback(db), { rolledBack: true, table: 'tblEnterpriseDocumentCompetency' });
  assert.equal((await Mig.verify(db)).exists, false);
  db.close();
});

test('W26K-MIG-9. rollback degrades safely on a faulty connection', async () => {
  const r = await Mig.rollback(faultyDb);
  assert.equal(r.rolledBack, false);
  assert.match(r.error, /run failed/);
});
