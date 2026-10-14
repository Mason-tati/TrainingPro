// WP-26 · Phase 7 — Enterprise Document Training repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseDocumentTraining (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps + completedDate sentinel, status/overdue queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-training-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-training-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ documentVersionId: 1, userId: 5 }, over);

test('W26T-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26T-REPO-2. create inserts allow-listed columns and stamps assignedDate/createdAt/updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({ competencyId: 3, mandatoryTraining: 1, hacker: 'x' }));
  assert.equal(t.userId, 5);
  assert.equal(t.competencyId, 3);
  assert.equal(t.trainingStatus, 'ASSIGNED');
  assert.equal(t.attempts, 0);
  assert.ok(t.assignedDate && t.createdAt && t.updatedAt);
  assert.equal(t.completedDate, null);
  assert.equal(t.hacker, undefined);
  db.close();
});

test('W26T-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26T-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({}));
  assert.equal((await repo.findById(t.id)).userId, 5);
  await repo.softDelete(t.id);
  assert.equal(await repo.findById(t.id), null);
  db.close();
});

test('W26T-REPO-5. findByVersion returns non-deleted rows for a version', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 7 }));
  await repo.create(mk({ documentVersionId: 7, userId: 6 }));
  await repo.create(mk({ documentVersionId: 8 }));
  assert.equal((await repo.findByVersion(7)).length, 2);
  db.close();
});

test('W26T-REPO-6. findPending returns ASSIGNED/IN_PROGRESS; findCompleted returns COMPLETED', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ trainingStatus: 'ASSIGNED' }));
  await repo.create(mk({ userId: 6, trainingStatus: 'IN_PROGRESS' }));
  const c = await repo.create(mk({ userId: 7, trainingStatus: 'IN_PROGRESS' }));
  await repo.update(c.id, { trainingStatus: 'COMPLETED', completedDate: true });
  assert.equal((await repo.findPending()).length, 2);
  assert.equal((await repo.findCompleted()).length, 1);
  db.close();
});

test('W26T-REPO-7. findOverdue returns past-due, not-completed rows', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ dueDate: '2000-01-01' }));           // overdue
  await repo.create(mk({ userId: 6, dueDate: '2999-01-01' })); // future, not overdue
  const done = await repo.create(mk({ userId: 7, dueDate: '2000-01-01' }));
  await repo.update(done.id, { completedDate: true });        // past due but completed → not overdue
  await repo.create(mk({ userId: 8 }));                        // no dueDate → not overdue
  assert.equal((await repo.findOverdue()).length, 1);
  db.close();
});

test('W26T-REPO-8. update: normal fields refresh updatedAt; completedDate sentinel stamps via SQL', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({}));
  const norm = await repo.update(t.id, { trainingStatus: 'IN_PROGRESS' });
  assert.equal(norm.trainingStatus, 'IN_PROGRESS');
  assert.equal(norm.completedDate, null);
  const done = await repo.update(t.id, { trainingStatus: 'COMPLETED', completedDate: true, score: 90 });
  assert.ok(done.completedDate, 'completedDate stamped');
  assert.equal(done.score, 90);
  db.close();
});

test('W26T-REPO-8b. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({}));
  assert.equal((await repo.update(t.id, {})).userId, 5);
  db.close();
});

test('W26T-REPO-9. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({}));
  await repo.archive(t.id);
  assert.equal((await repo.findById(t.id)).archived, 1);
  await repo.softDelete(t.id);
  await repo.restore(t.id);
  const row = await repo.findById(t.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26T-REPO-10. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({}));
  await repo.softDelete(t.id);
  assert.equal(await repo.exists(t.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26T-REPO-11. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 9, mandatoryTraining: 1 }));
  await repo.create(mk({ documentVersionId: 9, userId: 6, mandatoryTraining: 0 }));
  assert.equal(await repo.count({ documentVersionId: 9, mandatoryTraining: 1 }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26T-REPO-12. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(t.id, null)).userId, 5);
  db.close();
});

test('W26T-REPO-13. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ trainingStatus: 'ASSIGNED' }));
  assert.equal(await repo.count({ trainingStatus: 'WAIVED' }), 0);
  db.close();
});

test('W26T-REPO-14. findByVersion / findPending / findOverdue empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByVersion(4242), []);
  assert.deepEqual(await repo.findPending(), []);
  assert.deepEqual(await repo.findOverdue(), []);
  db.close();
});

test('W26T-REPO-15. competencyId / assessment fields are persisted', async () => {
  const { db, repo } = await freshRepo();
  const t = await repo.create(mk({ competencyId: 42, assessmentRequired: 1, assessmentPassed: 1, score: 77 }));
  assert.equal(t.competencyId, 42);
  assert.equal(t.assessmentRequired, 1);
  assert.equal(t.score, 77);
  db.close();
});
