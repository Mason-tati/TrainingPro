// WP-26 · Phase 3 — Enterprise Document Core repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseDocumentCore (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, by-number/folder/status queries, allow-listed search, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-core-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ documentNumber: 'N', documentTitle: 'T' }, over);

test('W26C-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26C-REPO-2. create inserts allow-listed columns and stamps timestamps', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ documentNumber: 'A1', folderId: 5, fileName: 'f.pdf', hacker: 'x' }));
  assert.equal(d.documentNumber, 'A1');
  assert.equal(d.folderId, 5);
  assert.equal(d.fileName, 'f.pdf');
  assert.ok(d.createdAt && d.updatedAt);
  assert.equal(d.hacker, undefined);
  db.close();
});

test('W26C-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26C-REPO-4. findById excludes soft-deleted; findByNumber returns the row', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ documentNumber: 'B1' }));
  assert.equal((await repo.findById(d.id)).documentNumber, 'B1');
  assert.equal((await repo.findByNumber('B1')).id, d.id);
  await repo.softDelete(d.id);
  assert.equal(await repo.findById(d.id), null);
  assert.equal(await repo.findByNumber('B1'), null);
  db.close();
});

test('W26C-REPO-5. findByFolder / findByStatus filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentNumber: 'F1', folderId: 10, status: 'DRAFT' }));
  await repo.create(mk({ documentNumber: 'F2', folderId: 10, status: 'APPROVED' }));
  await repo.create(mk({ documentNumber: 'F3', folderId: 20, status: 'DRAFT' }));
  assert.equal((await repo.findByFolder(10)).length, 2);
  assert.equal((await repo.findByStatus('DRAFT')).length, 2);
  db.close();
});

test('W26C-REPO-6. update changes allow-listed columns; documentNumber immutable', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ documentNumber: 'U1' }));
  const upd = await repo.update(d.id, { documentTitle: 'New', status: 'APPROVED', documentNumber: 'HACK' });
  assert.equal(upd.documentTitle, 'New');
  assert.equal(upd.status, 'APPROVED');
  assert.equal(upd.documentNumber, 'U1');
  db.close();
});

test('W26C-REPO-7. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ documentNumber: 'U2' }));
  const upd = await repo.update(d.id, {});
  assert.equal(upd.documentTitle, 'T');
  db.close();
});

test('W26C-REPO-8. search: exact filters', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentNumber: 'S1', status: 'DRAFT', department: 'HR', folderId: 3 }));
  await repo.create(mk({ documentNumber: 'S2', status: 'APPROVED', department: 'HR' }));
  assert.equal((await repo.search({ status: 'DRAFT' })).length, 1);
  assert.equal((await repo.search({ department: 'HR' })).length, 2);
  assert.equal((await repo.search({ folderId: 3 })).length, 1);
  db.close();
});

test('W26C-REPO-9. search: free-text over title/keywords/number', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentNumber: 'T-100', documentTitle: 'Safety Plan', keywords: 'osha' }));
  await repo.create(mk({ documentNumber: 'T-200', documentTitle: 'Menu', keywords: 'lunch plan' }));
  await repo.create(mk({ documentNumber: 'T-300', documentTitle: 'Other', keywords: 'none' }));
  assert.equal((await repo.search({ text: 'plan' })).length, 2, 'title or keywords contain plan');
  assert.equal((await repo.search({ text: 'T-100' })).length, 1, 'documentNumber matched');
  db.close();
});

test('W26C-REPO-10. search: combined filter + text; non-object → all non-deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentNumber: 'C1', status: 'DRAFT', documentTitle: 'Plan A' }));
  await repo.create(mk({ documentNumber: 'C2', status: 'APPROVED', documentTitle: 'Plan B' }));
  assert.equal((await repo.search({ status: 'DRAFT', text: 'Plan' })).length, 1);
  assert.equal((await repo.search('nope')).length, 2);
  db.close();
});

test('W26C-REPO-11. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ documentNumber: 'AR' }));
  await repo.archive(d.id);
  assert.equal((await repo.findById(d.id)).archived, 1);
  await repo.softDelete(d.id);
  await repo.restore(d.id);
  const row = await repo.findById(d.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26C-REPO-12. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ documentNumber: 'SD' }));
  await repo.softDelete(d.id);
  assert.equal(await repo.exists(d.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26C-REPO-13. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentNumber: 'CN1', status: 'DRAFT' }));
  await repo.create(mk({ documentNumber: 'CN2', status: 'APPROVED' }));
  assert.equal(await repo.count({ status: 'DRAFT' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26C-REPO-14. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ documentNumber: 'NB' }));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  const upd = await repo.update(d.id, null);
  assert.equal(upd.documentNumber, 'NB');
  db.close();
});

test('W26C-REPO-15. count with a filter that matches nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentNumber: 'Z1', status: 'DRAFT' }));
  assert.equal(await repo.count({ status: 'OBSOLETE' }), 0);
  db.close();
});
