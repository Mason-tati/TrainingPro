// WP-26 · Phase 11 — Enterprise Competency Evidence repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseCompetencyEvidence (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, the verifiedDate boolean sentinel, relationship / verification / expiry
// queries, no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-competency-evidence-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-competency-evidence-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
const mk = (over) => Object.assign({ competencyId: 1, assessmentId: 2, mappingId: 3, employeeId: 4, evidenceTitle: 'T', verificationStatus: 'PENDING' }, over);

test('W26E-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26E-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({ evidenceType: 'CERTIFICATE', verifiedBy: 9, hacker: 'x' }));
  assert.equal(e.competencyId, 1);
  assert.equal(e.assessmentId, 2);
  assert.equal(e.mappingId, 3);
  assert.equal(e.employeeId, 4);
  assert.equal(e.evidenceType, 'CERTIFICATE');
  assert.equal(e.verificationStatus, 'PENDING');
  assert.ok(e.createdAt && e.updatedAt);
  assert.equal(e.hacker, undefined);
  db.close();
});

test('W26E-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26E-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({}));
  assert.equal((await repo.findById(e.id)).employeeId, 4);
  await repo.softDelete(e.id);
  assert.equal(await repo.findById(e.id), null);
  db.close();
});

test('W26E-REPO-5. findByEmployee / findByCompetency / findByAssessment filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ employeeId: 7, competencyId: 50, assessmentId: 60 }));
  await repo.create(mk({ employeeId: 7, competencyId: 50, assessmentId: 61 }));
  await repo.create(mk({ employeeId: 8, competencyId: 51, assessmentId: 60 }));
  assert.equal((await repo.findByEmployee(7)).length, 2);
  assert.equal((await repo.findByCompetency(50)).length, 2);
  assert.equal((await repo.findByAssessment(60)).length, 2);
  db.close();
});

test('W26E-REPO-6. findPendingVerification / findVerified filter by verificationStatus', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ verificationStatus: 'PENDING' }));
  await repo.create(mk({ assessmentId: 3, verificationStatus: 'VERIFIED' }));
  await repo.create(mk({ assessmentId: 4, verificationStatus: 'REJECTED' }));
  assert.equal((await repo.findPendingVerification()).length, 1);
  assert.equal((await repo.findVerified()).length, 1);
  db.close();
});

test('W26E-REPO-7. findExpired returns rows with a past expiryDate', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ expiryDate: '2000-01-01' }));                  // expired
  await repo.create(mk({ assessmentId: 3, expiryDate: '2999-01-01' })); // future
  await repo.create(mk({ assessmentId: 4 }));                          // no expiry
  assert.equal((await repo.findExpired()).length, 1);
  db.close();
});

test('W26E-REPO-8. update changes allow-listed columns; refreshes updatedAt (verifiedDate untouched)', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({}));
  const upd = await repo.update(e.id, { evidenceType: 'OBSERVATION', evidenceTitle: 'New' });
  assert.equal(upd.evidenceType, 'OBSERVATION');
  assert.equal(upd.evidenceTitle, 'New');
  assert.equal(upd.verifiedDate, null);
  db.close();
});

test('W26E-REPO-9. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({}));
  assert.equal((await repo.update(e.id, {})).employeeId, 4);
  db.close();
});

test('W26E-REPO-10. verifiedDate boolean sentinel stamps now; an explicit string sets the value', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({}));
  const stamped = await repo.update(e.id, { verificationStatus: 'VERIFIED', verifiedBy: 9, verifiedDate: true });
  assert.equal(stamped.verificationStatus, 'VERIFIED');
  assert.equal(stamped.verifiedBy, 9);
  assert.match(stamped.verifiedDate, /^\d{4}-\d{2}-\d{2} /);
  const explicit = await repo.update(e.id, { verifiedDate: '2026-01-01' });
  assert.equal(explicit.verifiedDate, '2026-01-01');
  db.close();
});

test('W26E-REPO-11. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({}));
  await repo.archive(e.id);
  assert.equal((await repo.findById(e.id)).archived, 1);
  await repo.softDelete(e.id);
  await repo.restore(e.id);
  const row = await repo.findById(e.id);
  assert.equal(row.deleted, 0);
  assert.equal(row.archived, 0);
  assert.equal(row.active, 1);
  db.close();
});

test('W26E-REPO-12. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({}));
  await repo.softDelete(e.id);
  assert.equal(await repo.exists(e.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26E-REPO-13. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ employeeId: 20, verificationStatus: 'PENDING' }));
  await repo.create(mk({ employeeId: 20, assessmentId: 3, verificationStatus: 'VERIFIED' }));
  assert.equal(await repo.count({ employeeId: 20, verificationStatus: 'PENDING' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26E-REPO-14. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(e.id, null)).employeeId, 4);
  db.close();
});

test('W26E-REPO-15. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ verificationStatus: 'PENDING' }));
  assert.equal(await repo.count({ verificationStatus: 'VERIFIED' }), 0);
  db.close();
});

test('W26E-REPO-16. relationship/verification/expiry queries return [] when nothing matches', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByEmployee(4242), []);
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findByAssessment(4242), []);
  assert.deepEqual(await repo.findPendingVerification(), []);
  assert.deepEqual(await repo.findVerified(), []);
  assert.deepEqual(await repo.findExpired(), []);
  assert.deepEqual(await repo.findActive(), []);
  db.close();
});

test('W26E-REPO-17. evidence fields and validity window are persisted; findActive returns active rows', async () => {
  const { db, repo } = await freshRepo();
  const e = await repo.create(mk({ evidenceReference: 'CERT-001', evidenceDescription: 'desc', effectiveDate: '2026-01-01', expiryDate: '2027-01-01' }));
  assert.equal(e.evidenceReference, 'CERT-001');
  assert.equal(e.evidenceDescription, 'desc');
  assert.equal(e.effectiveDate, '2026-01-01');
  assert.equal(e.expiryDate, '2027-01-01');
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});
