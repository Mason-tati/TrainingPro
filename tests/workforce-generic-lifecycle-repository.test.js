// EWP-01a — Workforce Foundation Framework — generic-lifecycle-repository tests.
// The reusable persistence engine, exercised against an ephemeral in-memory-only test table built by the
// migration factory (NOT a production business table). Covers allow-listed CRUD, soft-delete, archive/
// restore, relationship/scope queries, count, audit hooks, and the never-mutating guards.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const WDIR = path.join(__dirname, '..', 'lib', 'workforce');
const MF = require(path.join(WDIR, 'migration-factory.js'));
const { GenericLifecycleRepository, createRepository } = require(path.join(WDIR, 'generic-lifecycle-repository.js'));

const TABLE = 'tblWorkforceRepoTest';
const migration = MF.defineTable({
  table: TABLE,
  columns: [{ name: 'label', type: 'TEXT', notNull: true }, { name: 'category', type: 'TEXT' }, { name: 'qty', type: 'INTEGER' }],
  includeScope: true,
});
const CONFIG = {
  table: TABLE,
  insertable: ['label', 'category', 'qty', 'active', 'archived', 'deleted', 'metadataJson'],
  updatable: ['label', 'category', 'qty', 'active', 'archived', 'deleted', 'metadataJson'],
  filterable: ['label', 'category', 'qty'],
  scopeColumns: ['tenantId', 'companyId', 'siteId'],
};

async function fresh(extraConfig) {
  const db = new sqlite3.Database(':memory:');
  await migration.migrate(db);
  return { db, repo: createRepository(db, Object.assign({}, CONFIG, extraConfig)) };
}
const mk = (over) => Object.assign({ label: 'Alpha' }, over);

test('EWP-REPO-1. constructor rejects a non-connection and a missing table', () => {
  assert.throws(() => new GenericLifecycleRepository({}, CONFIG), /injected sqlite3 database connection/);
  const db = new sqlite3.Database(':memory:');
  assert.throws(() => new GenericLifecycleRepository(db, { table: '' }), /non-empty table name/);
  assert.throws(() => new GenericLifecycleRepository(db, null), /non-empty table name/);
  db.close();
});

test('EWP-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await fresh();
  const r = await repo.create(mk({ category: 'X', qty: 3, hacker: 'z' }));
  assert.equal(r.label, 'Alpha');
  assert.equal(r.category, 'X');
  assert.equal(r.qty, 3);
  assert.equal(r.active, 1);
  assert.ok(r.createdAt && r.updatedAt);
  assert.equal(r.hacker, undefined);
  db.close();
});

test('EWP-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await fresh();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('EWP-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await fresh();
  const r = await repo.create(mk({}));
  assert.equal((await repo.findById(r.id)).label, 'Alpha');
  await repo.softDelete(r.id);
  assert.equal(await repo.findById(r.id), null);
  db.close();
});

test('EWP-REPO-5. findBy filters an allow-listed column; rejects a non-filterable column', async () => {
  const { db, repo } = await fresh();
  await repo.create(mk({ category: 'X' }));
  await repo.create(mk({ label: 'Beta', category: 'X' }));
  await repo.create(mk({ label: 'Gamma', category: 'Y' }));
  assert.equal((await repo.findBy('category', 'X')).length, 2);
  await assert.rejects(async () => repo.findBy('hacker', 'z'), /not filterable/);
  db.close();
});

test('EWP-REPO-6. findBy works for a scope column; scope columns are filterable', async () => {
  const { db, repo } = await fresh();
  await repo.create(mk({ companyId: 7 }));
  await repo.create(mk({ label: 'Beta', companyId: 7 }));
  assert.equal((await repo.findBy('companyId', 7)).length, 2);
  db.close();
});

test('EWP-REPO-7. findAll applies filters and scope; non-object args treated as empty', async () => {
  const { db, repo } = await fresh();
  await repo.create(mk({ category: 'X', companyId: 1 }));
  await repo.create(mk({ label: 'Beta', category: 'Y', companyId: 1 }));
  await repo.create(mk({ label: 'Gamma', category: 'X', companyId: 2 }));
  assert.equal((await repo.findAll({ category: 'X' })).length, 2);
  assert.equal((await repo.findAll({ category: 'X' }, { companyId: 1 })).length, 1);
  assert.equal((await repo.findAll('nope', 'nope')).length, 3, 'non-object filters/scope → all');
  db.close();
});

test('EWP-REPO-8. findActive returns active rows only', async () => {
  const { db, repo } = await fresh();
  await repo.create(mk({}));
  const del = await repo.create(mk({ label: 'Beta' }));
  await repo.softDelete(del.id);
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});

