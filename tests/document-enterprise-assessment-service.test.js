// WP-26 · Phase 9 — Enterprise Document Assessment service tests (business rules; ephemeral DB).
// Covers version validation (via injected version repo), assessment/type/passMark/attempt/question/
// randomization validation, publication lifecycle (readiness-gated), published/expired/active queries,
// lifecycle, and never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const AMig = require(path.join(EDIR, 'enterprise-document-assessment-migration.js'));
const ARepo = require(path.join(EDIR, 'enterprise-document-assessment-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-assessment-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findActive', 'findExpired', 'findPublished', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await AMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'DOC-1', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const svc = new Service(new ARepo(db), verRepo);
  return { db, svc, verId: ver.version.id };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return { id: 1 }; } });
}
const base = (verId, over) => Object.assign({ documentVersionId: verId, assessmentId: 5, assessmentCode: 'A1', assessmentTitle: 'One' }, over);

// ---- construction ----

test('W26S-SVC-1. constructor validates the assessment repo AND requires a version repository', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  assert.throws(() => new Service({}, { findById() {} }), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}), /requires an injected version repository/);
  assert.throws(() => new Service(goodRepo, null), /requires an injected version repository/);
});

// ---- create: validation ----

test('W26S-SVC-2. createAssessment requires an existing version', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createAssessment(null)).code, 'VALIDATION');
  assert.equal((await svc.createAssessment({ assessmentId: 1 })).code, 'VALIDATION', 'missing versionId (undefined)');
  assert.equal((await svc.createAssessment({ documentVersionId: null, assessmentId: 1 })).code, 'VALIDATION', 'null versionId');
  assert.equal((await svc.createAssessment({ documentVersionId: 9999, assessmentId: 1, assessmentCode: 'x', assessmentTitle: 'x' })).code, 'VALIDATION', 'unknown version');
  db.close();
});

test('W26S-SVC-3. create validates assessmentId / assessmentCode / assessmentTitle', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createAssessment({ documentVersionId: verId, assessmentCode: 'x', assessmentTitle: 'x' })).code, 'VALIDATION', 'assessmentId');
  assert.equal((await svc.createAssessment({ documentVersionId: verId, assessmentId: 0, assessmentCode: 'x', assessmentTitle: 'x' })).code, 'VALIDATION');
  assert.equal((await svc.createAssessment({ documentVersionId: verId, assessmentId: 1, assessmentTitle: 'x' })).code, 'VALIDATION', 'code');
  assert.equal((await svc.createAssessment({ documentVersionId: verId, assessmentId: 1, assessmentCode: '  ' })).code, 'VALIDATION', 'blank code');
  assert.equal((await svc.createAssessment({ documentVersionId: verId, assessmentId: 1, assessmentCode: 'x' })).code, 'VALIDATION', 'title');
  db.close();
});

test('W26S-SVC-4. create validates type / status / passMark / attempts / time / questions / randomization / metadata', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createAssessment(base(verId, { assessmentType: 'GAME' }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { assessmentStatus: 'LIVE' }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { passMark: 150 }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { maximumAttempts: 0 }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { timeLimitMinutes: 0 }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { questionCount: 0 }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { randomizeQuestions: 2 }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { randomizeAnswers: 9 }))).code, 'VALIDATION');
  assert.equal((await svc.createAssessment(base(verId, { metadata: 'no' }))).code, 'VALIDATION');
  db.close();
});

test('W26S-SVC-5. create (minimal) defaults; (full) persists + parses metadata', async () => {
  const { db, svc, verId } = await freshService();
  const min = (await svc.createAssessment(base(verId, {}))).assessment;
  assert.equal(min.assessmentType, 'QUIZ');
  assert.equal(min.assessmentStatus, 'DRAFT');
  assert.equal(min.randomizeQuestions, 0);
  assert.equal(min.randomizeAnswers, 0);
  assert.equal(min.metadata, null);
  const full = (await svc.createAssessment(base(verId, {
    assessmentId: 6, assessmentCode: 'A2', assessmentType: 'CERTIFICATION', passMark: 90, maximumAttempts: 2,
    timeLimitMinutes: 30, questionCount: 40, randomizeQuestions: 1, randomizeAnswers: 1, metadata: { a: 1 },
  }))).assessment;
  assert.equal(full.assessmentType, 'CERTIFICATION');
  assert.equal(full.passMark, 90);
  assert.deepEqual(full.metadata, { a: 1 });
  const raw = (await svc.createAssessment(base(verId, { assessmentId: 7, assessmentCode: 'A3', metadataJson: '{"x":1}' }))).assessment;
  assert.deepEqual(raw.metadata, { x: 1 });
  db.close();
});

// ---- read / queries ----

test('W26S-SVC-6. getAssessment found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createAssessment(base(verId, {}));
  assert.equal((await svc.getAssessment(created.assessment.id)).ok, true);
  assert.equal((await svc.getAssessment(9999)).code, 'NOT_FOUND');
  const repo = new ARepo(db);
  const bad = await repo.create({ documentVersionId: verId, assessmentId: 9, assessmentCode: 'B', assessmentTitle: 'B', metadataJson: '{oops' });
  assert.equal((await svc.getAssessment(bad.id)).assessment.metadata, null);
  db.close();
});

