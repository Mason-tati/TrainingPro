// WP-26 · Phase 8 — Enterprise Document Competency service tests (business rules; ephemeral DB).
// Covers version validation (via injected version repo), competency/assessment/training/level/score
// validation, deterministic expiry calculation (effectiveDate + validationPeriodMonths), mandatory/
// expired/active queries, lifecycle, and never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const CMig = require(path.join(EDIR, 'enterprise-document-competency-migration.js'));
const CRepo = require(path.join(EDIR, 'enterprise-document-competency-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-competency-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findMandatory', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await CMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'DOC-1', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const svc = new Service(new CRepo(db), verRepo);
  return { db, svc, verId: ver.version.id };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return { id: 1 }; } });
}
const base = (verId, over) => Object.assign({ documentVersionId: verId, competencyId: 5, competencyCode: 'C1', competencyName: 'One' }, over);

// ---- construction ----

test('W26K-SVC-1. constructor validates the competency repo AND requires a version repository', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  assert.throws(() => new Service({}, { findById() {} }), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}), /requires an injected version repository/);
  assert.throws(() => new Service(goodRepo, null), /requires an injected version repository/);
});

// ---- create: validation ----

test('W26K-SVC-2. createCompetency requires an existing version', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createCompetency(null)).code, 'VALIDATION');
  assert.equal((await svc.createCompetency({ competencyId: 1 })).code, 'VALIDATION', 'missing versionId (undefined)');
  assert.equal((await svc.createCompetency({ documentVersionId: null, competencyId: 1 })).code, 'VALIDATION', 'null versionId');
  assert.equal((await svc.createCompetency({ documentVersionId: 9999, competencyId: 1, competencyCode: 'x', competencyName: 'x' })).code, 'VALIDATION', 'unknown version');
  db.close();
});

test('W26K-SVC-3. create validates competencyId / competencyCode / competencyName', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createCompetency({ documentVersionId: verId, competencyCode: 'x', competencyName: 'x' })).code, 'VALIDATION', 'competencyId');
  assert.equal((await svc.createCompetency({ documentVersionId: verId, competencyId: 0, competencyCode: 'x', competencyName: 'x' })).code, 'VALIDATION', 'competencyId 0');
  assert.equal((await svc.createCompetency({ documentVersionId: verId, competencyId: 1, competencyName: 'x' })).code, 'VALIDATION', 'code');
  assert.equal((await svc.createCompetency({ documentVersionId: verId, competencyId: 1, competencyCode: '  ' })).code, 'VALIDATION', 'blank code');
  assert.equal((await svc.createCompetency({ documentVersionId: verId, competencyId: 1, competencyCode: 'x' })).code, 'VALIDATION', 'name');
  db.close();
});

test('W26K-SVC-4. create validates level / flags / score / attempts / period / metadata', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createCompetency(base(verId, { competencyLevel: 'GURU' }))).code, 'VALIDATION');
  assert.equal((await svc.createCompetency(base(verId, { mandatoryCompetency: 2 }))).code, 'VALIDATION');
  assert.equal((await svc.createCompetency(base(verId, { assessmentRequired: 5 }))).code, 'VALIDATION');
  assert.equal((await svc.createCompetency(base(verId, { trainingRequired: 9 }))).code, 'VALIDATION');
  assert.equal((await svc.createCompetency(base(verId, { requiredScore: 200 }))).code, 'VALIDATION');
  assert.equal((await svc.createCompetency(base(verId, { minimumAttempts: -1 }))).code, 'VALIDATION');
  assert.equal((await svc.createCompetency(base(verId, { validationPeriodMonths: -3 }))).code, 'VALIDATION');
  assert.equal((await svc.createCompetency(base(verId, { metadata: 'no' }))).code, 'VALIDATION');
  db.close();
});

test('W26K-SVC-5. create (minimal) defaults; (full) persists + parses metadata', async () => {
  const { db, svc, verId } = await freshService();
  const min = (await svc.createCompetency(base(verId, {}))).competency;
  assert.equal(min.competencyLevel, 'BASIC');
  assert.equal(min.mandatoryCompetency, 0);
  assert.equal(min.assessmentRequired, 0);
  assert.equal(min.trainingRequired, 0);
  assert.equal(min.metadata, null);
  const full = (await svc.createCompetency(base(verId, {
    competencyId: 6, competencyCode: 'C2', competencyLevel: 'EXPERT', requiredScore: 90, minimumAttempts: 2,
    assessmentRequired: 1, trainingRequired: 1, mandatoryCompetency: 1, metadata: { a: 1 },
  }))).competency;
  assert.equal(full.competencyLevel, 'EXPERT');
  assert.equal(full.requiredScore, 90);
  assert.deepEqual(full.metadata, { a: 1 });
  const raw = (await svc.createCompetency(base(verId, { competencyId: 7, competencyCode: 'C3', metadataJson: '{"x":1}' }))).competency;
  assert.deepEqual(raw.metadata, { x: 1 });
  db.close();
});

// ---- expiry calculation (covers every branch of the compute condition) ----

test('W26K-SVC-6. expiry is computed from effectiveDate + validationPeriodMonths', async () => {
  const { db, svc, verId } = await freshService();
  const c = (await svc.createCompetency(base(verId, { effectiveDate: '2026-01-15', validationPeriodMonths: 12 }))).competency;
  assert.equal(c.effectiveDate, '2026-01-15');
  assert.equal(c.expiryDate, '2027-01-15');
  db.close();
});

