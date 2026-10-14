// WP-26 · Phase 6 — Enterprise Document Distribution repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseDocumentDistribution (reusing BaseRepository): allow-listed
// columns, SQLite-stamped timestamps + date sentinels, status/ack queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-distribution-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-distribution-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ documentVersionId: 1, userId: 5 }, over);

test('W26X-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26X-REPO-2. create inserts allow-listed columns and stamps createdAt/updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ deliveryMethod: 'EMAIL', mandatoryRead: 1, hacker: 'x' }));
  assert.equal(d.userId, 5);
  assert.equal(d.deliveryMethod, 'EMAIL');
  assert.equal(d.distributionStatus, 'PENDING');
  assert.equal(d.acknowledged, 0);
  assert.equal(d.notificationCount, 0);
  assert.ok(d.createdAt && d.updatedAt);
  assert.equal(d.hacker, undefined);
  db.close();
});

test('W26X-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26X-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({}));
  assert.equal((await repo.findById(d.id)).userId, 5);
  await repo.softDelete(d.id);
  assert.equal(await repo.findById(d.id), null);
  db.close();
});

test('W26X-REPO-5. findByVersion returns non-deleted rows for a version', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 7 }));
  await repo.create(mk({ documentVersionId: 7, userId: 6 }));
  await repo.create(mk({ documentVersionId: 8 }));
  assert.equal((await repo.findByVersion(7)).length, 2);
  db.close();
});

test('W26X-REPO-6. findPending / findAcknowledged / findOutstanding', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ distributionStatus: 'PENDING' }));
  const a = await repo.create(mk({ userId: 6, distributionStatus: 'SENT' }));
  await repo.update(a.id, { acknowledged: 1, distributionStatus: 'ACKNOWLEDGED', acknowledgedDate: true });
  assert.equal((await repo.findPending()).length, 1, 'one PENDING');
  assert.equal((await repo.findAcknowledged()).length, 1, 'one acknowledged');
  assert.equal((await repo.findOutstanding()).length, 1, 'the un-acknowledged one');
  assert.ok(p.id);
  db.close();
});

test('W26X-REPO-7. update: normal fields refresh updatedAt; date sentinels stamp via SQL', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({}));
  const norm = await repo.update(d.id, { deliveryMethod: 'SMS' });
  assert.equal(norm.deliveryMethod, 'SMS');
  assert.equal(norm.acknowledgedDate, null);
  const acked = await repo.update(d.id, { acknowledged: 1, acknowledgedDate: true });
  assert.ok(acked.acknowledgedDate, 'acknowledgedDate stamped');
  const notified = await repo.update(d.id, { notificationCount: 3, lastNotificationDate: true });
  assert.equal(notified.notificationCount, 3);
  assert.ok(notified.lastNotificationDate, 'lastNotificationDate stamped');
  db.close();
});

test('W26X-REPO-8. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({}));
  assert.equal((await repo.update(d.id, {})).userId, 5);
  db.close();
});

test('W26X-REPO-9. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({}));
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

test('W26X-REPO-10. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({}));
  await repo.softDelete(d.id);
  assert.equal(await repo.exists(d.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26X-REPO-11. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 9, mandatoryRead: 1 }));
  await repo.create(mk({ documentVersionId: 9, userId: 6, mandatoryRead: 0 }));
  assert.equal(await repo.count({ documentVersionId: 9, mandatoryRead: 1 }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26X-REPO-12. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(d.id, null)).userId, 5);
  db.close();
});

test('W26X-REPO-13. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ distributionStatus: 'PENDING' }));
  assert.equal(await repo.count({ distributionStatus: 'EXPIRED' }), 0);
  db.close();
});

test('W26X-REPO-14. findByVersion / findPending / findOutstanding empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByVersion(4242), []);
  assert.deepEqual(await repo.findPending(), []);
  assert.deepEqual(await repo.findOutstanding(), []);
  db.close();
});

test('W26X-REPO-15. distributionGroupId and mandatoryRead are persisted', async () => {
  const { db, repo } = await freshRepo();
  const d = await repo.create(mk({ userId: undefined, distributionGroupId: 42, mandatoryRead: 1 }));
  assert.equal(d.distributionGroupId, 42);
  assert.equal(d.mandatoryRead, 1);
  db.close();
});
