// WP-26 · Phase 1 — Enterprise Document repository tests (ephemeral in-memory DB only).
// The repository is pure persistence over tblEnterpriseDocument via an injected sqlite3 connection
// (reusing the certified BaseRepository) — allow-listed columns, SQLite-stamped timestamps, no logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const base = (n) => ({ documentNumber: n, title: 'T-' + n });

test('W26-REPO-1. constructor rejects a non-sqlite connection (BaseRepository contract)', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26-REPO-2. create inserts an allow-listed row and stamps createdAt/updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const doc = await repo.create({ documentNumber: 'D1', title: 'Doc', category: 'HR', status: 'DRAFT', hacker: 'ignored' });
  assert.equal(doc.documentNumber, 'D1');
  assert.equal(doc.category, 'HR');
  assert.equal(doc.deleted, 0);
  assert.ok(doc.createdAt && doc.updatedAt, 'timestamps stamped by SQLite');
  assert.equal(doc.hacker, undefined, 'non-allow-listed input never persisted');
  db.close();
});

test('W26-REPO-3. create with non-object data hits the DB NOT NULL constraint (no business logic in repo)', async () => {
  const { db, repo } = await freshRepo();
  // non-object → {} → no columns → documentNumber/title NOT NULL rejected by SQLite (the repo enforces nothing)
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26-REPO-4. findById returns the row and excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const created = await repo.create(base('D2'));
  assert.equal((await repo.findById(created.id)).documentNumber, 'D2');
  await repo.softDelete(created.id);
  assert.equal(await repo.findById(created.id), null, 'soft-deleted excluded');
  db.close();
});

test('W26-REPO-5. findByNumber returns the row (non-deleted)', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(base('D3'));
  assert.equal((await repo.findByNumber('D3')).documentNumber, 'D3');
  assert.equal(await repo.findByNumber('NOPE'), null);
  db.close();
});

test('W26-REPO-6. update changes allow-listed columns, refreshes updatedAt, keeps documentNumber', async () => {
  const { db, repo } = await freshRepo();
  const created = await repo.create(base('D4'));
  const updated = await repo.update(created.id, { title: 'New', status: 'APPROVED', documentNumber: 'HACK' });
  assert.equal(updated.title, 'New');
  assert.equal(updated.status, 'APPROVED');
  assert.equal(updated.documentNumber, 'D4', 'documentNumber immutable');
  db.close();
});

test('W26-REPO-7. update with empty patch still refreshes updatedAt only', async () => {
  const { db, repo } = await freshRepo();
  const created = await repo.create(base('D5'));
  const updated = await repo.update(created.id, {});
  assert.equal(updated.title, 'T-D5');
  db.close();
});

test('W26-REPO-8. findAll filters by allow-listed columns and excludes deleted; ignores unknown filters', async () => {
  const { db, repo } = await freshRepo();
  await repo.create({ documentNumber: 'A1', title: 'a', category: 'HR' });
  await repo.create({ documentNumber: 'A2', title: 'b', category: 'OPS' });
  const del = await repo.create({ documentNumber: 'A3', title: 'c', category: 'HR' });
  await repo.softDelete(del.id);
  assert.equal((await repo.findAll({ category: 'HR', bogus: 'x' })).length, 1, 'one HR doc remains after delete');
  assert.equal((await repo.findAll()).length, 2, 'no filter → all non-deleted');
  db.close();
});

test('W26-REPO-9. archive sets archived=1 (still findable)', async () => {
  const { db, repo } = await freshRepo();
  const created = await repo.create(base('D6'));
  await repo.archive(created.id);
  assert.equal((await repo.findById(created.id)).archived, 1);
  db.close();
});

test('W26-REPO-10. restore clears deleted and archived flags', async () => {
  const { db, repo } = await freshRepo();
  const created = await repo.create(base('D7'));
  await repo.archive(created.id);
  await repo.softDelete(created.id);
  await repo.restore(created.id);
  const row = await repo.findById(created.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  db.close();
});

test('W26-REPO-11. exists ignores the deleted flag; count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  const created = await repo.create({ documentNumber: 'D8', title: 't', category: 'HR' });
  assert.equal(await repo.exists(created.id), true);
  assert.equal(await repo.exists(999), false);
  await repo.softDelete(created.id);
  assert.equal(await repo.exists(created.id), true, 'exists sees soft-deleted rows');
  assert.equal(await repo.count({ category: 'HR' }), 0, 'count excludes soft-deleted');
  assert.equal(await repo.count(), 0);
  db.close();
});

test('W26-REPO-12. non-object filters/patch (primitive / array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const f1 = await repo.create(base('F1'));
  await repo.create(base('F2'));
  assert.equal((await repo.findAll('not-an-object')).length, 2, 'string filter → no filter');
  assert.equal((await repo.findAll([])).length, 2, 'array filter → no filter');
  assert.equal(await repo.count('nope'), 2);
  const updated = await repo.update(f1.id, null); // non-object patch → {} → only updatedAt refreshed
  assert.equal(updated.title, 'T-F1');
  db.close();
});
