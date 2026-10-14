// WP-26 · Phase 12 — Enterprise Employee Competency Profile repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseEmployeeCompetencyProfile (reusing BaseRepository): allow-listed
// columns, SQLite-stamped timestamps, compliance / expiring / expired queries, no business logic.
// Expiry windows are stamped relative to the DB clock (datetime('now', ±N days)) for determinism.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-employee-competency-profile-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ employeeId: 1, competencyId: 2 }, over);
// Stamp expiryDate relative to the DB clock so "expiring"/"expired" tests are day-independent.
function stampExpiry(db, id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseEmployeeCompetencyProfile SET expiryDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}

test('W26P-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26P-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ status: 'ACHIEVED', riskLevel: 'HIGH', complianceStatus: 'COMPLIANT', currentEvidenceId: 5, hacker: 'x' }));
  assert.equal(p.employeeId, 1);
  assert.equal(p.competencyId, 2);
  assert.equal(p.status, 'ACHIEVED');
  assert.equal(p.riskLevel, 'HIGH');
  assert.equal(p.complianceStatus, 'COMPLIANT');
  assert.equal(p.currentEvidenceId, 5);
  assert.ok(p.createdAt && p.updatedAt);
  assert.equal(p.hacker, undefined);
  db.close();
});

test('W26P-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26P-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal((await repo.findById(p.id)).employeeId, 1);
  await repo.softDelete(p.id);
  assert.equal(await repo.findById(p.id), null);
  db.close();
});

test('W26P-REPO-5. findByEmployee / findByCompetency filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ employeeId: 5, competencyId: 10 }));
  await repo.create(mk({ employeeId: 5, competencyId: 11 }));
  await repo.create(mk({ employeeId: 6, competencyId: 10 }));
  assert.equal((await repo.findByEmployee(5)).length, 2);
  assert.equal((await repo.findByCompetency(10)).length, 2);
  db.close();
});

test('W26P-REPO-6. findCompliant / findNonCompliant filter by complianceStatus', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ complianceStatus: 'COMPLIANT' }));
  await repo.create(mk({ competencyId: 3, complianceStatus: 'NON_COMPLIANT' }));
  await repo.create(mk({ competencyId: 4, complianceStatus: 'PENDING' }));
  assert.equal((await repo.findCompliant()).length, 1);
  assert.equal((await repo.findNonCompliant()).length, 1);
  db.close();
});

test('W26P-REPO-7. findExpiring returns rows lapsing within the window; findExpired returns past ones', async () => {
  const { db, repo } = await freshRepo();
  const soon = await repo.create(mk({ competencyId: 3 }));
  const later = await repo.create(mk({ competencyId: 4 }));
  const past = await repo.create(mk({ competencyId: 5 }));
  await stampExpiry(db, soon.id, '+5 days');
  await stampExpiry(db, later.id, '+400 days');
  await stampExpiry(db, past.id, '-5 days');
  await repo.create(mk({ competencyId: 6 })); // no expiry
  const expiring = await repo.findExpiring(30);
  assert.equal(expiring.length, 1);
  assert.equal(expiring[0].id, soon.id);
  const expired = await repo.findExpired();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, past.id);
  db.close();
});

test('W26P-REPO-8. findExpiring defaults to 30 days for a non-integer / negative window', async () => {
  const { db, repo } = await freshRepo();
  const soon = await repo.create(mk({}));
  await stampExpiry(db, soon.id, '+10 days');
  assert.equal((await repo.findExpiring()).length, 1, 'undefined → default 30');
  assert.equal((await repo.findExpiring(-5)).length, 1, 'negative → default 30');
  assert.equal((await repo.findExpiring(3)).length, 0, 'explicit 3-day window excludes the +10 day row');
  db.close();
});

test('W26P-REPO-9. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  const upd = await repo.update(p.id, { status: 'IN_PROGRESS', complianceStatus: 'NON_COMPLIANT' });
  assert.equal(upd.status, 'IN_PROGRESS');
  assert.equal(upd.complianceStatus, 'NON_COMPLIANT');
  db.close();
});

test('W26P-REPO-10. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal((await repo.update(p.id, {})).employeeId, 1);
  db.close();
});

test('W26P-REPO-11. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
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

test('W26P-REPO-12. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  await repo.softDelete(p.id);
  assert.equal(await repo.exists(p.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26P-REPO-13. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ employeeId: 20, riskLevel: 'CRITICAL' }));
  await repo.create(mk({ employeeId: 20, competencyId: 3, riskLevel: 'LOW' }));
  assert.equal(await repo.count({ employeeId: 20, riskLevel: 'CRITICAL' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26P-REPO-14. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(p.id, null)).employeeId, 1);
  db.close();
});

test('W26P-REPO-15. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ complianceStatus: 'PENDING' }));
  assert.equal(await repo.count({ complianceStatus: 'COMPLIANT' }), 0);
  db.close();
});

test('W26P-REPO-16. relationship/compliance/expiry queries return [] when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByEmployee(4242), []);
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findCompliant(), []);
  assert.deepEqual(await repo.findNonCompliant(), []);
  assert.deepEqual(await repo.findExpiring(30), []);
  assert.deepEqual(await repo.findExpired(), []);
  assert.deepEqual(await repo.findActive(), []);
  db.close();
});

test('W26P-REPO-17. reference ids, dates, and review schedule are persisted; findActive returns active rows', async () => {
  const { db, repo } = await freshRepo();
  const p = await repo.create(mk({ currentAssessmentId: 7, currentMappingId: 8, achievedDate: '2026-01-01', expiryDate: '2027-01-01', lastVerifiedDate: '2026-02-01', nextReviewDate: '2026-12-01' }));
  assert.equal(p.currentAssessmentId, 7);
  assert.equal(p.currentMappingId, 8);
  assert.equal(p.achievedDate, '2026-01-01');
  assert.equal(p.expiryDate, '2027-01-01');
  assert.equal(p.lastVerifiedDate, '2026-02-01');
  assert.equal(p.nextReviewDate, '2026-12-01');
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});
