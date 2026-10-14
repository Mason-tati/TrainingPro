// WP-26 · Phase 5 — Enterprise Document Approval repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseDocumentApproval (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps + decision-date sentinels, status queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-approval-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-approval-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ documentVersionId: 1, approvalLevel: 1, approverId: 5 }, over);

test('W26A-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26A-REPO-2. create inserts allow-listed columns and stamps requestedDate/createdAt/updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({ approverRole: 'Manager', hacker: 'x' }));
  assert.equal(a.approverId, 5);
  assert.equal(a.approverRole, 'Manager');
  assert.equal(a.approvalStatus, 'PENDING');
  assert.ok(a.requestedDate && a.createdAt && a.updatedAt);
  assert.equal(a.approvedDate, null);
  assert.equal(a.hacker, undefined);
  db.close();
});

test('W26A-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26A-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  assert.equal((await repo.findById(a.id)).approverId, 5);
  await repo.softDelete(a.id);
  assert.equal(await repo.findById(a.id), null);
  db.close();
});

test('W26A-REPO-5. findByVersion returns non-deleted approvals ordered by level', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 7, approvalLevel: 2 }));
  await repo.create(mk({ documentVersionId: 7, approvalLevel: 1 }));
  await repo.create(mk({ documentVersionId: 8, approvalLevel: 1 }));
  const list = await repo.findByVersion(7);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((a) => a.approvalLevel), [1, 2]);
  db.close();
});

test('W26A-REPO-6. findPending / findApproved / findRejected filter by status', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ approvalStatus: 'PENDING' }));
  const ap = await repo.create(mk({ approvalLevel: 2, approvalStatus: 'PENDING' }));
  const rj = await repo.create(mk({ approvalLevel: 3, approvalStatus: 'PENDING' }));
  await repo.update(ap.id, { approvalStatus: 'APPROVED', approvedDate: true });
  await repo.update(rj.id, { approvalStatus: 'REJECTED', rejectedDate: true });
  assert.equal((await repo.findPending()).length, 1);
  assert.equal((await repo.findApproved()).length, 1);
  assert.equal((await repo.findRejected()).length, 1);
  db.close();
});

test('W26A-REPO-7. update: normal fields refresh updatedAt; decision-date sentinels stamp via SQL', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  const norm = await repo.update(a.id, { approverRole: 'Director' });
  assert.equal(norm.approverRole, 'Director');
  assert.equal(norm.approvedDate, null);
  const approved = await repo.update(a.id, { approvalStatus: 'APPROVED', approvedDate: true });
  assert.ok(approved.approvedDate, 'approvedDate stamped');
  const b = await repo.create(mk({ approvalLevel: 2 }));
  assert.ok((await repo.update(b.id, { rejectedDate: true })).rejectedDate, 'rejectedDate stamped');
  const c = await repo.create(mk({ approvalLevel: 3 }));
  assert.ok((await repo.update(c.id, { escalatedDate: true })).escalatedDate, 'escalatedDate stamped');
  db.close();
});

test('W26A-REPO-8. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  assert.equal((await repo.update(a.id, {})).approverId, 5);
  db.close();
});

test('W26A-REPO-9. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  await repo.archive(a.id);
  assert.equal((await repo.findById(a.id)).archived, 1);
  await repo.softDelete(a.id);
  await repo.restore(a.id);
  const row = await repo.findById(a.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26A-REPO-10. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  await repo.softDelete(a.id);
  assert.equal(await repo.exists(a.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26A-REPO-11. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 9, approvalStatus: 'PENDING' }));
  await repo.create(mk({ documentVersionId: 9, approvalLevel: 2, approvalStatus: 'PENDING' }));
  assert.equal(await repo.count({ documentVersionId: 9, approvalStatus: 'PENDING' }), 2);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26A-REPO-12. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(a.id, null)).approverId, 5);
  db.close();
});

test('W26A-REPO-13. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ approvalStatus: 'PENDING' }));
  assert.equal(await repo.count({ approvalStatus: 'REJECTED' }), 0);
  db.close();
});

test('W26A-REPO-14. findByVersion / findPending are empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByVersion(4242), []);
  assert.deepEqual(await repo.findPending(), []);
  db.close();
});

test('W26A-REPO-15. delegatedTo and escalated are persisted', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({ delegatedTo: 42, escalated: 1 }));
  assert.equal(a.delegatedTo, 42);
  assert.equal(a.escalated, 1);
  db.close();
});