test('W26K-SVC-7. an explicit expiryDate is not overwritten by the computation', async () => {
  const { db, svc, verId } = await freshService();
  const c = (await svc.createCompetency(base(verId, { effectiveDate: '2026-01-01', validationPeriodMonths: 12, expiryDate: '2030-01-01' }))).competency;
  assert.equal(c.expiryDate, '2030-01-01');
  db.close();
});

test('W26K-SVC-8. no expiry computed when effectiveDate or validationPeriodMonths is missing', async () => {
  const { db, svc, verId } = await freshService();
  const noMonths = (await svc.createCompetency(base(verId, { effectiveDate: '2026-01-01' }))).competency;
  assert.equal(noMonths.expiryDate, null, 'effectiveDate but no period');
  const noEffective = (await svc.createCompetency(base(verId, { competencyId: 6, competencyCode: 'C2', validationPeriodMonths: 12 }))).competency;
  assert.equal(noEffective.expiryDate, null, 'period but no effectiveDate');
  const neither = (await svc.createCompetency(base(verId, { competencyId: 7, competencyCode: 'C3' }))).competency;
  assert.equal(neither.expiryDate, null);
  db.close();
});

test('W26K-SVC-9. an invalid effectiveDate yields a null computed expiry (never throws)', async () => {
  const { db, svc, verId } = await freshService();
  const c = (await svc.createCompetency(base(verId, { effectiveDate: 'not-a-date', validationPeriodMonths: 6 }))).competency;
  assert.equal(c.expiryDate, null);
  db.close();
});

// ---- read / queries ----

test('W26K-SVC-10. getCompetency found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createCompetency(base(verId, {}));
  assert.equal((await svc.getCompetency(created.competency.id)).ok, true);
  assert.equal((await svc.getCompetency(9999)).code, 'NOT_FOUND');
  const repo = new CRepo(db);
  const bad = await repo.create({ documentVersionId: verId, competencyId: 9, competencyCode: 'B', competencyName: 'B', metadataJson: '{oops' });
  assert.equal((await svc.getCompetency(bad.id)).competency.metadata, null);
  db.close();
});

test('W26K-SVC-11. listVersion / mandatory / expired / active competency queries', async () => {
  const { db, svc, verId } = await freshService();
  await svc.createCompetency(base(verId, { mandatoryCompetency: 1, effectiveDate: '2000-01-01', validationPeriodMonths: 1 })); // expired + mandatory
  await svc.createCompetency(base(verId, { competencyId: 6, competencyCode: 'C2' }));
  assert.equal((await svc.listVersionCompetencies(verId)).competencies.length, 2);
  assert.equal((await svc.mandatoryCompetencies()).competencies.length, 1);
  assert.equal((await svc.expiredCompetencies()).competencies.length, 1);
  assert.equal((await svc.activeCompetencies()).competencies.length, 2);
  db.close();
});

// ---- update ----

test('W26K-SVC-12. updateCompetency NOT_FOUND / validation / success', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.updateCompetency(4242, { competencyName: 'x' })).code, 'NOT_FOUND');
  const created = await svc.createCompetency(base(verId, {}));
  const id = created.competency.id;
  assert.equal((await svc.updateCompetency(id, { competencyLevel: 'GURU' })).code, 'VALIDATION');
  assert.equal((await svc.updateCompetency(id, { mandatoryCompetency: 3 })).code, 'VALIDATION');
  assert.equal((await svc.updateCompetency(id, { assessmentRequired: 5 })).code, 'VALIDATION');
  assert.equal((await svc.updateCompetency(id, { trainingRequired: 7 })).code, 'VALIDATION');
  assert.equal((await svc.updateCompetency(id, { requiredScore: 200 })).code, 'VALIDATION');
  assert.equal((await svc.updateCompetency(id, { minimumAttempts: -1 })).code, 'VALIDATION');
  assert.equal((await svc.updateCompetency(id, { validationPeriodMonths: -2 })).code, 'VALIDATION');
  assert.equal((await svc.updateCompetency(id, { metadata: 7 })).code, 'VALIDATION');
  const upd = await svc.updateCompetency(id, { competencyLevel: 'ADVANCED', requiredScore: 70, metadata: { r: 1 } });
  assert.equal(upd.competency.competencyLevel, 'ADVANCED');
  assert.deepEqual(upd.competency.metadata, { r: 1 });
  assert.equal((await svc.updateCompetency(id, null)).ok, true, 'non-object patch → no-op success');
  db.close();
});

// ---- lifecycle ----

test('W26K-SVC-13. archiveCompetency success / NOT_FOUND / already-archived', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createCompetency(base(verId, {}));
  const id = created.competency.id;
  assert.equal((await svc.archiveCompetency(id)).competency.archived, 1);
  assert.equal((await svc.archiveCompetency(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveCompetency(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26K-SVC-14. deleteCompetency success then NOT_FOUND on re-delete', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createCompetency(base(verId, {}));
  const id = created.competency.id;
  assert.equal((await svc.deleteCompetency(id)).ok, true);
  assert.equal((await svc.deleteCompetency(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26K-SVC-15. restoreCompetency restores a soft-deleted row; NOT_FOUND for unknown id', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createCompetency(base(verId, {}));
  const id = created.competency.id;
  await svc.deleteCompetency(id);
  const restored = await svc.restoreCompetency(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.competency.deleted, 0);
  assert.equal((await svc.restoreCompetency(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26K-SVC-16. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getCompetency(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26K-SVC-17. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findMandatory', 'boom-string');
  const r = await svc.mandatoryCompetencies();
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
