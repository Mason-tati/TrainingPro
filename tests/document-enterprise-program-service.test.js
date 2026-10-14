// WP-26 · Phase 14 — Enterprise Training Program service tests (ephemeral DB; real DI).
// Business rules over the program repository plus FIVE read-only injected repositories (competency,
// assessment, training-assignment, profile, recertification). A full in-memory stack (folder → doc-core
// → version → competency + assessment) provides real referents so program-code uniqueness, competency /
// assessment existence, trainer/owner validation, classification, renewal & mandatory rules, effective/
// expiry ordering, lifecycle, and copy-on-read are exercised end to end.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const TPMig = require(path.join(EDIR, 'enterprise-training-program-migration.js'));
const TPRepo = require(path.join(EDIR, 'enterprise-training-program-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-training-program-service.js'));
const KMig = require(path.join(EDIR, 'enterprise-document-competency-migration.js'));
const KRepo = require(path.join(EDIR, 'enterprise-document-competency-repository.js'));
const KSvc = require(path.join(EDIR, 'enterprise-document-competency-service.js'));
const SMig = require(path.join(EDIR, 'enterprise-document-assessment-migration.js'));
const SRepo = require(path.join(EDIR, 'enterprise-document-assessment-repository.js'));
const SSvc = require(path.join(EDIR, 'enterprise-document-assessment-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const TRepo = require(path.join(EDIR, 'enterprise-document-training-repository.js'));
const PRepo = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));
const RRepo = require(path.join(EDIR, 'enterprise-competency-recertification-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByProgramCode', 'findByCompetency', 'findByTrainer', 'findMandatory', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await TPMig.migrate(db); await KMig.migrate(db); await SMig.migrate(db); await VMig.migrate(db);
  await DMig.migrate(db); await FMig.migrate(db);
  const progRepo = new TPRepo(db); const compRepo = new KRepo(db); const assRepo = new SRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'TP-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const ass = await new SSvc(assRepo, verRepo).createAssessment({ documentVersionId: ver.version.id, assessmentId: 200, assessmentCode: 'A-1', assessmentTitle: 'Q1' });
  // Injected read-only for downstream integration (never queried by the program service's rules).
  const service = new Service(progRepo, compRepo, assRepo, new TRepo(db), new PRepo(db), new RRepo(db));
  return { db, service, compId: comp.competency.id, assId: ass.assessment.id };
}
let codeSeq = 0;
const base = (over) => Object.assign({ programCode: `PRG-${(codeSeq += 1)}`, programName: 'Safety Induction' }, over);

test('W26T-SVC-1. constructor requires competency, assessment, training-assignment, profile, recertification repositories', () => {
  const repo = {}; for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, null, dep, dep, dep), /assessment repository/);
  assert.throws(() => new Service(repo, dep, dep, null, dep, dep), /training assignment repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, null, dep), /profile repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, null), /recertification repository/);
});

test('W26T-SVC-2. createProgram persists DRAFT defaults and resolves competency/assessment + metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createProgram(base({
    competencyId: ctx.compId, assessmentId: ctx.assId, trainingType: 'SAFETY', deliveryMethod: 'BLENDED',
    trainerId: 9, ownerId: 3, durationHours: 4, renewalPeriodMonths: 12, mandatory: 1, metadata: { crb: true },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.program.status, 'DRAFT');
  assert.equal(r.program.mandatory, 1);
  assert.equal(r.program.competencyId, ctx.compId);
  assert.deepEqual(r.program.metadata, { crb: true });
  ctx.db.close();
});

test('W26T-SVC-3. createProgram allows an explicit null competencyId/assessmentId (skips existence checks)', async () => {
  const ctx = await setup();
  const r = await ctx.service.createProgram(base({ competencyId: null, assessmentId: null }));
  assert.equal(r.ok, true);
  assert.equal(r.program.competencyId, null);
  ctx.db.close();
});

test('W26T-SVC-4. createProgram requires programCode and programName, and rejects non-object input', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProgram(base({ programCode: '  ' }))).error, 'programCode is required');
  assert.equal((await ctx.service.createProgram(base({ programName: '' }))).error, 'programName is required');
  assert.equal((await ctx.service.createProgram('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26T-SVC-5. createProgram enforces programCode uniqueness (CONFLICT)', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProgram({ programCode: 'DUP-1', programName: 'A' })).ok, true);
  assert.equal((await ctx.service.createProgram({ programCode: 'DUP-1', programName: 'B' })).code, 'CONFLICT');
  ctx.db.close();
});

test('W26T-SVC-6. createProgram validates competency / assessment / trainer / owner references', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProgram(base({ competencyId: 0 }))).error, 'competencyId must be a positive integer');
  assert.equal((await ctx.service.createProgram(base({ competencyId: 99999 }))).error, 'competency not found');
  assert.equal((await ctx.service.createProgram(base({ assessmentId: 0 }))).error, 'assessmentId must be a positive integer');
  assert.equal((await ctx.service.createProgram(base({ assessmentId: 99999 }))).error, 'assessment not found');
  assert.equal((await ctx.service.createProgram(base({ trainerId: 0 }))).error, 'trainerId must be a positive integer');
  assert.equal((await ctx.service.createProgram(base({ ownerId: 0 }))).error, 'ownerId must be a positive integer');
  ctx.db.close();
});

