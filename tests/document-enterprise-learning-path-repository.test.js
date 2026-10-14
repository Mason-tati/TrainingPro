// WP-26 · Phase 15 — Enterprise Learning Path repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseLearningPath (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, curriculum queries (by code / role / program / competency; mandatory;
// active) ordered by sequenceNumber, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-learning-path-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-learning-path-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
let codeSeq = 0;
const mk = (over) => Object.assign({ pathCode: `LP-${(codeSeq += 1)}`, pathName: 'Path' }, over);

test('W26L-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26L-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ roleId: 3, trainingProgramId: 7, sequenceNumber: 2, estimatedHours: 5.5, mandatory: 1, hacker: 'x' }));
  assert.equal(p.pathName, 'Path');
  assert.equal(p.roleId, 3);
  assert.equal(p.trainingProgramId, 7);
  assert.equal(p.sequenceNumber, 2);
  assert.equal(p.estimatedHours, 5.5);
  assert.equal(p.mandatory, 1);
  assert.equal(p.status, 'DRAFT');
  assert.ok(p.createdAt && p.updatedAt);
  assert.equal(p.hacker, undefined);
  db.close();
});

test('W26L-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26L-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal((await repo.findById(p.id)).pathName, 'Path');
  await repo.softDelete(p.id);
  assert.equal(await repo.findById(p.id), null);
  db.close();
});

test('W26L-REPO-5. findByPathCode returns the row or null; excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ pathCode: 'UNIQUE-1' }));
  assert.equal((await repo.findByPathCode('UNIQUE-1')).id, p.id);
  assert.equal(await repo.findByPathCode('NOPE'), null);
  await repo.softDelete(p.id);
  assert.equal(await repo.findByPathCode('UNIQUE-1'), null);
  db.close();
});

test('W26L-REPO-6. findByRole / findByTrainingProgram / findByCompetency filter, exclude deleted, order by sequence', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ roleId: 5, trainingProgramId: 10, competencyId: 20, sequenceNumber: 2 }));
  await repo.create(mk({ roleId: 5, trainingProgramId: 10, competencyId: 20, sequenceNumber: 1 }));
  await repo.create(mk({ roleId: 6, trainingProgramId: 11, competencyId: 21 }));
  const byRole = await repo.findByRole(5);
  assert.equal(byRole.length, 2);
  assert.equal(byRole[0].sequenceNumber, 1, 'ordered by sequenceNumber');
  assert.equal((await repo.findByTrainingProgram(10)).length, 2);
  assert.equal((await repo.findByCompetency(20)).length, 2);
  db.close();
});

test('W26L-REPO-7. findMandatory returns mandatory=1; findActive returns active=1', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatory: 1 }));
  await repo.create(mk({ mandatory: 0 }));
  const del = await repo.create(mk({ mandatory: 1 }));
  await repo.softDelete(del.id);
  assert.equal((await repo.findMandatory()).length, 1);
  assert.equal((await repo.findActive()).length, 2);
  db.close();
});

test('W26L-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  const upd = await repo.update(p.id, { status: 'ACTIVE', sequenceNumber: 9 });
  assert.equal(upd.status, 'ACTIVE');
  assert.equal(upd.sequenceNumber, 9);
  db.close();
});

test('W26L-REPO-9. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal((await repo.update(p.id, {})).pathName, 'Path');
  db.close();
});

test('W26L-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  await repo.archive(p.id);
  assert.equal((await repo.findById(p.id)).archived, 1);
  await repo.softDelete(p.id);
  await repo.restore(p.id);
  const row = await repo.findById(p.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26L-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  await repo.softDelete(p.id);
  assert.equal(await repo.exists(p.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26L-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ department: 'OPS', status: 'ACTIVE' }));
  await repo.create(mk({ department: 'OPS', status: 'DRAFT' }));
  assert.equal(await repo.count({ department: 'OPS', status: 'ACTIVE' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26L-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(p.id, null)).pathName, 'Path');
  db.close();
});

test('W26L-REPO-14. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatory: 0 }));
  assert.equal(await repo.count({ mandatory: 1 }), 0);
  db.close();
});

test('W26L-REPO-15. curriculum queries return [] when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByRole(4242), []);
  assert.deepEqual(await repo.findByTrainingProgram(4242), []);
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findMandatory(), []);
  assert.deepEqual(await repo.findActive(), []);
  db.close();
});

test('W26L-REPO-16. prerequisite link, org placement and validity window are persisted; findActive returns active rows', async () => {
  const { db, repo } = await freshRepo();
  const a = await repo.create(mk({}));
  const b = await repo.create(mk({ prerequisitePathId: a.id, site: 'Perth', businessUnit: 'Mining', effectiveDate: '2026-01-01', expiryDate: '2027-01-01' }));
  assert.equal(b.prerequisitePathId, a.id);
  assert.equal(b.site, 'Perth');
  assert.equal(b.businessUnit, 'Mining');
  assert.equal(b.effectiveDate, '2026-01-01');
  assert.equal(b.expiryDate, '2027-01-01');
  assert.equal((await repo.findActive()).length, 2);
  db.close();
});
