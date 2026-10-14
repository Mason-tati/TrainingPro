// EWP-01b — Reference & Organisation — service tests.
// CRUD delegated to per-level generic services (with org validators) + cross-level hierarchy. Uses an
// injected deterministic uuid generator; all against an ephemeral in-memory-only DB.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const RDIR = path.join(__dirname, '..', 'lib', 'workforce', 'reference');
const Mig = require(path.join(RDIR, 'organisation-migration.js'));
const { createOrganisationRegistry } = require(path.join(RDIR, 'organisation-repository.js'));
const { OrganisationService, createOrganisationService } = require(path.join(RDIR, 'organisation-service.js'));

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  let n = 0;
  const registry = createOrganisationRegistry(db);
  const service = createOrganisationService(registry, { uuid: () => `uuid-${(n += 1)}` });
  return { db, registry, service };
}
// Build a Company→BusinessUnit→…→CostCentre chain; returns the created node at each level.
async function chain(service) {
  const co = (await service.createNode('COMPANY', { code: 'C1', name: 'Company One' })).node;
  const bu = (await service.createNode('BUSINESS_UNIT', { code: 'BU1', name: 'BU One', parentId: co.id })).node;
  const rg = (await service.createNode('REGION', { code: 'R1', name: 'Region One', parentId: bu.id })).node;
  const cy = (await service.createNode('COUNTRY', { code: 'CY1', name: 'Country One', parentId: rg.id })).node;
  const st = (await service.createNode('SITE', { code: 'ST1', name: 'Site One', parentId: cy.id })).node;
  const dv = (await service.createNode('DIVISION', { code: 'DV1', name: 'Division One', parentId: st.id })).node;
  const dp = (await service.createNode('DEPARTMENT', { code: 'DP1', name: 'Dept One', parentId: dv.id })).node;
  const cc = (await service.createNode('COST_CENTRE', { code: 'CC1', name: 'CC One', parentId: dp.id })).node;
  return { co, bu, rg, cy, st, dv, dp, cc };
}

test('EWP-OSVC-1. constructor requires a registry with get()', () => {
  assert.throws(() => new OrganisationService(null), /organisation repository-registry/);
  assert.throws(() => new OrganisationService({}), /organisation repository-registry/);
});

test('EWP-OSVC-2. createNode: root company (no parent) then a child with a valid parent', async () => {
  const ctx = await setup();
  const co = await ctx.service.createNode('COMPANY', { code: 'C1', name: 'Company One', description: 'root' });
  assert.equal(co.ok, true);
  assert.match(co.node.uuid, /^uuid-\d+$/);
  assert.equal(co.node.parentId, null);
  const bu = await ctx.service.createNode('BUSINESS_UNIT', { code: 'BU1', name: 'BU', parentId: co.node.id });
  assert.equal(bu.ok, true);
  assert.equal(bu.node.parentId, co.node.id);
  ctx.db.close();
});

test('EWP-OSVC-3. createNode validation: unknown level / code / name / duplicates / parent rules', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createNode('BOGUS', { code: 'X', name: 'Y' })).error, 'unknown level');
  assert.equal((await ctx.service.createNode('COMPANY', { name: 'N' })).error, 'code is required');
  assert.equal((await ctx.service.createNode('COMPANY', { code: 'C' })).error, 'name is required');
  assert.equal((await ctx.service.createNode('COMPANY', 'nope')).error, 'code is required', 'non-object input');
  await ctx.service.createNode('COMPANY', { code: 'DUP', name: 'First' });
  assert.equal((await ctx.service.createNode('COMPANY', { code: 'DUP', name: 'Second' })).code, 'CONFLICT');
  assert.equal((await ctx.service.createNode('COMPANY', { code: 'OTHER', name: 'First' })).code, 'CONFLICT');
  assert.equal((await ctx.service.createNode('COMPANY', { code: 'C2', name: 'N2', parentId: 5 })).error, 'root level cannot have a parent');
  assert.equal((await ctx.service.createNode('SITE', { code: 'S', name: 'Si' })).error, 'parentId is required');
  assert.equal((await ctx.service.createNode('SITE', { code: 'S', name: 'Si', parentId: 9999 })).error, 'parent not found');
  ctx.db.close();
});

