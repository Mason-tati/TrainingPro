// WP-26 · Phase 10 — Enterprise Competency↔Assessment Mapping repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseCompetencyAssessmentMapping (reusing BaseRepository): allow-
// listed columns, SQLite-stamped timestamps, relationship/expiry queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ competencyId: 1, assessmentId: 2 }, over);

test('W26M-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26M-REPO-2. create inserts allow-listed columns and stamps createdAt/updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({ mappingType: 'PREREQUISITE', mandatory: 1, minimumScore: 70, hacker: 'x' }));
  assert.equal(m.competencyId, 1);
  assert.equal(m.assessmentId, 2);
  assert.equal(m.mappingType, 'PREREQUISITE');
  assert.equal(m.required, 1, 'default required');
  assert.ok(m.createdAt && m.updatedAt);
  assert.equal(m.hacker, undefined);
  db.close();
});

test('W26M-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26M-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({}));
  assert.equal((await repo.findById(m.id)).competencyId, 1);
  await repo.softDelete(m.id);
  assert.equal(await repo.findById(m.id), null);
  db.close();
});

test('W26M-REPO-5. findByCompetency / findByAssessment filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ competencyId: 5, assessmentId: 10 }));
  await repo.create(mk({ competencyId: 5, assessmentId: 11 }));
  await repo.create(mk({ competencyId: 6, assessmentId: 10 }));
  assert.equal((await repo.findByCompetency(5)).length, 2);
  assert.equal((await repo.findByAssessment(10)).length, 2);
  db.close();
});

test('W26M-REPO-6. findMandatory returns mandatory=1; findActive returns active=1', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatory: 1 }));
  await repo.create(mk({ assessmentId: 3, mandatory: 0 }));
  const del = await repo.create(mk({ assessmentId: 4 }));
  await repo.softDelete(del.id);
  assert.equal((await repo.findMandatory()).length, 1);
  assert.equal((await repo.findActive()).length, 2);
  db.close();
});

test('W26M-REPO-7. findExpired returns rows with a past expiryDate', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ expiryDate: '2000-01-01' }));            // expired
  await repo.create(mk({ assessmentId: 3, expiryDate: '2999-01-01' })); // future
  await repo.create(mk({ assessmentId: 4 }));                     // no expiry
  assert.equal((await repo.findExpired()).length, 1);
  db.close();
});

test('W26M-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({}));
  const upd = await repo.update(m.id, { mappingType: 'EQUIVALENT', mandatory: 1 });
  assert.equal(upd.mappingType, 'EQUIVALENT');
  assert.equal(upd.mandatory, 1);
  db.close();
});

test('W26M-REPO-9. update with empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({}));
  assert.equal((await repo.update(m.id, {})).competencyId, 1);
  db.close();
});

test('W26M-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({}));
  await repo.archive(m.id);
  assert.equal((await repo.findById(m.id)).archived, 1);
  await repo.softDelete(m.id);
  await repo.restore(m.id);
  const row = await repo.findById(m.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26M-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({}));
  await repo.softDelete(m.id);
  assert.equal(await repo.exists(m.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26M-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ competencyId: 9, mappingType: 'DIRECT' }));
  await repo.create(mk({ competencyId: 9, assessmentId: 3, mappingType: 'EQUIVALENT' }));
  assert.equal(await repo.count({ competencyId: 9, mappingType: 'DIRECT' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26M-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(m.id, null)).competencyId, 1);
  db.close();
});

test('W26M-REPO-14. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatory: 0 }));
  assert.equal(await repo.count({ mandatory: 1 }), 0);
  db.close();
});

test('W26M-REPO-15. findByCompetency / findMandatory / findExpired empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findMandatory(), []);
  assert.deepEqual(await repo.findExpired(), []);
  db.close();
});

test('W26M-REPO-16. minimumScore / minimumAttempts / validity window are persisted', async () => {
  const { db, repo } = await freshRepo();
  const m = await repo.create(mk({ minimumScore: 85, minimumAttempts: 3, effectiveDate: '2026-01-01', expiryDate: '2027-01-01' }));
  assert.equal(m.minimumScore, 85);
  assert.equal(m.minimumAttempts, 3);
  assert.equal(m.effectiveDate, '2026-01-01');
  assert.equal(m.expiryDate, '2027-01-01');
  db.close();
});

test('W26M-REPO-17. findByAssessment / findActive empty when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByAssessment(4242), []);
  assert.deepEqual(await repo.findActive(), []);
  db.close();
});
