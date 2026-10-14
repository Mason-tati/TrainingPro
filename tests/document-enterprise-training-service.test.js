// WP-26 · Phase 7 — Enterprise Document Training service tests (business rules; ephemeral DB).
// Covers version existence (via injected version repo), assignment/competency/assessment/score
// validation, completion workflow (assessment gate + attempts), overdue, completion calculation,
// and never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const TMig = require(path.join(EDIR, 'enterprise-document-training-migration.js'));
const TRepo = require(path.join(EDIR, 'enterprise-document-training-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-training-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findPending', 'findCompleted', 'findOverdue', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await TMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'DOC-1', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const svc = new Service(new TRepo(db), verRepo);
  return { db, svc, verId: ver.version.id };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return { id: 1 }; } });
}

// ---- construction ----

test('W26T-SVC-1. constructor validates the training repo AND requires a version repository', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  assert.throws(() => new Service({}, { findById() {} }), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}), /requires an injected version repository/);
  assert.throws(() => new Service(goodRepo, null), /requires an injected version repository/);
});

// ---- create: validation ----

test('W26T-SVC-2. createTraining requires an existing version and a user', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createTraining(null)).code, 'VALIDATION');
  assert.equal((await svc.createTraining({ userId: 1 })).code, 'VALIDATION', 'missing versionId (undefined)');
  assert.equal((await svc.createTraining({ documentVersionId: null, userId: 1 })).code, 'VALIDATION', 'null versionId');
  assert.equal((await svc.createTraining({ documentVersionId: 9999, userId: 1 })).code, 'VALIDATION', 'unknown version');
  assert.equal((await svc.createTraining({ documentVersionId: verId })).code, 'VALIDATION', 'missing userId');
  assert.equal((await svc.createTraining({ documentVersionId: verId, userId: 0 })).code, 'VALIDATION', 'invalid userId');
  db.close();
});

test('W26T-SVC-3. competency-linkage validation (provided invalid → error; null/absent allowed)', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createTraining({ documentVersionId: verId, userId: 1, competencyId: 0 })).code, 'VALIDATION');
  assert.equal((await svc.createTraining({ documentVersionId: verId, userId: 1, competencyId: null })).ok, true, 'null competency allowed');
  assert.equal((await svc.createTraining({ documentVersionId: verId, userId: 2, competencyId: 9 })).ok, true, 'valid competency');
  db.close();
});

test('W26T-SVC-4. create validates status / mandatory / assessmentRequired / score / metadata', async () => {
  const { db, svc, verId } = await freshService();
  const base = { documentVersionId: verId, userId: 1 };
  assert.equal((await svc.createTraining({ ...base, trainingStatus: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.createTraining({ ...base, mandatoryTraining: 2 })).code, 'VALIDATION');
  assert.equal((await svc.createTraining({ ...base, assessmentRequired: 5 })).code, 'VALIDATION');
  assert.equal((await svc.createTraining({ ...base, score: 150 })).code, 'VALIDATION');
  assert.equal((await svc.createTraining({ ...base, metadata: 'no' })).code, 'VALIDATION');
  db.close();
});

test('W26T-SVC-5. create (minimal) defaults; (full) persists + parses metadata', async () => {
  const { db, svc, verId } = await freshService();
  const min = (await svc.createTraining({ documentVersionId: verId, userId: 1 })).training;
  assert.equal(min.trainingStatus, 'ASSIGNED');
  assert.equal(min.mandatoryTraining, 0);
  assert.equal(min.assessmentRequired, 0);
  assert.equal(min.attempts, 0);
  assert.equal(min.metadata, null);
  const full = (await svc.createTraining({
    documentVersionId: verId, userId: 2, trainingProgramId: 3, courseId: 4, competencyId: 5, dueDate: '2026-06-01',
    trainingStatus: 'IN_PROGRESS', mandatoryTraining: 1, assessmentRequired: 1, score: 80, metadata: { a: 1 },
  })).training;
  assert.equal(full.trainingProgramId, 3);
  assert.equal(full.mandatoryTraining, 1);
  assert.deepEqual(full.metadata, { a: 1 });
  const raw = (await svc.createTraining({ documentVersionId: verId, userId: 3, metadataJson: '{"x":1}' })).training;
  assert.deepEqual(raw.metadata, { x: 1 });
  db.close();
});

// ---- read / queries ----

test('W26T-SVC-6. getTraining found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1 });
  assert.equal((await svc.getTraining(created.training.id)).ok, true);
  assert.equal((await svc.getTraining(9999)).code, 'NOT_FOUND');
  const repo = new TRepo(db);
  const bad = await repo.create({ documentVersionId: verId, userId: 9, metadataJson: '{oops' });
  assert.equal((await svc.getTraining(bad.id)).training.metadata, null);
  db.close();
});

test('W26T-SVC-7. listVersionTraining / pendingTraining / completedTraining / overdueTraining', async () => {
  const { db, svc, verId } = await freshService();
  await svc.createTraining({ documentVersionId: verId, userId: 1, dueDate: '2000-01-01' }); // overdue, pending
  const done = await svc.createTraining({ documentVersionId: verId, userId: 2 });
  await svc.completeTraining(done.training.id, {});
  assert.equal((await svc.listVersionTraining(verId)).trainings.length, 2);
  assert.equal((await svc.pendingTraining()).trainings.length, 1);
  assert.equal((await svc.completedTraining()).trainings.length, 1);
  assert.equal((await svc.overdueTraining()).trainings.length, 1);
  db.close();
});

// ---- update ----

test('W26T-SVC-8. updateTraining NOT_FOUND / validation / success', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.updateTraining(4242, { courseId: 1 })).code, 'NOT_FOUND');
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1 });
  const id = created.training.id;
  assert.equal((await svc.updateTraining(id, { trainingStatus: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.updateTraining(id, { mandatoryTraining: 3 })).code, 'VALIDATION');
  assert.equal((await svc.updateTraining(id, { assessmentRequired: 9 })).code, 'VALIDATION');
  assert.equal((await svc.updateTraining(id, { competencyId: 0 })).code, 'VALIDATION');
  assert.equal((await svc.updateTraining(id, { score: 200 })).code, 'VALIDATION');
  assert.equal((await svc.updateTraining(id, { metadata: 7 })).code, 'VALIDATION');
  const upd = await svc.updateTraining(id, { trainingStatus: 'IN_PROGRESS', courseId: 8, metadata: { r: 1 } });
  assert.equal(upd.training.trainingStatus, 'IN_PROGRESS');
  assert.deepEqual(upd.training.metadata, { r: 1 });
  assert.equal((await svc.updateTraining(id, null)).ok, true, 'non-object patch → no-op success');
  db.close();
});

