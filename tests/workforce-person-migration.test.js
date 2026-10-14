// EWP-01c — Person & Identity — migration tests. Single tblPerson master built via the migration-factory.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const Mig = require(path.join(__dirname, '..', 'lib', 'workforce', 'person', 'person-migration.js'));
const errDb = { run: (s, p, cb) => cb(new Error('boom')), get: (s, p, cb) => cb(new Error('boom')), all: (s, p, cb) => cb(new Error('boom')) };

test('EWP-PMIG-1. personColumns are the 25 identity columns', () => {
  const cols = Mig.personColumns().map((c) => c.name);
  assert.equal(cols.length, 25);
  assert.ok(cols.includes('uuid') && cols.includes('personNumber') && cols.includes('passportNumber') && cols.includes('nationalId') && cols.includes('emergencyContactRelationship'));
  const firstName = Mig.personColumns().find((c) => c.name === 'firstName');
  assert.equal(firstName.notNull, true);
});

test('EWP-PMIG-2. getColumns = id + 25 identity + 3 scope + 6 lifecycle (35)', () => {
  const cols = Mig.getColumns();
  assert.equal(cols.length, 35);
  assert.equal(cols[0], 'id');
  for (const c of ['uuid', 'personNumber', 'firstName', 'lastName', 'tenantId', 'companyId', 'siteId', 'active', 'archived', 'deleted', 'metadataJson', 'createdAt', 'updatedAt']) {
    assert.ok(cols.includes(c), `has ${c}`);
  }
  assert.equal(Mig.getTableName(), 'tblPerson');
  assert.match(Mig.getCreateTableSql(), /CREATE TABLE IF NOT EXISTS tblPerson/);
});

test('EWP-PMIG-3. migrate creates the table; verify reports 35 columns', async () => {
  const db = new sqlite3.Database(':memory:');
  assert.deepEqual(await Mig.migrate(db), { migrated: true, table: 'tblPerson' });
  const v = await Mig.verify(db);
  assert.equal(v.verified, true);
  assert.equal(v.columns.length, 35);
  db.close();
});

test('EWP-PMIG-4. rollback drops the table; verify afterwards reports it gone', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  assert.deepEqual(await Mig.rollback(db), { rolledBack: true, table: 'tblPerson' });
  assert.equal((await Mig.verify(db)).exists, false);
  db.close();
});

test('EWP-PMIG-5. migrate / verify / rollback surface DB errors without throwing', async () => {
  assert.equal((await Mig.migrate(errDb)).migrated, false);
  assert.equal((await Mig.verify(errDb)).verified, false);
  assert.equal((await Mig.rollback(errDb)).rolledBack, false);
});

test('EWP-PMIG-5b. the RLS scope block and full lifecycle block are present on tblPerson', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  const cols = (await Mig.verify(db)).columns;
  for (const c of ['tenantId', 'companyId', 'siteId', 'active', 'archived', 'deleted', 'metadataJson', 'createdAt', 'updatedAt']) {
    assert.ok(cols.includes(c), `has ${c}`);
  }
  db.close();
});

test('EWP-PMIG-6. migrate is idempotent', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  assert.equal((await Mig.migrate(db)).migrated, true);
  db.close();
});