test('EWP-OSVC-4. updateNode: unknown level / not found / validation / success', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateNode('BOGUS', 1, {})).error, 'unknown level');
  assert.equal((await ctx.service.updateNode('COMPANY', 9999, { name: 'X' })).code, 'NOT_FOUND');
  const { co, bu } = await chain(ctx.service);
  await ctx.service.createNode('COMPANY', { code: 'C2', name: 'Company Two' });
  assert.equal((await ctx.service.updateNode('COMPANY', co.id, { code: '' })).error, 'code must be a non-empty string');
  assert.equal((await ctx.service.updateNode('COMPANY', co.id, { code: 'C2' })).code, 'CONFLICT', 'code taken by another');
  assert.equal((await ctx.service.updateNode('COMPANY', co.id, { name: '  ' })).error, 'name must be a non-empty string');
  assert.equal((await ctx.service.updateNode('COMPANY', co.id, { name: 'Company Two' })).code, 'CONFLICT');
  const upd = await ctx.service.updateNode('COMPANY', co.id, { description: 'renamed', code: 'C1B', name: 'Company One B' });
  assert.equal(upd.node.code, 'C1B');
  // parent rules on update
  assert.equal((await ctx.service.updateNode('COMPANY', co.id, { parentId: 5 })).error, 'root level cannot have a parent');
  assert.equal((await ctx.service.updateNode('COMPANY', co.id, { parentId: null })).ok, true, 'root may clear parent');
  assert.equal((await ctx.service.updateNode('BUSINESS_UNIT', bu.id, { parentId: 'x' })).error, 'parentId must be a positive integer');
  assert.equal((await ctx.service.updateNode('BUSINESS_UNIT', bu.id, { parentId: 9999 })).error, 'parent not found');
  assert.equal((await ctx.service.updateNode('BUSINESS_UNIT', bu.id, { parentId: co.id })).ok, true);
  ctx.db.close();
});

test('EWP-OSVC-5. getNode / listLevel: unknown / found / not-found / filtered', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.getNode('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.listLevel('BOGUS')).error, 'unknown level');
  const { co } = await chain(ctx.service);
  assert.equal((await ctx.service.getNode('COMPANY', co.id)).node.code, 'C1');
  assert.equal((await ctx.service.getNode('COMPANY', 9999)).code, 'NOT_FOUND');
  await ctx.service.createNode('COMPANY', { code: 'C2', name: 'Company Two' });
  assert.equal((await ctx.service.listLevel('COMPANY')).nodes.length, 2);
  assert.equal((await ctx.service.listLevel('COMPANY', { code: 'C1' })).nodes.length, 1);
  ctx.db.close();
});

test('EWP-OSVC-6. archive / restore / remove: unknown / success / not-found / already-archived', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveNode('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.restoreNode('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.removeNode('BOGUS', 1)).error, 'unknown level');
  const { co } = await chain(ctx.service);
  assert.equal((await ctx.service.archiveNode('COMPANY', co.id)).node.archived, 1);
  assert.equal((await ctx.service.archiveNode('COMPANY', co.id)).error, 'node already archived');
  assert.equal((await ctx.service.removeNode('COMPANY', 9999)).code, 'NOT_FOUND');
  assert.deepEqual(await ctx.service.removeNode('COMPANY', co.id), { ok: true, id: co.id });
  assert.equal((await ctx.service.restoreNode('COMPANY', co.id)).node.deleted, 0);
  ctx.db.close();
});

