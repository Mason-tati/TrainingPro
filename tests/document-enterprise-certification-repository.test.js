// WP-26 · Phase 17 — Enterprise Certification repository tests (ephemeral DB only).
// Pure persistence over tblEnterpriseCertification (reusing BaseRepository): allow-listed columns,
// SQLite-stamped timestamps, certification queries (by code / qualification / learning path / competency
// / role; active), no business logic.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-certification-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-certification-repository.js'));

async function freshRepo() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: new Repository(db) };
}
let codeSeq = 0;
const mk = (over) => Object.assign({ certificationCode: `CT-${(codeSeq += 1)}`, certificationName: 'Certification' }, over);

test('W26C-REPO-1. constructor rejects a non-sqlite connection', () => {
  assert.throws(() => new Repository({}), /injected sqlite3 database connection/);
});

test('W26C-REPO-2. create inserts allow-listed columns, stamps timestamps, strips unknown keys', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({ issuingAuthority: 'WorkSafe', renewalRequired: 1, issueDate: '2026-01-01', hacker: 'x' }));
  assert.equal(c.certificationName, 'Certification');
  assert.equal(c.issuingAuthority, 'WorkSafe');
  assert.equal(c.renewalRequired, 1);
  assert.equal(c.issueDate, '2026-01-01');
  assert.equal(c.status, 'DRAFT');
  assert.ok(c.createdAt && c.updatedAt);
  assert.equal(c.hacker, undefined);
  db.close();
});

test('W26C-REPO-3. create with non-object data hits the DB NOT NULL constraint', async () => {
  const { db, repo } = await freshRepo();
  await assert.rejects(() => repo.create(null), /NOT NULL constraint failed/);
  db.close();
});

test('W26C-REPO-4. findById excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  assert.equal((await repo.findById(c.id)).certificationName, 'Certification');
  await repo.softDelete(c.id);
  assert.equal(await repo.findById(c.id), null);
  db.close();
});

test('W26C-REPO-5. findByCertificationCode returns the row or null; excludes soft-deleted', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({ certificationCode: 'UNIQUE-1' }));
  assert.equal((await repo.findByCertificationCode('UNIQUE-1')).id, c.id);
  assert.equal(await repo.findByCertificationCode('NOPE'), null);
  await repo.softDelete(c.id);
  assert.equal(await repo.findByCertificationCode('UNIQUE-1'), null);
  db.close();
});

test('W26C-REPO-6. findByQualification / findByLearningPath / findByCompetency / findByRole filter and exclude deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ qualificationId: 5, learningPathId: 10, competencyId: 20, roleId: 30 }));
  await repo.create(mk({ qualificationId: 5, learningPathId: 10, competencyId: 20, roleId: 30 }));
  await repo.create(mk({ qualificationId: 6, learningPathId: 11, competencyId: 21, roleId: 31 }));
  assert.equal((await repo.findByQualification(5)).length, 2);
  assert.equal((await repo.findByLearningPath(10)).length, 2);
  assert.equal((await repo.findByCompetency(20)).length, 2);
  assert.equal((await repo.findByRole(30)).length, 2);
  db.close();
});

test('W26C-REPO-7. findActive returns active=1 and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({}));
  const del = await repo.create(mk({}));
  await repo.softDelete(del.id);
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});

test('W26C-REPO-8. update changes allow-listed columns; refreshes updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  const upd = await repo.update(c.id, { status: 'ACTIVE', issuingAuthority: 'RTO-123' });
  assert.equal(upd.status, 'ACTIVE');
  assert.equal(upd.issuingAuthority, 'RTO-123');
  db.close();
});

test('W26C-REPO-9. update empty patch refreshes only updatedAt', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  assert.equal((await repo.update(c.id, {})).certificationName, 'Certification');
  db.close();
});

test('W26C-REPO-10. archive sets archived=1; restore clears deleted/archived and reactivates', async () => {
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

test('W26C-REPO-11. softDelete deactivates; exists ignores deleted flag', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  await repo.softDelete(c.id);
  assert.equal(await repo.exists(c.id), true);
  assert.equal(await repo.exists(999), false);
  db.close();
});

test('W26C-REPO-12. count respects filters and excludes deleted', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ issuingAuthority: 'A', status: 'ACTIVE' }));
  await repo.create(mk({ issuingAuthority: 'A', status: 'DRAFT' }));
  assert.equal(await repo.count({ issuingAuthority: 'A', status: 'ACTIVE' }), 1);
  assert.equal(await repo.count(), 2);
  db.close();
});

test('W26C-REPO-13. non-object filters/patch (primitive/array) are treated as empty', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({}));
  assert.equal(await repo.count('nope'), 1);
  assert.equal(await repo.count([]), 1);
  assert.equal((await repo.update(c.id, null)).certificationName, 'Certification');
  db.close();
});

test('W26C-REPO-14. count with a filter matching nothing returns 0', async () => {
  const { db, repo } = await freshRepo();
  await repo.create(mk({ renewalRequired: 0 }));
  assert.equal(await repo.count({ renewalRequired: 1 }), 0);
  db.close();
});

test('W26C-REPO-15. certification queries return [] when nothing matches; update can re-file references', async () => {
  const { db, repo } = await freshRepo();
  assert.deepEqual(await repo.findByQualification(4242), []);
  assert.deepEqual(await repo.findByLearningPath(4242), []);
  assert.deepEqual(await repo.findByCompetency(4242), []);
  assert.deepEqual(await repo.findByRole(4242), []);
  assert.deepEqual(await repo.findActive(), []);
  const c = await repo.create(mk({ qualificationId: 5, roleId: 30 }));
  await repo.update(c.id, { qualificationId: 6, roleId: 31 });
  assert.equal((await repo.findByQualification(5)).length, 0);
  assert.equal((await repo.findByRole(31)).length, 1);
  db.close();
});

test('W26C-REPO-16. references, authority and issue/expiry dates are persisted; findActive returns active rows', async () => {
  const { db, repo } = await freshRepo();
  const c = await repo.create(mk({ qualificationId: 7, learningPathId: 8, competencyId: 9, issuingAuthority: 'WorkSafe', issueDate: '2026-01-01', expiryDate: '2027-01-01' }));
  assert.equal(c.qualificationId, 7);
  assert.equal(c.learningPathId, 8);
  assert.equal(c.competencyId, 9);
  assert.equal(c.issuingAuthority, 'WorkSafe');
  assert.equal(c.issueDate, '2026-01-01');
  assert.equal(c.expiryDate, '2027-01-01');
  assert.equal((await repo.findActive()).length, 1);
  db.close();
});
