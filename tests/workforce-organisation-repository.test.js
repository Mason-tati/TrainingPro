// EWP-01b — Reference & Organisation — repository tests.
// Thin per-level configuration over the EWP-01a generic repository, assembled into a registry.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const RDIR = path.join(__dirname, '..', 'lib', 'workforce', 'reference');
const Mig = require(path.join(RDIR, 'organisation-migration.js'));
const Repo = require(path.join(RDIR, 'organisation-repository.js'));

async function fresh(options) {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, registry: Repo.createOrganisationRegistry(db, options) };
}

test('EWP-OREPO-1. levelRepositoryConfig declares allow-lists (uuid insertable, not updatable)', () => {
  const cfg = Repo.levelRepositoryConfig('tblCompany');
  assert.equal(cfg.table, 'tblCompany');
  assert.ok(cfg.insertable.includes('uuid'));
  assert.ok(!cfg.updatable.includes('uuid'), 'uuid is immutable');
  assert.deepEqual(cfg.filterable, ['code', 'name', 'parentId', 'displayOrder']);
  assert.deepEqual(cfg.scopeColumns, ['tenantId', 'companyId', 'siteId']);
});

test('EWP-OREPO-2. createLevelRepository builds a working generic repository', async () => {
  const { db } = await fresh();
  const repo = Repo.createLevelRepository(db, 'tblCompany');
  const row = await repo.create({ uuid: 'u1', code: 'C', name: 'Co' });
  assert.equal((await repo.findById(row.id)).code, 'C');
  db.close();
});

test('EWP-OREPO-3. createOrganisationRegistry registers all eight levels by name', async () => {
  const { db, registry } = await fresh();
  assert.deepEqual(registry.names(), ['BUSINESS_UNIT', 'COMPANY', 'COST_CENTRE', 'COUNTRY', 'DEPARTMENT', 'DIVISION', 'REGION', 'SITE']);
  assert.equal(registry.size(), 8);
  assert.ok(registry.get('SITE'));
  db.close();
});

test('EWP-OREPO-4. registry repositories persist to the correct per-level table', async () => {
  const { db, registry } = await fresh();
  await registry.get('SITE').create({ uuid: 'u', code: 'SITE-1', name: 'Site One' });
  const rows = await registry.get('SITE').findBy('code', 'SITE-1');
  assert.equal(rows.length, 1);
  assert.equal((await registry.get('COMPANY').findActive()).length, 0, 'levels are isolated');
  db.close();
});

test('EWP-OREPO-5. an audit hook passed to the registry propagates to each level repository', async () => {
  const events = [];
  const { db, registry } = await fresh({ auditHook: (e) => events.push(`${e.table}:${e.action}`) });
  await registry.get('COMPANY').create({ uuid: 'u', code: 'C', name: 'Co' });
  await registry.get('SITE').create({ uuid: 'u2', code: 'S', name: 'Site' });
  assert.deepEqual(events, ['tblCompany:create', 'tblSite:create']);
  db.close();
});

test('EWP-OREPO-5b. registry repositories support parentId relationship queries', async () => {
  const { db, registry } = await fresh();
  const co = await registry.get('COMPANY').create({ uuid: 'u', code: 'C', name: 'Co' });
  await registry.get('BUSINESS_UNIT').create({ uuid: 'b1', code: 'BU1', name: 'BU1', parentId: co.id });
  await registry.get('BUSINESS_UNIT').create({ uuid: 'b2', code: 'BU2', name: 'BU2', parentId: co.id });
  assert.equal((await registry.get('BUSINESS_UNIT').findBy('parentId', co.id)).length, 2);
  db.close();
});

test('EWP-OREPO-6. exported allow-list arrays are defensive copies; non-object options tolerated', async () => {
  Repo.INSERTABLE.push('HACK');
  Repo.FILTERABLE.push('HACK');
  assert.ok(!Repo.levelRepositoryConfig('tblX').insertable.includes('HACK'));
  const { db, registry } = await fresh('not-object');
  assert.equal(registry.size(), 8);
  db.close();
});