test('W26S-SVC-7. listVersion / published / expired / active queries', async () => {
  const { db, svc, verId } = await freshService();
  await svc.createAssessment(base(verId, { assessmentStatus: 'PUBLISHED', expiryDate: '2000-01-01' })); // published + expired
  await svc.createAssessment(base(verId, { assessmentId: 6, assessmentCode: 'A2' }));
  assert.equal((await svc.listVersionAssessments(verId)).assessments.length, 2);
  assert.equal((await svc.publishedAssessments()).assessments.length, 1);
  assert.equal((await svc.expiredAssessments()).assessments.length, 1);
  assert.equal((await svc.activeAssessments()).assessments.length, 2);
  db.close();
});

// ---- update ----

test('W26S-SVC-8. updateAssessment NOT_FOUND / validation / success', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.updateAssessment(4242, { assessmentTitle: 'x' })).code, 'NOT_FOUND');
  const created = await svc.createAssessment(base(verId, {}));
  const id = created.assessment.id;
  assert.equal((await svc.updateAssessment(id, { assessmentType: 'GAME' })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { assessmentStatus: 'LIVE' })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { passMark: 200 })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { maximumAttempts: 0 })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { timeLimitMinutes: 0 })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { questionCount: 0 })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { randomizeQuestions: 2 })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { randomizeAnswers: 3 })).code, 'VALIDATION');
  assert.equal((await svc.updateAssessment(id, { metadata: 7 })).code, 'VALIDATION');
  const upd = await svc.updateAssessment(id, { assessmentType: 'EXAM', passMark: 75, metadata: { r: 1 } });
  assert.equal(upd.assessment.assessmentType, 'EXAM');
  assert.deepEqual(upd.assessment.metadata, { r: 1 });
  assert.equal((await svc.updateAssessment(id, null)).ok, true, 'non-object patch → no-op success');
  db.close();
});

// ---- publication lifecycle ----

test('W26S-SVC-9. publishAssessment: NOT_FOUND / not-ready (missing questionCount or passMark) / success / already-published', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.publishAssessment(9999)).code, 'NOT_FOUND');
  const noQ = await svc.createAssessment(base(verId, { passMark: 80 })); // has passMark, no questionCount
  assert.equal((await svc.publishAssessment(noQ.assessment.id)).code, 'VALIDATION', 'missing questionCount');
  const noMark = await svc.createAssessment(base(verId, { assessmentId: 6, assessmentCode: 'A2', questionCount: 10 })); // has questionCount, no passMark
  assert.equal((await svc.publishAssessment(noMark.assessment.id)).code, 'VALIDATION', 'missing passMark');
  const ready = await svc.createAssessment(base(verId, { assessmentId: 7, assessmentCode: 'A3', passMark: 80, questionCount: 10 }));
  const pub = await svc.publishAssessment(ready.assessment.id);
  assert.equal(pub.assessment.assessmentStatus, 'PUBLISHED');
  assert.equal((await svc.publishAssessment(ready.assessment.id)).code, 'VALIDATION', 'already published');
  db.close();
});

// ---- lifecycle ----

test('W26S-SVC-10. archiveAssessment success / NOT_FOUND / already-archived', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createAssessment(base(verId, {}));
  const id = created.assessment.id;
  assert.equal((await svc.archiveAssessment(id)).assessment.archived, 1);
  assert.equal((await svc.archiveAssessment(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveAssessment(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26S-SVC-11. deleteAssessment success then NOT_FOUND on re-delete', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createAssessment(base(verId, {}));
  const id = created.assessment.id;
  assert.equal((await svc.deleteAssessment(id)).ok, true);
  assert.equal((await svc.deleteAssessment(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26S-SVC-12. restoreAssessment restores a soft-deleted row; NOT_FOUND for unknown id', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createAssessment(base(verId, {}));
  const id = created.assessment.id;
  await svc.deleteAssessment(id);
  const restored = await svc.restoreAssessment(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.assessment.deleted, 0);
  assert.equal((await svc.restoreAssessment(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26S-SVC-13. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getAssessment(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26S-SVC-14. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findPublished', 'boom-string');
  const r = await svc.publishedAssessments();
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});

test('W26S-SVC-15. active / expired / published queries are empty for a fresh engine', async () => {
  const { db, svc } = await freshService();
  assert.deepEqual((await svc.activeAssessments()).assessments, []);
  assert.deepEqual((await svc.expiredAssessments()).assessments, []);
  assert.deepEqual((await svc.publishedAssessments()).assessments, []);
  db.close();
});

test('W26S-SVC-16. a published assessment surfaces in publishedAssessments and stays active', async () => {
  const { db, svc, verId } = await freshService();
  const ready = await svc.createAssessment(base(verId, { passMark: 60, questionCount: 5 }));
  await svc.publishAssessment(ready.assessment.id);
  const published = await svc.publishedAssessments();
  assert.equal(published.assessments.length, 1);
  assert.equal(published.assessments[0].assessmentStatus, 'PUBLISHED');
  assert.equal((await svc.activeAssessments()).assessments.length, 1);
  db.close();
});

test('W26S-SVC-17. listVersionAssessments is empty for a version with no assessments', async () => {
  const { db, svc } = await freshService();
  const r = await svc.listVersionAssessments(4242);
  assert.equal(r.ok, true);
  assert.deepEqual(r.assessments, []);
  db.close();
});