test('EWP-REPO-9. update changes allow-listed columns; empty/non-object patch refreshes only updatedAt', async () => {
  const { db, repo } = await fresh();
  const r = await repo.create(mk({}));
  const upd = await repo.update(r.id, { category: 'Z', qty: 9 });
  assert.equal(upd.category, 'Z');
  assert.equal(upd.qty, 9);
  assert.equal((await repo.update(r.id, null)).label, 'Alpha', 'non-object patch → no-op but valid');
  db.close();
});

test('EWP-REPO-10. archive / restore / softDelete lifecycle', async () => {
  const { db, repo } = await fresh();
  const r = await repo.create(mk({}));
  await repo.archive(r.id);
  assert.equal((await repo.findById(r.id)).archived, 1);
  await repo.softDelete(r.id);
  await repo.restore(r.id);
  const row = await repo.findById(r.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('EWP-REPO-11. exists ignores the deleted flag; count applies filters and scope', async () => {
  const { db, repo } = await fresh();
  const r = await repo.create(mk({ category: 'X', companyId: 1 }));
  await repo.create(mk({ label: 'Beta', category: 'Y', companyId: 1 }));
  await repo.softDelete(r.id);
  assert.equal(await repo.exists(r.id), true);
  assert.equal(await repo.exists(999), false);
  assert.equal(await repo.count(), 1, 'excludes deleted');
  assert.equal(await repo.count({ category: 'Y' }, { companyId: 1 }), 1);
  assert.equal(await repo.count('nope', 'nope'), 1, 'non-object filters/scope');
  db.close();
});

test('EWP-REPO-12. scope column supplied on create is persisted (via the scope insert path)', async () => {
  const { db, repo } = await fresh();
  const r = await repo.create(mk({ companyId: 42, siteId: 7 }));
  assert.equal(r.companyId, 42);
  assert.equal(r.siteId, 7);
  db.close();
});

test('EWP-REPO-13. a scope column also listed as insertable is not double-inserted', async () => {
  const { db, repo } = await fresh({ insertable: CONFIG.insertable.concat(['companyId']) });
  const r = await repo.create(mk({ companyId: 5 }));
  assert.equal(r.companyId, 5, 'inserted exactly once via the insertable path');
  db.close();
});

test('EWP-REPO-14. audit hook fires for every mutation and a throwing hook cannot break the write', async () => {
  const events = [];
  const { db, repo } = await fresh({ auditHook: (e) => { events.push(e.action); } });
  const r = await repo.create(mk({}));
  await repo.update(r.id, { qty: 1 });
  await repo.archive(r.id);
  await repo.restore(r.id);
  await repo.softDelete(r.id);
  assert.deepEqual(events, ['create', 'update', 'archive', 'restore', 'softDelete']);
  assert.equal(events.every((a) => typeof a === 'string'), true);
  db.close();

  const boom = await fresh({ auditHook: () => { throw new Error('audit down'); } });
  const ok = await boom.repo.create(mk({}));
  assert.ok(ok.id, 'faulty audit hook is swallowed; create still succeeds');
  boom.db.close();
});

test('EWP-REPO-15. no audit hook configured is a valid no-op', async () => {
  const { db, repo } = await fresh({ auditHook: undefined });
  const r = await repo.create(mk({}));
  assert.ok(r.id);
  db.close();
});

test('EWP-REPO-16. minimal config: non-array insertable/updatable/filterable/scopeColumns default to []', () => {
  const db = new sqlite3.Database(':memory:');
  const repo = new GenericLifecycleRepository(db, { table: TABLE });
  assert.deepEqual(repo.insertable, []);
  assert.deepEqual(repo.updatable, []);
  assert.deepEqual(repo.filterable, []);
  assert.deepEqual(repo.scopeColumns, []);
  db.close();
});

test('EWP-REPO-17. DB errors reject through _get / _all / _run (never swallowed at the repo layer)', async () => {
  const errConn = {
    run: (s, p, cb) => cb(new Error('run boom')),
    get: (s, p, cb) => cb(new Error('get boom')),
    all: (s, p, cb) => cb(new Error('all boom')),
  };
  const repo = createRepository(errConn, CONFIG);
  await assert.rejects(() => repo.findById(1), /get boom/);
  await assert.rejects(() => repo.findActive(), /all boom/);
  await assert.rejects(() => repo.create(mk({})), /run boom/);
});

test('EWP-REPO-18. a null-returning connection yields [] from _all and null from _get', async () => {
  const nullConn = {
    run: (s, p, cb) => cb.call({ lastID: 1, changes: 1 }, null),
    get: (s, p, cb) => cb(null, undefined),
    all: (s, p, cb) => cb(null, undefined),
  };
  const repo = createRepository(nullConn, CONFIG);
  assert.deepEqual(await repo.findActive(), []);
  assert.equal(await repo.findById(1), null);
});
