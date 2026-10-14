// WP-26 · Phase 9 — Enterprise Document Assessment repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseDocumentAssessment (reusing BaseRepository): allow-listed
// columns, SQLite-stamped timestamps, lifecycle/expiry queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-assessment-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-assessment-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ documentVersionId: 1, assessmentId: 5, assessmentCode: 'A1', assessmentTitle: 'One' }, over);

test('W26S-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26S-REPO-2. create inserts allow-listed columns and stamps createdAt/updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({ assessmentType: 'EXAM', passMark: 80, randomizeQuestions: 1, hacker: 'x' }));
  assert.equal(a.assessmentCode, 'A1');
  assert.equal(a.assessmentType, 'EXAM');
  assert.equal(a.passMark, 80);
  assert.equal(a.assessmentStatus, 'DRAFT');
  assert.ok(a.createdAt && a.updatedAt);
  assert.equal(a.hacker, undefined);
  db.close();
});

test('W26S-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26S-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  assert.equal((await repo.findById(a.id)).assessmentCode, 'A1');
  await repo.softDelete(a.id);
  assert.equal(await repo.findById(a.id), null);
  db.close();
});

test('W26S-REPO-5. findByVersion returns non-deleted rows for a version', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 7 }));
  await repo.create(mk({ documentVersionId: 7, assessmentId: 6 }));
  await repo.create(mk({ documentVersionId: 8 }));
  assert.equal((await repo.findByVersion(7)).length, 2);
  db.close();
});

test('W26S-REPO-6. findPublished returns PUBLISHED; findActive returns active=1', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ assessmentStatus: 'DRAFT' }));
  await repo.create(mk({ assessmentId: 6, assessmentStatus: 'PUBLISHED' }));
  const del = await repo.create(mk({ assessmentId: 7 }));
  await repo.softDelete(del.id);
  assert.equal((await repo.findPublished()).length, 1);
  assert.equal((await repo.findActive()).length, 2, 'two non-deleted active');
  assert.ok(p.id);
  db.close();
});

test('W26S-REPO-7. findExpired returns rows with a past expiryDate', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ expiryDate: '2000-01-01' }));            // expired
  await repo.create(mk({ assessmentId: 6, expiryDate: '2999-01-01' })); // future
  await repo.create(mk({ assessmentId: 7 }));                     // no expiry → not expired
  assert.equal((await repo.findExpired()).length, 1);
  db.close();
});

test('W26S-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  const upd = await repo.update(a.id, { assessmentTitle: 'Renamed', assessmentStatus: 'PUBLISHED' });
  assert.equal(upd.assessmentTitle, 'Renamed');
  assert.equal(upd.assessmentStatus, 'PUBLISHED');
  db.close();
});

test('W26S-REPO-9. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  assert.equal((await repo.update(a.id, {})).assessmentCode, 'A1');
  db.close();
});

test('W26S-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
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

test('W26S-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  await repo.softDelete(a.id);
  assert.equal(await repo.exists(a.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26S-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 9, assessmentType: 'QUIZ' }));
  await repo.create(mk({ documentVersionId: 9, assessmentId: 6, assessmentType: 'EXAM' }));
  assert.equal(await repo.count({ documentVersionId: 9, assessmentType: 'QUIZ' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26S-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(a.id, null)).assessmentCode, 'A1');
  db.close();
});

test('W26S-REPO-14. findByVersion / findPublished / findExpired empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByVersion(4242), []);
  assert.deepEqual(await repo.findPublished(), []);
  assert.deepEqual(await repo.findExpired(), []);
  db.close();
});

test('W26S-REPO-15. randomization + limits fields are persisted', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({ randomizeQuestions: 1, randomizeAnswers: 1, maximumAttempts: 3, timeLimitMinutes: 45, questionCount: 25 }));
  assert.equal(a.randomizeQuestions, 1);
  assert.equal(a.randomizeAnswers, 1);
  assert.equal(a.maximumAttempts, 3);
  assert.equal(a.questionCount, 25);
  db.close();
});

test('W26S-REPO-16. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ assessmentStatus: 'DRAFT' }));
  assert.equal(await repo.count({ assessmentStatus: 'RETIRED' }), 0);
  db.close();
});

test('W26S-REPO-17. findActive / findPublished empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findActive(), []);
  assert.deepEqual(await repo.findPublished(), []);
  db.close();
});
