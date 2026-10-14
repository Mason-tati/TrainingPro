// WP-26 · Phase 13 — Enterprise Competency Recertification repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseCompetencyRecertification (reusing BaseRepository): allow-listed
// columns, SQLite-stamped timestamps, the completedDate boolean sentinel, workflow / scheduling /
// overdue queries, no business logic. Due dates are stamped relative to the DB clock for determinism.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-competency-recertification-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-competency-recertification-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ employeeProfileId: 1, employeeId: 2, competencyId: 3, dueDate: '2027-01-01', status: 'PENDING' }, over);
function stampDue(db, id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseCompetencyRecertification SET dueDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}

test('W26R-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26R-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({ recertificationType: 'REGULATORY', assignedTrainerId: 9, comments: 'note', hacker: 'x' }));
  assert.equal(r.employeeProfileId, 1);
  assert.equal(r.employeeId, 2);
  assert.equal(r.competencyId, 3);
  assert.equal(r.recertificationType, 'REGULATORY');
  assert.equal(r.status, 'PENDING');
  assert.equal(r.assignedTrainerId, 9);
  assert.ok(r.createdAt && r.updatedAt);
  assert.equal(r.hacker, undefined);
  db.close();
});

test('W26R-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26R-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  assert.equal((await repo.findById(r.id)).employeeId, 2);
  await repo.softDelete(r.id);
  assert.equal(await repo.findById(r.id), null);
  db.close();
});

test('W26R-REPO-5. findByEmployee / findByCompetency filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ employeeId: 5, competencyId: 10 }));
  await repo.create(mk({ employeeId: 5, competencyId: 11 }));
  await repo.create(mk({ employeeId: 6, competencyId: 10 }));
  assert.equal((await repo.findByEmployee(5)).length, 2);
  assert.equal((await repo.findByCompetency(10)).length, 2);
  db.close();
});

test('W26R-REPO-6. findDue / findScheduled / findCompleted filter by status', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ status: 'PENDING' }));
  await repo.create(mk({ competencyId: 4, status: 'SCHEDULED', scheduledDate: '2026-12-01' }));
  await repo.create(mk({ competencyId: 5, status: 'COMPLETED', completedDate: '2026-11-01', result: 'PASS' }));
  assert.equal((await repo.findDue()).length, 1);
  assert.equal((await repo.findScheduled()).length, 1);
  assert.equal((await repo.findCompleted()).length, 1);
  db.close();
});

test('W26R-REPO-7. findOverdue: past due and not yet completed/cancelled', async () => {
  const { db, repo } = await freshRepo();
  const late = await repo.create(mk({ status: 'PENDING' }));
  const doneLate = await repo.create(mk({ competencyId: 4, status: 'COMPLETED', completedDate: '2026-01-01', result: 'PASS' }));
  const future = await repo.create(mk({ competencyId: 5, status: 'PENDING' }));
  await stampDue(db, late.id, '-5 days');
  await stampDue(db, doneLate.id, '-5 days');
  await stampDue(db, future.id, '+30 days');
  const overdue = await repo.findOverdue();
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].id, late.id);
  db.close();
});

test('W26R-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  const upd = await repo.update(r.id, { status: 'SCHEDULED', scheduledDate: '2026-12-01', assignedAssessorId: 4 });
  assert.equal(upd.status, 'SCHEDULED');
  assert.equal(upd.scheduledDate, '2026-12-01');
  assert.equal(upd.assignedAssessorId, 4);
  db.close();
});

test('W26R-REPO-9. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  assert.equal((await repo.update(r.id, {})).employeeId, 2);
  db.close();
});

test('W26R-REPO-10. completedDate boolean sentinel stamps now; an explicit string sets the value', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  const stamped = await repo.update(r.id, { status: 'COMPLETED', result: 'PASS', completedDate: true });
  assert.equal(stamped.status, 'COMPLETED');
  assert.match(stamped.completedDate, /^\d{4}-\d{2}-\d{2} /);
  const explicit = await repo.update(r.id, { completedDate: '2026-05-01' });
  assert.equal(explicit.completedDate, '2026-05-01');
  db.close();
});

test('W26R-REPO-11. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
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

test('W26R-REPO-12. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  await repo.softDelete(r.id);
  assert.equal(await repo.exists(r.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26R-REPO-13. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ employeeId: 20, recertificationType: 'PERIODIC' }));
  await repo.create(mk({ employeeId: 20, competencyId: 4, recertificationType: 'REMEDIAL' }));
  assert.equal(await repo.count({ employeeId: 20, recertificationType: 'PERIODIC' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26R-REPO-14. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(r.id, null)).employeeId, 2);
  db.close();
});

test('W26R-REPO-15. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ status: 'PENDING' }));
  assert.equal(await repo.count({ status: 'COMPLETED' }), 0);
  db.close();
});

test('W26R-REPO-16. workflow/overdue queries return [] when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByEmployee(4242), []);
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findDue(), []);
  assert.deepEqual(await repo.findScheduled(), []);
  assert.deepEqual(await repo.findCompleted(), []);
  assert.deepEqual(await repo.findOverdue(), []);
  assert.deepEqual(await repo.findActive(), []);
  db.close();
});

test('W26R-REPO-17. reference ids, assignees and dates are persisted; findActive returns active rows', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({ currentEvidenceId: 7, currentAssessmentId: 8, currentMappingId: 9, assignedTrainerId: 11, assignedAssessorId: 12, scheduledDate: '2026-10-01' }));
  assert.equal(r.currentEvidenceId, 7);
  assert.equal(r.currentAssessmentId, 8);
  assert.equal(r.currentMappingId, 9);
  assert.equal(r.assignedTrainerId, 11);
  assert.equal(r.assignedAssessorId, 12);
  assert.equal(r.scheduledDate, '2026-10-01');
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});
