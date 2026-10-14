// WP-26 · Phase 8 — Enterprise Document Competency repository tests (ephemeral in-memory DB only).
// Pure persistence over tblEnterpriseDocumentCompetency (reusing BaseRepository): allow-listed
// columns, SQLite-stamped timestamps, requirement/expiry queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-competency-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-competency-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ documentVersionId: 1, competencyId: 5, competencyCode: 'C1', competencyName: 'One' }, over);

test('W26K-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26K-REPO-2. create inserts allow-listed columns and stamps createdAt/updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({ competencyLevel: 'ADVANCED', mandatoryCompetency: 1, hacker: 'x' }));
  assert.equal(c.competencyCode, 'C1');
  assert.equal(c.competencyLevel, 'ADVANCED');
  assert.equal(c.mandatoryCompetency, 1);
  assert.ok(c.createdAt && c.updatedAt);
  assert.equal(c.hacker, undefined);
  db.close();
});

test('W26K-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26K-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  assert.equal((await repo.findById(c.id)).competencyCode, 'C1');
  await repo.softDelete(c.id);
  assert.equal(await repo.findById(c.id), null);
  db.close();
});

test('W26K-REPO-5. findByVersion returns non-deleted rows for a version', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 7 }));
  await repo.create(mk({ documentVersionId: 7, competencyId: 6 }));
  await repo.create(mk({ documentVersionId: 8 }));
  assert.equal((await repo.findByVersion(7)).length, 2);
  db.close();
});

test('W26K-REPO-6. findMandatory returns mandatoryCompetency=1; findActive returns active=1', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatoryCompetency: 1 }));
  await repo.create(mk({ competencyId: 6, mandatoryCompetency: 0 }));
  const del = await repo.create(mk({ competencyId: 7 }));
  await repo.softDelete(del.id);
  assert.equal((await repo.findMandatory()).length, 1);
  assert.equal((await repo.findActive()).length, 2, 'two non-deleted active');
  db.close();
});

test('W26K-REPO-7. findExpired returns rows with a past expiryDate', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ expiryDate: '2000-01-01' }));            // expired
  await repo.create(mk({ competencyId: 6, expiryDate: '2999-01-01' })); // future
  await repo.create(mk({ competencyId: 7 }));                     // no expiry → not expired
  assert.equal((await repo.findExpired()).length, 1);
  db.close();
});

test('W26K-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  const upd = await repo.update(c.id, { competencyName: 'Renamed', competencyLevel: 'EXPERT' });
  assert.equal(upd.competencyName, 'Renamed');
  assert.equal(upd.competencyLevel, 'EXPERT');
  db.close();
});

test('W26K-REPO-9. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  assert.equal((await repo.update(c.id, {})).competencyCode, 'C1');
  db.close();
});

test('W26K-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  await repo.archive(c.id);
  assert.equal((await repo.findById(c.id)).archived, 1);
  await repo.softDelete(c.id);
  await repo.restore(c.id);
  const row = await repo.findById(c.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26K-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  await repo.softDelete(c.id);
  assert.equal(await repo.exists(c.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26K-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ documentVersionId: 9, competencyLevel: 'BASIC' }));
  await repo.create(mk({ documentVersionId: 9, competencyId: 6, competencyLevel: 'EXPERT' }));
  assert.equal(await repo.count({ documentVersionId: 9, competencyLevel: 'BASIC' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26K-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(c.id, null)).competencyCode, 'C1');
  db.close();
});

test('W26K-REPO-14. findByVersion / findMandatory / findExpired empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByVersion(4242), []);
  assert.deepEqual(await repo.findMandatory(), []);
  assert.deepEqual(await repo.findExpired(), []);
  db.close();
});

test('W26K-REPO-15. assessment/training requirement fields are persisted', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({ assessmentRequired: 1, trainingRequired: 1, requiredScore: 85, validationPeriodMonths: 24 }));
  assert.equal(c.assessmentRequired, 1);
  assert.equal(c.trainingRequired, 1);
  assert.equal(c.requiredScore, 85);
  assert.equal(c.validationPeriodMonths, 24);
  db.close();
});
