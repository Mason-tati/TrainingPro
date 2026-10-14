// WP-26 · Phase 14 — Enterprise Training Program migration tests (ephemeral DB only).
// Idempotent CREATE TABLE IF NOT EXISTS over tblEnterpriseTrainingProgram on an injected sqlite3
// connection; never applied to production. Fake connections exercise the never-throw paths.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const Mig = require(path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise', 'enterprise-training-program-migration.js'));

const errDb = {
  run: (s, p, cb) => cb(new Error('boom')),
  get: (s, p, cb) => cb(new Error('boom')),
  all: (s, p, cb) => cb(new Error('boom')),
};
const nullDb = {
  run: (s, p, cb) => cb.call({ lastID: 1, changes: 1 }, null),
  get: (s, p, cb) => cb(null, undefined),
  all: (s, p, cb) => cb(null, undefined),
};

test('W26T-MIG-1. table name / columns / create SQL; getColumns returns a fresh copy', () => {
  assert.equal(Mig.getTableName(), 'tblEnterpriseTrainingProgram');
  const cols = Mig.getColumns();
  assert.ok(cols.includes('programCode') && cols.includes('deliveryMethod') && cols.includes('renewalPeriodMonths'));
  assert.equal(cols.length, 25);
  cols.push('HACK');
  assert.equal(Mig.getColumns().length, 25, 'internal COLUMNS not mutated');
  assert.match(Mig.getCreateTableSql(), /CREATE TABLE IF NOT EXISTS tblEnterpriseTrainingProgram/);
});

test('W26T-MIG-2. migrate creates the table; verify reports it exists with all 25 columns', async () => {
  const db = new sqlite3.Database(':memory:');
  assert.deepEqual(await Mig.migrate(db), { migrated: true, table: 'tblEnterpriseTrainingProgram' });
  const v = await Mig.verify(db);
  assert.equal(v.verified, true);
  assert.equal(v.exists, true);
  assert.equal(v.columns.length, 25);
  db.close();
});

test('W26T-MIG-3. verify before migrate → does not exist (get row-null branch)', async () => {
  const db = new sqlite3.Database(':memory:');
  const v = await Mig.verify(db);
  assert.equal(v.exists, false);
  assert.deepEqual(v.columns, []);
  db.close();
});

test('W26T-MIG-4. migrate surfaces a DB error without throwing', async () => {
  const r = await Mig.migrate(errDb);
  assert.equal(r.migrated, false);
  assert.equal(r.error, 'boom');
});

test('W26T-MIG-5. verify surfaces errors as not-verified with empty columns', async () => {
  const v = await Mig.verify(errDb);
  assert.equal(v.verified, false);
  assert.equal(v.exists, false);
  assert.deepEqual(v.columns, []);
});

test('W26T-MIG-6. verify with null-returning connection (row-null / rows-empty branches, ok path)', async () => {
  const v = await Mig.verify(nullDb);
  assert.equal(v.exists, false);
  assert.deepEqual(v.columns, []);
});

test('W26T-MIG-7. rollback drops the table; verify afterwards reports it gone', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  assert.deepEqual(await Mig.rollback(db), { rolledBack: true, table: 'tblEnterpriseTrainingProgram' });
  assert.equal((await Mig.verify(db)).exists, false);
  db.close();
});

test('W26T-MIG-8. rollback surfaces a DB error without throwing', async () => {
  const r = await Mig.rollback(errDb);
  assert.equal(r.rolledBack, false);
  assert.equal(r.error, 'boom');
});

test('W26T-MIG-9. migrate is idempotent (second call still succeeds)', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  assert.equal((await Mig.migrate(db)).migrated, true);
  db.close();
});