test('EWP-OSVC-7. children: unknown / not-found / leaf (empty) / populated', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.children('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.children('COMPANY', 9999)).code, 'NOT_FOUND');
  const { co, cc } = await chain(ctx.service);
  const kids = await ctx.service.children('COMPANY', co.id);
  assert.equal(kids.level, 'BUSINESS_UNIT');
  assert.equal(kids.nodes.length, 1);
  const leaf = await ctx.service.children('COST_CENTRE', cc.id);
  assert.equal(leaf.level, null);
  assert.deepEqual(leaf.nodes, []);
  ctx.db.close();
});

test('EWP-OSVC-8. parent: unknown / not-found / root null / orphan null / valid / deleted-parent null', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.parent('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.parent('COMPANY', 9999)).code, 'NOT_FOUND');
  const { co, bu } = await chain(ctx.service);
  assert.equal((await ctx.service.parent('COMPANY', co.id)).parent, null, 'root has no parent');
  const p = await ctx.service.parent('BUSINESS_UNIT', bu.id);
  assert.equal(p.level, 'COMPANY');
  assert.equal(p.parent.code, 'C1');
  // orphan: a non-root node inserted directly with no parentId
  const orphan = await ctx.registry.get('REGION').create({ uuid: 'o', code: 'ORPH', name: 'Orphan' });
  assert.equal((await ctx.service.parent('REGION', orphan.id)).parent, null);
  // deleted parent → parent resolves to null
  await ctx.service.removeNode('COMPANY', co.id);
  assert.equal((await ctx.service.parent('BUSINESS_UNIT', bu.id)).parent, null);
  ctx.db.close();
});

test('EWP-OSVC-9. ancestors: unknown / not-found / full chain / orphan / broken link', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.ancestors('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.ancestors('COMPANY', 9999)).code, 'NOT_FOUND');
  const { cc, co, bu } = await chain(ctx.service);
  const anc = await ctx.service.ancestors('COST_CENTRE', cc.id);
  assert.deepEqual(anc.ancestors.map((a) => a.level), ['COMPANY', 'BUSINESS_UNIT', 'REGION', 'COUNTRY', 'SITE', 'DIVISION', 'DEPARTMENT']);
  const orphan = await ctx.registry.get('REGION').create({ uuid: 'o', code: 'ORPH', name: 'Orphan' });
  assert.deepEqual((await ctx.service.ancestors('REGION', orphan.id)).ancestors, [], 'orphan has no ancestors');
  await ctx.service.removeNode('COMPANY', co.id);
  assert.deepEqual((await ctx.service.ancestors('BUSINESS_UNIT', bu.id)).ancestors, [], 'walk stops at the deleted parent');
  ctx.db.close();
});

test('EWP-OSVC-10. breadcrumb: unknown / not-found / root→leaf trail', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.breadcrumb('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.breadcrumb('COMPANY', 9999)).code, 'NOT_FOUND');
  const { cc } = await chain(ctx.service);
  const bc = await ctx.service.breadcrumb('COST_CENTRE', cc.id);
  assert.equal(bc.breadcrumb.length, 8);
  assert.equal(bc.breadcrumb[0].level, 'COMPANY');
  assert.equal(bc.breadcrumb[7].level, 'COST_CENTRE');
  ctx.db.close();
});

test('EWP-OSVC-11. descendants: unknown / not-found / leaf empty / full subtree', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.descendants('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.descendants('COMPANY', 9999)).code, 'NOT_FOUND');
  const { co, cc } = await chain(ctx.service);
  assert.equal((await ctx.service.descendants('COMPANY', co.id)).descendants.length, 7);
  assert.deepEqual((await ctx.service.descendants('COST_CENTRE', cc.id)).descendants, []);
  ctx.db.close();
});

test('EWP-OSVC-12. tree: unknown / not-found / nested tree / leaf tree', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.tree('BOGUS', 1)).error, 'unknown level');
  assert.equal((await ctx.service.tree('COMPANY', 9999)).code, 'NOT_FOUND');
  const { co, cc } = await chain(ctx.service);
  const t = await ctx.service.tree('COMPANY', co.id);
  assert.equal(t.tree.level, 'COMPANY');
  assert.equal(t.tree.children.length, 1);
  assert.equal(t.tree.children[0].level, 'BUSINESS_UNIT');
  const leaf = await ctx.service.tree('COST_CENTRE', cc.id);
  assert.deepEqual(leaf.tree.children, []);
  ctx.db.close();
});