// ---- completion + assessment ----

test('W26T-SVC-9. completeTraining: NOT_FOUND / already-completed / invalid score', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.completeTraining(9999, {})).code, 'NOT_FOUND');
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1 });
  const id = created.training.id;
  assert.equal((await svc.completeTraining(id, { score: 999 })).code, 'VALIDATION', 'invalid score');
  const done = await svc.completeTraining(id, { score: 75 });
  assert.equal(done.training.trainingStatus, 'COMPLETED');
  assert.ok(done.training.completedDate);
  assert.equal(done.training.attempts, 1);
  assert.equal(done.training.score, 75);
  assert.equal((await svc.completeTraining(id, {})).code, 'VALIDATION', 'already completed');
  db.close();
});

test('W26T-SVC-10. completeTraining assessment gate: required assessment must be passed', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1, assessmentRequired: 1 });
  const id = created.training.id;
  assert.equal((await svc.completeTraining(id, {})).code, 'VALIDATION', 'assessment required, not passed');
  assert.equal((await svc.completeTraining(id, { assessmentPassed: 0 })).code, 'VALIDATION', 'assessment failed');
  const done = await svc.completeTraining(id, { assessmentPassed: 1, score: 90 });
  assert.equal(done.training.trainingStatus, 'COMPLETED');
  assert.equal(done.training.assessmentPassed, 1);
  db.close();
});

test('W26T-SVC-11. completeTraining without assessment succeeds; non-object input is tolerated', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1, assessmentRequired: 0 });
  const done = await svc.completeTraining(created.training.id, {});
  assert.equal(done.training.trainingStatus, 'COMPLETED');
  assert.equal(done.training.attempts, 1);
  const created2 = await svc.createTraining({ documentVersionId: verId, userId: 2, assessmentRequired: 0 });
  const done2 = await svc.completeTraining(created2.training.id, null); // non-object input → {} → completes
  assert.equal(done2.training.trainingStatus, 'COMPLETED');
  db.close();
});

// ---- completion calculation ----

test('W26T-SVC-12. getTrainingCompletion: empty, partial with mandatory-outstanding, and full', async () => {
  const { db, svc, verId } = await freshService();
  assert.deepEqual(await svc.getTrainingCompletion(verId), { ok: true, complete: false, total: 0, completed: 0, outstanding: 0, mandatoryOutstanding: 0 });
  const m1 = await svc.createTraining({ documentVersionId: verId, userId: 1, mandatoryTraining: 1 }); // mandatory, unfinished
  const m2 = await svc.createTraining({ documentVersionId: verId, userId: 2, mandatoryTraining: 1 }); // mandatory, will complete
  await svc.createTraining({ documentVersionId: verId, userId: 3, mandatoryTraining: 0 });            // non-mandatory
  await svc.completeTraining(m2.training.id, {});
  const partial = await svc.getTrainingCompletion(verId);
  assert.deepEqual(partial, { ok: true, complete: false, total: 3, completed: 1, outstanding: 2, mandatoryOutstanding: 1 });
  const list = await svc.listVersionTraining(verId);
  for (const t of list.trainings) { if (t.trainingStatus !== 'COMPLETED') await svc.completeTraining(t.id, {}); }
  const full = await svc.getTrainingCompletion(verId);
  assert.equal(full.complete, true);
  assert.equal(full.completed, 3);
  db.close();
});

// ---- lifecycle ----

test('W26T-SVC-13. archiveTraining success / NOT_FOUND / already-archived', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1 });
  const id = created.training.id;
  assert.equal((await svc.archiveTraining(id)).training.archived, 1);
  assert.equal((await svc.archiveTraining(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveTraining(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26T-SVC-14. deleteTraining success then NOT_FOUND on re-delete', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1 });
  const id = created.training.id;
  assert.equal((await svc.deleteTraining(id)).ok, true);
  assert.equal((await svc.deleteTraining(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26T-SVC-15. restoreTraining restores a soft-deleted row; NOT_FOUND for unknown id', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createTraining({ documentVersionId: verId, userId: 1 });
  const id = created.training.id;
  await svc.deleteTraining(id);
  const restored = await svc.restoreTraining(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.training.deleted, 0);
  assert.equal((await svc.restoreTraining(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26T-SVC-16. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getTraining(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26T-SVC-17. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findByVersion', 'boom-string');
  const r = await svc.getTrainingCompletion(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
