// WP-26 · Phase 4 — Enterprise Document Version repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseDocumentVersion (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, by-document/current/version queries, SQL-stamped supersede, no logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-version-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ documentId: 1, majorVersion: 1, minorVersion: 0, versionNumber: '1.0' }, over);

test('W26V-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26V-REPO-2. create inserts allow-listed columns and stamps timestamps', async () => {
  const { db, repo } = await freshRepo();
  const v = await repo.create(mk({ versionNumber: '1.0', changeSummary: 'init', hacker: 'x' }));
  assert.equal(v.versionNumber, '1.0');
  assert.equal(v.changeSummary, 'init');
  assert.equal(v.supersededDate, null);
  assert.ok(v.createdAt && v.updatedAt);
  assert.equal(v.hacker, undefined);
  db.close();
});

test('W26V-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26V-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const v = await repo.create(mk({ versionNumber: '1.0' }));
  assert.equal((await repo.findById(v.id)).versionNumber, '1.0');
  await repo.softDelete(v.id);
  assert.equal(await repo.findById(v.id), null);
  db.close();
});

test('W26V-REPO-5. findByDocument returns non-deleted versions ordered by version', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentId: 7, majorVersion: 2, minorVersion: 0, versionNumber: '2.0' }));
  await repo.create(mk({ documentId: 7, majorVersion: 1, minorVersion: 1, versionNumber: '1.1' }));
  await repo.create(mk({ documentId: 8, majorVersion: 1, minorVersion: 0, versionNumber: '1.0' }));
  const list = await repo.findByDocument(7);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((v) => v.versionNumber), ['1.1', '2.0'], 'ordered by major,minor');
  db.close();
});

test('W26V-REPO-6. findVersion returns a specific (documentId, versionNumber)', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentId: 3, versionNumber: '1.0' }));
  assert.equal((await repo.findVersion(3, '1.0')).documentId, 3);
  assert.equal(await repo.findVersion(3, '9.9'), null);
  db.close();
});

test('W26V-REPO-7. findCurrent returns the non-superseded version', async () => {
  const { db, repo } = await freshRepo();
  const v1 = await repo.create(mk({ documentId: 5, versionNumber: '1.0' }));
  const v2 = await repo.create(mk({ documentId: 5, majorVersion: 1, minorVersion: 1, versionNumber: '1.1' }));
  assert.equal((await repo.findCurrent(5)).id, v2.id, 'both current until one is superseded');
  await repo.update(v1.id, { supersededDate: true });
  const cur = await repo.findCurrent(5);
  assert.equal(cur.id, v2.id, 'v2 remains current');
  await repo.update(v2.id, { supersededDate: true });
  assert.equal(await repo.findCurrent(5), null, 'none current when all superseded');
  db.close();
});

test('W26V-REPO-8. update: normal fields refresh updatedAt; supersededDate:true stamps via SQL', async () => {
  const { db, repo } = await freshRepo();
  const v = await repo.create(mk({ versionNumber: '1.0' }));
  const norm = await repo.update(v.id, { approvalStatus: 'APPROVED' });
  assert.equal(norm.approvalStatus, 'APPROVED');
  assert.equal(norm.supersededDate, null, 'normal update does not set supersededDate');
  const sup = await repo.update(v.id, { supersededDate: true, approvalStatus: 'SUPERSEDED' });
  assert.ok(sup.supersededDate, 'supersededDate stamped by SQL');
  assert.equal(sup.approvalStatus, 'SUPERSEDED');
  db.close();
});

test('W26V-REPO-9. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const v = await repo.create(mk({ versionNumber: '1.0' }));
  const upd = await repo.update(v.id, {});
  assert.equal(upd.versionNumber, '1.0');
  db.close();
});

test('W26V-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const v = await repo.create(mk({ versionNumber: '1.0' }));
  await repo.archive(v.id);
  assert.equal((await repo.findById(v.id)).archived, 1);
  await repo.softDelete(v.id);
  await repo.restore(v.id);
  const row = await repo.findById(v.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26V-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const v = await repo.create(mk({ versionNumber: '1.0' }));
  await repo.softDelete(v.id);
  assert.equal(await repo.exists(v.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26V-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentId: 9, versionNumber: '1.0', approvalStatus: 'DRAFT' }));
  await repo.create(mk({ documentId: 9, majorVersion: 1, minorVersion: 1, versionNumber: '1.1', approvalStatus: 'APPROVED' }));
  assert.equal(await repo.count({ documentId: 9, approvalStatus: 'DRAFT' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26V-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const v = await repo.create(mk({ versionNumber: '1.0' }));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  const upd = await repo.update(v.id, null);
  assert.equal(upd.versionNumber, '1.0');
  db.close();
});

test('W26V-REPO-14. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ versionNumber: '1.0', approvalStatus: 'DRAFT' }));
  assert.equal(await repo.count({ approvalStatus: 'REJECTED' }), 0);
  db.close();
});

test('W26V-REPO-15. findByDocument / findCurrent are empty for an unknown document', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByDocument(4242), []);
  assert.equal(await repo.findCurrent(4242), null);
  db.close();
});
