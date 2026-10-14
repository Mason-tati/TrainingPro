// EWP-01b — Reference & Organisation — seed-data tests.
// Optional sample hierarchy applied THROUGH the service. Never auto-runs; importing has no side effects.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const RDIR = path.join(__dirname, '..', 'lib', 'workforce', 'reference');
const Mig = require(path.join(RDIR, 'organisation-migration.js'));
const { createOrganisationRegistry } = require(path.join(RDIR, 'organisation-repository.js'));
const { createOrganisationService } = require(path.join(RDIR, 'organisation-service.js'));
const Seed = require(path.join(RDIR, 'reference-seed-data.js'));

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  let n = 0;
  return { db, service: createOrganisationService(createOrganisationRegistry(db), { uuid: () => `uuid-${(n += 1)}` }) };
}

test('EWP-SEED-1. SEED / getSeed / PLAN are exposed as defensive copies', () => {
  assert.equal(Seed.SEED.companies.length, 1);
  assert.equal(Seed.SEED.businessUnits.length, 2);
  assert.equal(Seed.SEED.sites.length, 3);
  assert.equal(Seed.PLAN.length, 8);
  const s = Seed.getSeed();
  s.companies.push({ key: 'HACK' });
  assert.equal(Seed.getSeed().companies.length, 1, 'getSeed returns a fresh copy');
  Seed.PLAN.push({ level: 'HACK' });
  assert.equal(Seed.SEED.companies.length, 1);
});

test('EWP-SEED-2. applySeed creates the full sample hierarchy through the service', async () => {
  const { db, service } = await freshService();
  const res = await Seed.applySeed(service);
  assert.equal(res.ok, true);
  assert.equal(res.created.COMPANY.length, 1);
  assert.equal(res.created.BUSINESS_UNIT.length, 2);
  assert.equal(res.created.REGION.length, 2);
  assert.equal(res.created.COUNTRY.length, 2);
  assert.equal(res.created.SITE.length, 3);
  assert.equal(res.created.DIVISION.length, 2);
  assert.equal(res.created.DEPARTMENT.length, 2);
  assert.equal(res.created.COST_CENTRE.length, 2);
  // hierarchy is correctly wired: cost centre resolves back to the company
  const cc = res.created.COST_CENTRE[0];
  const bc = await service.breadcrumb('COST_CENTRE', cc.id);
  assert.equal(bc.breadcrumb[0].level, 'COMPANY');
  assert.equal(bc.breadcrumb[0].code, 'GMC');
  db.close();
});

test('EWP-SEED-3. applySeed reports the first rejected node (running twice → duplicate code)', async () => {
  const { db, service } = await freshService();
  assert.equal((await Seed.applySeed(service)).ok, true);
  const second = await Seed.applySeed(service);
  assert.equal(second.ok, false);
  assert.equal(second.level, 'COMPANY');
  assert.equal(second.code, 'GMC');
  assert.equal(second.result.code, 'CONFLICT');
  db.close();
});

test('EWP-SEED-5. applySeed produces 16 nodes across the eight levels, all reachable in the forest', async () => {
  const { db, service } = await freshService();
  const res = await Seed.applySeed(service);
  const total = Object.values(res.created).reduce((a, arr) => a + arr.length, 0);
  assert.equal(total, 16);
  const h = await service.hierarchy();
  assert.equal(h.hierarchy.length, 1);
  assert.equal(h.hierarchy[0].children.length, 2, 'two business units under the company');
  db.close();
});

test('EWP-SEED-4. importing the module runs nothing (no auto-seed)', async () => {
  const { db, service } = await freshService();
  // merely requiring Seed (done at top) created nothing
  assert.deepEqual((await service.hierarchy()).hierarchy, []);
  db.close();
});
