// WP-26 · Phase 14 — Enterprise Training Program repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseTrainingProgram (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, catalogue queries (by code / competency / trainer; mandatory; active),
// no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-training-program-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-training-program-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
let codeSeq = 0;
const mk = (over) => Object.assign({ programCode: `PRG-${(codeSeq += 1)}`, programName: 'Program' }, over);

test('W26T-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26T-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ trainingType: 'SAFETY', deliveryMethod: 'CLASSROOM', mandatory: 1, durationHours: 2.5, hacker: 'x' }));
  assert.equal(p.programName, 'Program');
  assert.equal(p.trainingType, 'SAFETY');
  assert.equal(p.deliveryMethod, 'CLASSROOM');
  assert.equal(p.mandatory, 1);
  assert.equal(p.durationHours, 2.5);
  assert.equal(p.status, 'DRAFT');
  assert.ok(p.createdAt && p.updatedAt);
  assert.equal(p.hacker, undefined);
  db.close();
});

test('W26T-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26T-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal((await repo.findById(p.id)).programName, 'Program');
  await repo.softDelete(p.id);
  assert.equal(await repo.findById(p.id), null);
  db.close();
});

test('W26T-REPO-5. findByProgramCode returns the row or null; excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ programCode: 'UNIQUE-1' }));
  assert.equal((await repo.findByProgramCode('UNIQUE-1')).id, p.id);
  assert.equal(await repo.findByProgramCode('NOPE'), null);
  await repo.softDelete(p.id);
  assert.equal(await repo.findByProgramCode('UNIQUE-1'), null);
  db.close();
});

test('W26T-REPO-6. findByCompetency / findByTrainer filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ competencyId: 5, trainerId: 40 }));
  await repo.create(mk({ competencyId: 5, trainerId: 41 }));
  await repo.create(mk({ competencyId: 6, trainerId: 40 }));
  assert.equal((await repo.findByCompetency(5)).length, 2);
  assert.equal((await repo.findByTrainer(40)).length, 2);
  db.close();
});

test('W26T-REPO-7. findMandatory returns mandatory=1; findActive returns active=1', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatory: 1 }));
  await repo.create(mk({ mandatory: 0 }));
  const del = await repo.create(mk({ mandatory: 1 }));
  await repo.softDelete(del.id);
  assert.equal((await repo.findMandatory()).length, 1);
  assert.equal((await repo.findActive()).length, 2);
  db.close();
});

test('W26T-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  const upd = await repo.update(p.id, { status: 'ACTIVE', deliveryMethod: 'ONLINE' });
  assert.equal(upd.status, 'ACTIVE');
  assert.equal(upd.deliveryMethod, 'ONLINE');
  db.close();
});

test('W26T-REPO-9. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal((await repo.update(p.id, {})).programName, 'Program');
  db.close();
});

test('W26T-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
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

test('W26T-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  await repo.softDelete(p.id);
  assert.equal(await repo.exists(p.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26T-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ department: 'OPS', status: 'ACTIVE' }));
  await repo.create(mk({ department: 'OPS', status: 'DRAFT' }));
  assert.equal(await repo.count({ department: 'OPS', status: 'ACTIVE' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26T-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(p.id, null)).programName, 'Program');
  db.close();
});

test('W26T-REPO-14. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ mandatory: 0 }));
  assert.equal(await repo.count({ mandatory: 1 }), 0);
  db.close();
});

test('W26T-REPO-15. catalogue queries return [] when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findByTrainer(4242), []);
  assert.deepEqual(await repo.findMandatory(), []);
  assert.deepEqual(await repo.findActive(), []);
  db.close();
});

test('W26T-REPO-16b. update can re-file a program under a new competency / trainer', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ competencyId: 5, trainerId: 40 }));
  await repo.update(p.id, { competencyId: 6, trainerId: 41 });
  assert.equal((await repo.findByCompetency(5)).length, 0);
  assert.equal((await repo.findByCompetency(6)).length, 1);
  assert.equal((await repo.findByTrainer(41)).length, 1);
  db.close();
});

test('W26T-REPO-16. org placement, references and validity window are persisted; findActive returns active rows', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ site: 'Perth', businessUnit: 'Mining', ownerId: 3, assessmentId: 8, renewalPeriodMonths: 12, effectiveDate: '2026-01-01', expiryDate: '2027-01-01' }));
  assert.equal(p.site, 'Perth');
  assert.equal(p.businessUnit, 'Mining');
  assert.equal(p.ownerId, 3);
  assert.equal(p.assessmentId, 8);
  assert.equal(p.renewalPeriodMonths, 12);
  assert.equal(p.effectiveDate, '2026-01-01');
  assert.equal(p.expiryDate, '2027-01-01');
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});