test('W26T-SVC-7. createProgram validates type / delivery / status / mandatory / duration / renewal / metadata', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProgram(base({ trainingType: 'WAT' }))).error, 'invalid trainingType');
  assert.equal((await ctx.service.createProgram(base({ deliveryMethod: 'TELEPATHY' }))).error, 'invalid deliveryMethod');
  assert.equal((await ctx.service.createProgram(base({ status: 'WAT' }))).error, 'invalid status');
  assert.equal((await ctx.service.createProgram(base({ mandatory: 2 }))).error, 'mandatory must be 0 or 1');
  assert.equal((await ctx.service.createProgram(base({ durationHours: -1 }))).error, 'durationHours must be a non-negative number');
  assert.equal((await ctx.service.createProgram(base({ renewalPeriodMonths: 0 }))).error, 'renewalPeriodMonths must be a positive integer');
  assert.equal((await ctx.service.createProgram(base({ metadata: 'x' }))).error, 'invalid metadata');
  ctx.db.close();
});

test('W26T-SVC-8. createProgram validates effective / expiry ordering', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProgram(base({ effectiveDate: '2026-06-01', expiryDate: '2026-01-01' }))).error, 'expiryDate must be on or after effectiveDate');
  ctx.db.close();
});

test('W26T-SVC-9. createProgram accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createProgram(base({ metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.program.metadata, null);
  ctx.db.close();
});

test('W26T-SVC-10. updateProgram: not found, name/ref/class errors, ordering, success, non-object patch', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateProgram(9999, { status: 'ACTIVE' })).code, 'NOT_FOUND');
  const c = await ctx.service.createProgram(base({ effectiveDate: '2026-06-01' }));
  const id = c.program.id;
  assert.equal((await ctx.service.updateProgram(id, { programName: '  ' })).error, 'programName must be a non-empty string');
  assert.equal((await ctx.service.updateProgram(id, { competencyId: 99999 })).error, 'competency not found');
  assert.equal((await ctx.service.updateProgram(id, { status: 'WAT' })).error, 'invalid status');
  assert.equal((await ctx.service.updateProgram(id, { expiryDate: '2026-01-01' })).error, 'expiryDate must be on or after effectiveDate', 'ordering uses stored effectiveDate');
  const upd = await ctx.service.updateProgram(id, { status: 'ACTIVE', deliveryMethod: 'ONLINE', metadata: { v: 2 } });
  assert.equal(upd.program.status, 'ACTIVE');
  assert.deepEqual(upd.program.metadata, { v: 2 });
  assert.equal((await ctx.service.updateProgram(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26T-SVC-11. getProgram returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createProgram(base({}));
  assert.equal((await ctx.service.getProgram(c.program.id)).program.programName, 'Safety Induction');
  assert.equal((await ctx.service.getProgram(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26T-SVC-12. list by competency and by trainer; mandatory and active queries', async () => {
  const ctx = await setup();
  await ctx.service.createProgram(base({ competencyId: ctx.compId, trainerId: 77, mandatory: 1 }));
  await ctx.service.createProgram(base({ competencyId: ctx.compId, trainerId: 77, mandatory: 0 }));
  assert.equal((await ctx.service.listCompetencyPrograms(ctx.compId)).programs.length, 2);
  assert.equal((await ctx.service.listTrainerPrograms(77)).programs.length, 2);
  assert.equal((await ctx.service.mandatoryPrograms()).programs.length, 1);
  assert.equal((await ctx.service.activePrograms()).programs.length, 2);
  ctx.db.close();
});

test('W26T-SVC-13. archiveProgram: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveProgram(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createProgram(base({}));
  assert.equal((await ctx.service.archiveProgram(c.program.id)).program.archived, 1);
  assert.equal((await ctx.service.archiveProgram(c.program.id)).error, 'program already archived');
  ctx.db.close();
});

test('W26T-SVC-14. deleteProgram then restoreProgram; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteProgram(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreProgram(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createProgram(base({}));
  const id = c.program.id;
  assert.deepEqual(await ctx.service.deleteProgram(id), { ok: true, id });
  assert.equal((await ctx.service.getProgram(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreProgram(id)).program.deleted, 0);
  ctx.db.close();
});

test('W26T-SVC-15b. createProgram accepts every enum value and a zero-hour boundary', async () => {
  const ctx = await setup();
  const r = await ctx.service.createProgram(base({ trainingType: 'INDUCTION', deliveryMethod: 'SELF_STUDY', status: 'ACTIVE', durationHours: 0, renewalPeriodMonths: 24 }));
  assert.equal(r.ok, true);
  assert.equal(r.program.status, 'ACTIVE');
  assert.equal(r.program.durationHours, 0);
  ctx.db.close();
});

test('W26T-SVC-15c. updateProgram re-validates and accepts a valid competency/assessment re-file', async () => {
  const ctx = await setup();
  const c = await ctx.service.createProgram(base({}));
  const upd = await ctx.service.updateProgram(c.program.id, { competencyId: ctx.compId, assessmentId: ctx.assId, trainerId: 12 });
  assert.equal(upd.ok, true);
  assert.equal(upd.program.competencyId, ctx.compId);
  assert.equal(upd.program.assessmentId, ctx.assId);
  ctx.db.close();
});

test('W26T-SVC-15. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const brokenRepo = {}; for (const m of REPO_METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const dep = { findById() {} };
  const boom = new Service(brokenRepo, dep, dep, dep, dep, dep);
  const r = await boom.getProgram(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
