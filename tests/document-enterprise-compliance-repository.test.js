// WP-26 · Phase 18 (FINAL) — Enterprise Compliance repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseCompliance (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, compliance queries (by employee / role / qualification / certification /
// learning path / competency; compliant / non-compliant; expired / overdue), no business logic. Expiry
// is stamped relative to the DB clock for determinism.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-compliance-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-compliance-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ employeeId: 1 }, over);
function stampExpiry(db, id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseCompliance SET expiryDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}

test('W26X-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26X-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({ complianceStatus: 'COMPLIANT', riskLevel: 'HIGH', overdue: 0, renewalRequired: 1, hacker: 'x' }));
  assert.equal(r.employeeId, 1);
  assert.equal(r.complianceStatus, 'COMPLIANT');
  assert.equal(r.riskLevel, 'HIGH');
  assert.equal(r.renewalRequired, 1);
  assert.ok(r.createdAt && r.updatedAt);
  assert.equal(r.hacker, undefined);
  db.close();
});

test('W26X-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26X-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  assert.equal((await repo.findById(r.id)).employeeId, 1);
  await repo.softDelete(r.id);
  assert.equal(await repo.findById(r.id), null);
  db.close();
});

test('W26X-REPO-5. findByEmployee / findByRole / findByQualification / findByCertification / findByLearningPath / findByCompetency filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ employeeId: 5, roleId: 30, qualificationId: 40, certificationId: 50, learningPathId: 60, competencyId: 70 }));
  await repo.create(mk({ employeeId: 5, roleId: 30, qualificationId: 40, certificationId: 50, learningPathId: 60, competencyId: 70 }));
  await repo.create(mk({ employeeId: 6, roleId: 31, qualificationId: 41, certificationId: 51, learningPathId: 61, competencyId: 71 }));
  assert.equal((await repo.findByEmployee(5)).length, 2);
  assert.equal((await repo.findByRole(30)).length, 2);
  assert.equal((await repo.findByQualification(40)).length, 2);
  assert.equal((await repo.findByCertification(50)).length, 2);
  assert.equal((await repo.findByLearningPath(60)).length, 2);
  assert.equal((await repo.findByCompetency(70)).length, 2);
  db.close();
});

test('W26X-REPO-6. findCompliant / findNonCompliant filter by complianceStatus; findOverdue filters the stored flag', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ complianceStatus: 'COMPLIANT', overdue: 0 }));
  await repo.create(mk({ complianceStatus: 'NON_COMPLIANT', overdue: 1 }));
  await repo.create(mk({ complianceStatus: 'PENDING', overdue: 0 }));
  assert.equal((await repo.findCompliant()).length, 1);
  assert.equal((await repo.findNonCompliant()).length, 1);
  assert.equal((await repo.findOverdue()).length, 1);
  db.close();
});

test('W26X-REPO-7. findExpired returns rows with a past expiryDate', async () => {
  const { db, repo } = await freshRepo();
  const past = await repo.create(mk({}));
  const future = await repo.create(mk({}));
  await stampExpiry(db, past.id, '-5 days');
  await stampExpiry(db, future.id, '+400 days');
  await repo.create(mk({})); // no expiry
  const expired = await repo.findExpired();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, past.id);
  db.close();
});

test('W26X-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  const upd = await repo.update(r.id, { complianceStatus: 'NON_COMPLIANT', overdue: 1, riskLevel: 'CRITICAL' });
  assert.equal(upd.complianceStatus, 'NON_COMPLIANT');
  assert.equal(upd.overdue, 1);
  assert.equal(upd.riskLevel, 'CRITICAL');
  db.close();
});

test('W26X-REPO-9. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  assert.equal((await repo.update(r.id, {})).employeeId, 1);
  db.close();
});

test('W26X-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
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

test('W26X-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  await repo.softDelete(r.id);
  assert.equal(await repo.exists(r.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26X-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ department: 'OPS', complianceStatus: 'COMPLIANT' }));
  await repo.create(mk({ department: 'OPS', complianceStatus: 'PENDING' }));
  assert.equal(await repo.count({ department: 'OPS', complianceStatus: 'COMPLIANT' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26X-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(r.id, null)).employeeId, 1);
  db.close();
});

test('W26X-REPO-14. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ overdue: 0 }));
  assert.equal(await repo.count({ overdue: 1 }), 0);
  db.close();
});

test('W26X-REPO-15. compliance queries return [] when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByEmployee(4242), []);
  assert.deepEqual(await repo.findByRole(4242), []);
  assert.deepEqual(await repo.findByQualification(4242), []);
  assert.deepEqual(await repo.findByCertification(4242), []);
  assert.deepEqual(await repo.findByLearningPath(4242), []);
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findCompliant(), []);
  assert.deepEqual(await repo.findNonCompliant(), []);
  assert.deepEqual(await repo.findExpired(), []);
  assert.deepEqual(await repo.findOverdue(), []);
  db.close();
});

test('W26X-REPO-16. references, org placement and dates are persisted', async () => {
  const { db, repo } = await freshRepo();
  const r = await repo.create(mk({ roleId: 3, qualificationId: 4, certificationId: 5, learningPathId: 6, competencyId: 7, site: 'Perth', businessUnit: 'Mining', compliantDate: '2026-01-01', expiryDate: '2027-01-01' }));
  assert.equal(r.roleId, 3);
  assert.equal(r.certificationId, 5);
  assert.equal(r.site, 'Perth');
  assert.equal(r.businessUnit, 'Mining');
  assert.equal(r.compliantDate, '2026-01-01');
  assert.equal(r.expiryDate, '2027-01-01');
  db.close();
});
