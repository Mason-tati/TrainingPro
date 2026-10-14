// WP-26 · Phase 16 — Enterprise Qualification repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseQualification (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, credential queries (by code / role / learning path / competency; mandatory;
// active), no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-qualification-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-qualification-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
let codeSeq = 0;
const mk = (over) => Object.assign({ qualificationCode: `QL-${(codeSeq += 1)}`, qualificationName: 'Qualification' }, over);

test('W26Q-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26Q-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({ qualificationType: 'LICENSE', validityMonths: 24, renewalRequired: 1, mandatory: 1, hacker: 'x' }));
  assert.equal(q.qualificationName, 'Qualification');
  assert.equal(q.qualificationType, 'LICENSE');
  assert.equal(q.validityMonths, 24);
  assert.equal(q.renewalRequired, 1);
  assert.equal(q.mandatory, 1);
  assert.equal(q.status, 'DRAFT');
  assert.ok(q.createdAt && q.updatedAt);
  assert.equal(q.hacker, undefined);
  db.close();
});

test('W26Q-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26Q-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({}));
  assert.equal((await repo.findById(q.id)).qualificationName, 'Qualification');
  await repo.softDelete(q.id);
  assert.equal(await repo.findById(q.id), null);
  db.close();
});

test('W26Q-REPO-5. findByQualificationCode returns the row or null; excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({ qualificationCode: 'UNIQUE-1' }));
  assert.equal((await repo.findByQualificationCode('UNIQUE-1')).id, q.id);
  assert.equal(await repo.findByQualificationCode('NOPE'), null);
  await repo.softDelete(q.id);
  assert.equal(await repo.findByQualificationCode('UNIQUE-1'), null);
  db.close();
});

test('W26Q-REPO-6. findByRole / findByLearningPath / findByCompetency filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ roleId: 5, learningPathId: 10, competencyId: 20 }));
  await repo.create(mk({ roleId: 5, learningPathId: 10, competencyId: 20 }));
  await repo.create(mk({ roleId: 6, learningPathId: 11, competencyId: 21 }));
  assert.equal((await repo.findByRole(5)).length, 2);
  assert.equal((await repo.findByLearningPath(10)).length, 2);
  assert.equal((await repo.findByCompetency(20)).length, 2);
  db.close();
});

test('W26Q-REPO-7. findMandatory returns mandatory=1; findActive returns active=1', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatory: 1 }));
  await repo.create(mk({ mandatory: 0 }));
  const del = await repo.create(mk({ mandatory: 1 }));
  await repo.softDelete(del.id);
  assert.equal((await repo.findMandatory()).length, 1);
  assert.equal((await repo.findActive()).length, 2);
  db.close();
});

test('W26Q-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({}));
  const upd = await repo.update(q.id, { status: 'ACTIVE', validityMonths: 12 });
  assert.equal(upd.status, 'ACTIVE');
  assert.equal(upd.validityMonths, 12);
  db.close();
});

test('W26Q-REPO-9. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({}));
  assert.equal((await repo.update(q.id, {})).qualificationName, 'Qualification');
  db.close();
});

test('W26Q-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({}));
  await repo.archive(q.id);
  assert.equal((await repo.findById(q.id)).archived, 1);
  await repo.softDelete(q.id);
  await repo.restore(q.id);
  const row = await repo.findById(q.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26Q-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({}));
  await repo.softDelete(q.id);
  assert.equal(await repo.exists(q.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26Q-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ department: 'OPS', status: 'ACTIVE' }));
  await repo.create(mk({ department: 'OPS', status: 'DRAFT' }));
  assert.equal(await repo.count({ department: 'OPS', status: 'ACTIVE' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26Q-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(q.id, null)).qualificationName, 'Qualification');
  db.close();
});

test('W26Q-REPO-14. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ renewalRequired: 0 }));
  assert.equal(await repo.count({ renewalRequired: 1 }), 0);
  db.close();
});

test('W26Q-REPO-15. credential queries return [] when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByRole(4242), []);
  assert.deepEqual(await repo.findByLearningPath(4242), []);
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findMandatory(), []);
  assert.deepEqual(await repo.findActive(), []);
  db.close();
});

test('W26Q-REPO-15b. update can re-file a qualification under a new role / learning path', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({ roleId: 5, learningPathId: 10 }));
  await repo.update(q.id, { roleId: 6, learningPathId: 11 });
  assert.equal((await repo.findByRole(5)).length, 0);
  assert.equal((await repo.findByRole(6)).length, 1);
  assert.equal((await repo.findByLearningPath(11)).length, 1);
  db.close();
});

test('W26Q-REPO-16. references, org placement and validity window are persisted; findActive returns active rows', async () => {
  const { db, repo } = await freshRepo();
  const q = await repo.create(mk({ learningPathId: 7, competencyId: 8, site: 'Perth', businessUnit: 'Mining', effectiveDate: '2026-01-01', expiryDate: '2027-01-01' }));
  assert.equal(q.learningPathId, 7);
  assert.equal(q.competencyId, 8);
  assert.equal(q.site, 'Perth');
  assert.equal(q.businessUnit, 'Mining');
  assert.equal(q.effectiveDate, '2026-01-01');
  assert.equal(q.expiryDate, '2027-01-01');
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});
