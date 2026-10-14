// WP-26 · Phase 2 — Enterprise Folder repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseFolder (reusing BaseRepository) — allow-listed columns,
// SQLite-stamped timestamps, hierarchy queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-folder-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ folderNumber: 'N', folderName: 'F', folderPath: '/F', folderDepth: 0 }, over);

test('W26F-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26F-REPO-2. create inserts allow-listed columns and stamps timestamps', async () => {
  const { db, repo } = await freshRepo();
  const f = await repo.create(mk({ folderNumber: 'A1', folderName: 'Root', folderPath: '/Root', category: 'HR', hacker: 'x' }));
  assert.equal(f.folderNumber, 'A1');
  assert.equal(f.folderPath, '/Root');
  assert.ok(f.createdAt && f.updatedAt);
  assert.equal(f.hacker, undefined);
  db.close();
});

test('W26F-REPO-3. create with non-object data hits the DB NOT NULL constraint (no logic in repo)', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26F-REPO-4. findById returns the row and excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const f = await repo.create(mk({ folderNumber: 'B1', folderPath: '/B1' }));
  assert.equal((await repo.findById(f.id)).folderNumber, 'B1');
  await repo.softDelete(f.id);
  assert.equal(await repo.findById(f.id), null);
  db.close();
});

test('W26F-REPO-5. findByPath returns the matching non-deleted folder', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ folderNumber: 'C1', folderPath: '/C1' }));
  assert.equal((await repo.findByPath('/C1')).folderNumber, 'C1');
  assert.equal(await repo.findByPath('/nope'), null);
  db.close();
});

test('W26F-REPO-6. findRootFolders returns only parentFolderId IS NULL, ordered', async () => {
  const { db, repo } = await freshRepo();
  const r1 = await repo.create(mk({ folderNumber: 'R1', folderPath: '/R1', sortOrder: 2 }));
  await repo.create(mk({ folderNumber: 'R2', folderPath: '/R2', sortOrder: 1 }));
  await repo.create(mk({ folderNumber: 'K1', folderPath: '/R1/K1', parentFolderId: r1.id }));
  const roots = await repo.findRootFolders();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].folderNumber, 'R2', 'ordered by sortOrder');
  db.close();
});

test('W26F-REPO-7. findChildren returns direct non-deleted children of a parent', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ folderNumber: 'P1', folderPath: '/P1' }));
  await repo.create(mk({ folderNumber: 'CH1', folderPath: '/P1/CH1', parentFolderId: p.id }));
  await repo.create(mk({ folderNumber: 'CH2', folderPath: '/P1/CH2', parentFolderId: p.id }));
  assert.equal((await repo.findChildren(p.id)).length, 2);
  db.close();
});

test('W26F-REPO-8. update changes allow-listed content columns and refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const f = await repo.create(mk({ folderNumber: 'U1', folderPath: '/U1' }));
  const upd = await repo.update(f.id, { description: 'd', category: 'X', folderNumber: 'HACK' });
  assert.equal(upd.description, 'd');
  assert.equal(upd.folderNumber, 'U1', 'folderNumber immutable via update');
  db.close();
});

test('W26F-REPO-9. moveFolder updates parent/path/depth', async () => {
  const { db, repo } = await freshRepo();
  const f = await repo.create(mk({ folderNumber: 'M1', folderPath: '/M1' }));
  const moved = await repo.moveFolder(f.id, { parentFolderId: 99, folderPath: '/New/M1', folderDepth: 1 });
  assert.equal(moved.parentFolderId, 99);
  assert.equal(moved.folderPath, '/New/M1');
  assert.equal(moved.folderDepth, 1);
  db.close();
});

test('W26F-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const f = await repo.create(mk({ folderNumber: 'AR', folderPath: '/AR' }));
  await repo.archive(f.id);
  assert.equal((await repo.findById(f.id)).archived, 1);
  await repo.softDelete(f.id);
  await repo.restore(f.id);
  const row = await repo.findById(f.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26F-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const f = await repo.create(mk({ folderNumber: 'SD', folderPath: '/SD' }));
  await repo.softDelete(f.id);
  assert.equal(await repo.findById(f.id), null);
  assert.equal(await repo.exists(f.id), true, 'exists sees soft-deleted rows');
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26F-REPO-12. count respects allow-listed filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ folderNumber: 'CNT1', folderPath: '/CNT1', department: 'OPS' }));
  await repo.create(mk({ folderNumber: 'CNT2', folderPath: '/CNT2', department: 'HR' }));
  assert.equal(await repo.count({ department: 'OPS' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26F-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const f = await repo.create(mk({ folderNumber: 'NB', folderPath: '/NB' }));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  const upd = await repo.update(f.id, null); // non-object patch → {} → only updatedAt
  assert.equal(upd.folderNumber, 'NB');
  db.close();
});

test('W26F-REPO-14. count with a filter that matches nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ folderNumber: 'Z1', folderPath: '/Z1', active: 1 }));
  assert.equal(await repo.count({ archived: 1 }), 0);
  db.close();
});