test('EWP-OSVC-13. lookupByCode: unknown / missing code / not-found / success', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.lookupByCode('BOGUS', 'X')).error, 'unknown level');
  assert.equal((await ctx.service.lookupByCode('COMPANY', '  ')).error, 'code is required');
  assert.equal((await ctx.service.lookupByCode('COMPANY', 'NOPE')).code, 'NOT_FOUND');
  await chain(ctx.service);
  assert.equal((await ctx.service.lookupByCode('COMPANY', 'C1')).node.name, 'Company One');
  ctx.db.close();
});

test('EWP-OSVC-14. hierarchy: empty forest then a full company tree', async () => {
  const ctx = await setup();
  assert.deepEqual((await ctx.service.hierarchy()).hierarchy, []);
  await chain(ctx.service);
  await ctx.service.createNode('COMPANY', { code: 'C2', name: 'Company Two' });
  const h = await ctx.service.hierarchy();
  assert.equal(h.hierarchy.length, 2);
  assert.equal(h.hierarchy[0].children.length, 1);
  assert.equal(h.hierarchy[1].children.length, 0);
  ctx.db.close();
});

test('EWP-OSVC-15. default uuid generator (crypto.randomUUID) is used when none injected', async () => {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  const service = createOrganisationService(createOrganisationRegistry(db));
  const co = await service.createNode('COMPANY', { code: 'C1', name: 'Company One' });
  assert.match(co.node.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  db.close();
});

test('EWP-OSVC-17. metadata and displayOrder round-trip through create/update', async () => {
  const ctx = await setup();
  const co = await ctx.service.createNode('COMPANY', { code: 'C1', name: 'Company One', displayOrder: 5, metadata: { region: 'APAC' } });
  assert.equal(co.node.displayOrder, 5);
  assert.deepEqual(co.node.metadata, { region: 'APAC' });
  const upd = await ctx.service.updateNode('COMPANY', co.node.id, { displayOrder: 9, metadata: { region: 'EMEA' } });
  assert.equal(upd.node.displayOrder, 9);
  assert.deepEqual(upd.node.metadata, { region: 'EMEA' });
  ctx.db.close();
});

test('EWP-OSVC-18. mid-level ancestors and leaf parent resolve correctly', async () => {
  const ctx = await setup();
  const { st, cc } = await chain(ctx.service);
  assert.deepEqual((await ctx.service.ancestors('SITE', st.id)).ancestors.map((a) => a.level), ['COMPANY', 'BUSINESS_UNIT', 'REGION', 'COUNTRY']);
  assert.equal((await ctx.service.parent('COST_CENTRE', cc.id)).level, 'DEPARTMENT');
  ctx.db.close();
});

test('EWP-OSVC-19. descendants of a mid-level node cover only its subtree', async () => {
  const ctx = await setup();
  const { st } = await chain(ctx.service);
  assert.equal((await ctx.service.descendants('SITE', st.id)).descendants.length, 3, 'division + department + cost centre');
  ctx.db.close();
});

test('EWP-OSVC-20. listLevel filters by parentId', async () => {
  const ctx = await setup();
  const { co } = await chain(ctx.service);
  await ctx.service.createNode('BUSINESS_UNIT', { code: 'BU2', name: 'BU Two', parentId: co.id });
  assert.equal((await ctx.service.listLevel('BUSINESS_UNIT', { parentId: co.id })).nodes.length, 2);
  assert.equal((await ctx.service.listLevel('BUSINESS_UNIT', { parentId: 9999 })).nodes.length, 0);
  ctx.db.close();
});

test('EWP-OSVC-21. level helpers: parent/child resolution incl. root, leaf and unknown', async () => {
  const ctx = await setup();
  assert.equal(ctx.service._parentLevel('COMPANY'), null, 'root has null parent level');
  assert.equal(ctx.service._parentLevel('SITE'), 'COUNTRY');
  assert.equal(ctx.service._parentLevel('BOGUS'), undefined, 'unknown level → undefined');
  assert.equal(ctx.service._childLevel('COMPANY'), 'BUSINESS_UNIT');
  assert.equal(ctx.service._childLevel('COST_CENTRE'), null, 'leaf has no child level');
  assert.equal(ctx.service._childLevel('BOGUS'), null, 'unknown level → no child');
  ctx.db.close();
});

test('EWP-OSVC-22. each created node receives a distinct uuid', async () => {
  const ctx = await setup();
  const a = (await ctx.service.createNode('COMPANY', { code: 'C1', name: 'One' })).node;
  const b = (await ctx.service.createNode('COMPANY', { code: 'C2', name: 'Two' })).node;
  assert.notEqual(a.uuid, b.uuid);
  assert.match(a.uuid, /^uuid-\d+$/);
  ctx.db.close();
});

test('EWP-OSVC-23. children carry parsed metadata (copy-on-read)', async () => {
  const ctx = await setup();
  const co = (await ctx.service.createNode('COMPANY', { code: 'C1', name: 'One' })).node;
  await ctx.service.createNode('BUSINESS_UNIT', { code: 'BU1', name: 'BU', parentId: co.id, metadata: { tier: 'A' } });
  const kids = await ctx.service.children('COMPANY', co.id);
  assert.deepEqual(kids.nodes[0].metadata, { tier: 'A' });
  ctx.db.close();
});

test('EWP-OSVC-24. an archived node can be restored back to active/unarchived', async () => {
  const ctx = await setup();
  const co = (await ctx.service.createNode('COMPANY', { code: 'C1', name: 'One' })).node;
  await ctx.service.archiveNode('COMPANY', co.id);
  const restored = await ctx.service.restoreNode('COMPANY', co.id);
  assert.equal(restored.node.archived, 0);
  assert.equal(restored.node.active, 1);
  ctx.db.close();
});

test('EWP-OSVC-25. duplicate names are only rejected within the same level', async () => {
  const ctx = await setup();
  const co = (await ctx.service.createNode('COMPANY', { code: 'C-SH', name: 'Shared' })).node;
  // same name at a different level is allowed
  const bu = await ctx.service.createNode('BUSINESS_UNIT', { code: 'BU-SH', name: 'Shared', parentId: co.id });
  assert.equal(bu.ok, true);
  // same name at the same level is rejected
  assert.equal((await ctx.service.createNode('COMPANY', { code: 'C-SH2', name: 'Shared' })).code, 'CONFLICT');
  ctx.db.close();
});

test('EWP-OSVC-16. never-throw: a repository failure in a hierarchy walk is caught and returned as ERROR', async () => {
  const boom = () => { throw new Error('db down'); };
  const throwingRepo = { create: boom, findById: boom, findBy: boom, findAll: boom, findActive: boom, update() {}, archive() {}, restore() {}, softDelete() {}, exists() {} };
  const registry = { get: () => throwingRepo };
  const service = createOrganisationService(registry, { uuid: () => 'x' });
  assert.equal((await service.children('COMPANY', 1)).code, 'ERROR');
  assert.equal((await service.ancestors('COMPANY', 1)).code, 'ERROR');
  assert.equal((await service.descendants('COMPANY', 1)).code, 'ERROR');
  assert.equal((await service.tree('COMPANY', 1)).code, 'ERROR');
  assert.equal((await service.breadcrumb('COMPANY', 1)).code, 'ERROR');
  assert.equal((await service.parent('COMPANY', 1)).code, 'ERROR');
  assert.equal((await service.lookupByCode('COMPANY', 'X')).code, 'ERROR');
  assert.equal((await service.hierarchy()).code, 'ERROR');
});
