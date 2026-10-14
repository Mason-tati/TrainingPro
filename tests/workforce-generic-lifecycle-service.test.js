// EWP-01a — Workforce Foundation Framework — generic-lifecycle-service tests.
// The reusable never-throw business shell. Happy paths run against a real framework repository over an
// ephemeral in-memory-only test table; not-found/never-throw paths use a fake repository.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const WDIR = path.join(__dirname, '..', 'lib', 'workforce');
const MF = require(path.join(WDIR, 'migration-factory.js'));
const { createRepository } = require(path.join(WDIR, 'generic-lifecycle-repository.js'));
const { GenericLifecycleService, createService } = require(path.join(WDIR, 'generic-lifecycle-service.js'));

const TABLE = 'tblWorkforceServiceTest';
const migration = MF.defineTable({ table: TABLE, columns: [{ name: 'label', type: 'TEXT', notNull: true }, { name: 'category', type: 'TEXT' }] });
const REPO_CONFIG = {
  table: TABLE,
  insertable: ['label', 'category', 'metadataJson'],
  updatable: ['label', 'category', 'metadataJson'],
  filterable: ['label', 'category'],
};

async function fresh(serviceConfig) {
  const db = new sqlite3.Database(':memory:');
  await migration.migrate(db);
  const repo = createRepository(db, REPO_CONFIG);
  return { db, repo, service: createService(repo, serviceConfig) };
}

test('EWP-SVC-1. constructor requires a repository with create() and findById()', () => {
  assert.throws(() => new GenericLifecycleService({}, {}), /create\(\) and findById\(\)/);
  assert.throws(() => new GenericLifecycleService(null, {}), /create\(\) and findById\(\)/);
});

test('EWP-SVC-2. default resourceKey/collectionKey; create returns the record wrapped with metadata', async () => {
  const { db, service } = await fresh();
  const r = await service.create({ label: 'Alpha', metadata: { a: 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.record.label, 'Alpha');
  assert.deepEqual(r.record.metadata, { a: 1 });
  db.close();
});

test('EWP-SVC-3. custom resourceKey/collectionKey are honoured', async () => {
  const { db, service } = await fresh({ resourceKey: 'thing', collectionKey: 'things' });
  const c = await service.create({ label: 'Beta' });
  assert.ok(c.thing.id);
  const list = await service.listActive();
  assert.equal(Array.isArray(list.things), true);
  db.close();
});

test('EWP-SVC-4. create runs validateCreate and short-circuits on invalid', async () => {
  const calls = [];
  const { db, service } = await fresh({ validateCreate: (input) => { calls.push(input); return input.label ? null : { ok: false, error: 'label required', code: 'VALIDATION' }; } });
  assert.equal((await service.create({})).error, 'label required');
  assert.equal((await service.create({ label: 'A' })).ok, true);
  assert.equal(calls.length, 2);
  db.close();
});

test('EWP-SVC-5. create metadata: object stored, non-object → null, absent → untouched', async () => {
  const { db, service } = await fresh();
  assert.deepEqual((await service.create({ label: 'A', metadata: { x: 1 } })).record.metadata, { x: 1 });
  assert.equal((await service.create({ label: 'B', metadata: 'oops' })).record.metadata, null);
  assert.equal((await service.create({ label: 'C' })).record.metadata, null);
  db.close();
});

test('EWP-SVC-6. update: not-found / validateUpdate invalid / success / non-object patch', async () => {
  const { db, service } = await fresh({ validateUpdate: (patch) => (patch.label === '' ? { ok: false, error: 'bad', code: 'VALIDATION' } : null) });
  assert.equal((await service.update(9999, { label: 'X' })).code, 'NOT_FOUND');
  const c = await service.create({ label: 'Alpha' });
  const id = c.record.id;
  assert.equal((await service.update(id, { label: '' })).error, 'bad');
  const upd = await service.update(id, { category: 'Z', metadata: { v: 2 } });
  assert.equal(upd.record.category, 'Z');
  assert.deepEqual(upd.record.metadata, { v: 2 });
  assert.equal((await service.update(id, null)).ok, true, 'non-object patch treated as empty');
  db.close();
});

test('EWP-SVC-7. get returns a record or NOT_FOUND', async () => {
  const { db, service } = await fresh();
  const c = await service.create({ label: 'Alpha' });
  assert.equal((await service.get(c.record.id)).record.label, 'Alpha');
  assert.equal((await service.get(9999)).code, 'NOT_FOUND');
  db.close();
});

test('EWP-SVC-8. list / listBy / listActive map metadata', async () => {
  const { db, service } = await fresh();
  await service.create({ label: 'Alpha', category: 'X' });
  await service.create({ label: 'Beta', category: 'X' });
  await service.create({ label: 'Gamma', category: 'Y' });
  assert.equal((await service.list({ category: 'X' })).records.length, 2);
  assert.equal((await service.listBy('category', 'X')).records.length, 2);
  assert.equal((await service.listActive()).records.length, 3);
  db.close();
});

test('EWP-SVC-9. archive: success, not-found, already-archived guard', async () => {
  const { db, service } = await fresh();
  assert.equal((await service.archive(9999)).code, 'NOT_FOUND');
  const c = await service.create({ label: 'Alpha' });
  assert.equal((await service.archive(c.record.id)).record.archived, 1);
  assert.equal((await service.archive(c.record.id)).error, 'record already archived');
  db.close();
});

test('EWP-SVC-10. remove then restore; both guard NOT_FOUND', async () => {
  const { db, service } = await fresh();
  assert.equal((await service.remove(9999)).code, 'NOT_FOUND');
  assert.equal((await service.restore(9999)).code, 'NOT_FOUND');
  const c = await service.create({ label: 'Alpha' });
  const id = c.record.id;
  assert.deepEqual(await service.remove(id), { ok: true, id });
  assert.equal((await service.get(id)).code, 'NOT_FOUND');
  assert.equal((await service.restore(id)).record.deleted, 0);
  db.close();
});

test('EWP-SVC-11. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const brokenRepo = { create() { throw new Error('db down'); }, findById() { throw new Error('db down'); }, findAll() { throw new Error('db down'); }, findBy() {}, findActive() {}, update() {}, archive() {}, restore() {}, softDelete() {}, exists() {} };
  const service = createService(brokenRepo, {});
  const r = await service.get(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  const c = await service.create({ label: 'x' });
  assert.equal(c.code, 'ERROR');
  const l = await service.list({});
  assert.equal(l.code, 'ERROR');
});

test('EWP-SVC-12. non-object create input is treated as empty; a non-Error throw yields a generic ERROR', async () => {
  const { db, service } = await fresh();
  // non-object input → src = {} → repo.create({}) violates NOT NULL → caught as ERROR (branch: input not object)
  assert.equal((await service.create('nope')).code, 'ERROR');
  db.close();
  // a thrown non-Error exercises the `(e && e.message) || 'ERROR'` fallback
  const stringyRepo = { create() {}, findById() { throw 'stringy'; } };
  const svc = createService(stringyRepo, {});
  const r = await svc.get(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
