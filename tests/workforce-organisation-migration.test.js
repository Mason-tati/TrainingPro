// EWP-01b — Reference & Organisation — migration tests.
// Eight hierarchy tables built via the EWP-01a migration-factory; never applied to production.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const Mig = require(path.join(__dirname, '..', 'lib', 'workforce', 'reference', 'organisation-migration.js'));
const errDb = { run: (s, p, cb) => cb(new Error('boom')), get: (s, p, cb) => cb(new Error('boom')), all: (s, p, cb) => cb(new Error('boom')) };

test('EWP-OMIG-1. LEVELS / getLevels describe the strict typed chain (copy-on-read)', () => {
  const levels = Mig.getLevels();
  assert.equal(levels.length, 8);
  assert.deepEqual(levels.map((l) => l.level), ['COMPANY', 'BUSINESS_UNIT', 'REGION', 'COUNTRY', 'SITE', 'DIVISION', 'DEPARTMENT', 'COST_CENTRE']);
  assert.equal(levels[0].parent, null);
  assert.equal(levels[7].parent, 'DEPARTMENT');
  Mig.LEVELS.push({ level: 'HACK' });
  assert.equal(Mig.getLevels().length, 8, 'exported LEVELS is a copy');
});

test('EWP-OMIG-2. organisationColumns are the six shared org columns', () => {
  const cols = Mig.organisationColumns().map((c) => c.name);
  assert.deepEqual(cols, ['uuid', 'code', 'name', 'description', 'displayOrder', 'parentId']);
});

test('EWP-OMIG-3. getMigration returns a level migration; unknown level → null', () => {
  assert.ok(Mig.getMigration('COMPANY'));
  assert.equal(Mig.getMigration('NOPE'), null);
  assert.equal(Mig.getMigration('SITE').getTableName(), 'tblSite');
});

test('EWP-OMIG-3b. getMigration maps each level to its correct table', () => {
  const expected = { COMPANY: 'tblCompany', BUSINESS_UNIT: 'tblBusinessUnit', REGION: 'tblRegion', COUNTRY: 'tblCountry', SITE: 'tblSite', DIVISION: 'tblDivision', DEPARTMENT: 'tblDepartment', COST_CENTRE: 'tblCostCentre' };
  for (const [level, table] of Object.entries(expected)) {
    assert.equal(Mig.getMigration(level).getTableName(), table);
  }
});

test('EWP-OMIG-4. migrate creates all 8 tables; each carries org + scope + lifecycle columns', async () => {
  const db = new sqlite3.Database(':memory:');
  const m = await Mig.migrate(db);
  assert.equal(m.migrated, true);
  assert.equal(m.tables.length, 8);
  const v = await Mig.verify(db);
  assert.equal(v.verified, true);
  const company = v.tables.find((t) => t.level === 'COMPANY');
  for (const col of ['id', 'uuid', 'code', 'name', 'description', 'displayOrder', 'parentId', 'tenantId', 'companyId', 'siteId', 'active', 'archived', 'deleted', 'metadataJson', 'createdAt', 'updatedAt']) {
    assert.ok(company.columns.includes(col), `tblCompany has ${col}`);
  }
  assert.equal(company.columns.length, 16);
  db.close();
});

test('EWP-OMIG-5. rollback drops all tables; verify afterwards reports them gone', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  const r = await Mig.rollback(db);
  assert.equal(r.rolledBack, true);
  assert.equal(r.tables.length, 8);
  assert.equal((await Mig.verify(db)).verified, false);
  db.close();
});

test('EWP-OMIG-6. migrate / verify / rollback surface DB errors without throwing', async () => {
  assert.equal((await Mig.migrate(errDb)).migrated, false);
  assert.equal((await Mig.verify(errDb)).verified, false);
  assert.equal((await Mig.rollback(errDb)).rolledBack, false);
});

test('EWP-OMIG-7b. every one of the eight tables exists with the full 16-column shape', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  const v = await Mig.verify(db);
  assert.equal(v.tables.length, 8);
  for (const t of v.tables) {
    assert.equal(t.exists, true, `${t.table} exists`);
    assert.equal(t.columns.length, 16, `${t.table} has 16 columns`);
    assert.ok(t.columns.includes('parentId') && t.columns.includes('uuid'));
  }
  db.close();
});

test('EWP-OMIG-7. migrate is idempotent (second call still succeeds)', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  assert.equal((await Mig.migrate(db)).migrated, true);
  db.close();
});
