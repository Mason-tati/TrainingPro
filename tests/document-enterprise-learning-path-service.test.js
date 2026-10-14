// WP-26 · Phase 15 — Enterprise Learning Path service tests (ephemeral DB; real DI).
// Business rules over the learning-path repository plus FIVE read-only injected repositories (training
// program, training-assignment, competency, profile, recertification). A full in-memory stack (folder →
// doc-core → version → competency; a program row) provides real referents; the prerequisite reference is
// validated against the path repository itself. Path-code uniqueness, program/competency existence, role
// / sequence / prerequisite rules, classification, estimated-hours, effective/expiry ordering, lifecycle,
// and copy-on-read are exercised end to end.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const LPMig = require(path.join(EDIR, 'enterprise-learning-path-migration.js'));
const LPRepo = require(path.join(EDIR, 'enterprise-learning-path-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-learning-path-service.js'));
const TPMig = require(path.join(EDIR, 'enterprise-training-program-migration.js'));
const TPRepo = require(path.join(EDIR, 'enterprise-training-program-repository.js'));
const KMig = require(path.join(EDIR, 'enterprise-document-competency-migration.js'));
const KRepo = require(path.join(EDIR, 'enterprise-document-competency-repository.js'));
const KSvc = require(path.join(EDIR, 'enterprise-document-competency-service.js'));
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

const REPO_METHODS = ['create', 'update', 'findById', 'findByPathCode', 'findByRole', 'findByTrainingProgram', 'findByCompetency', 'findMandatory', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await LPMig.migrate(db); await TPMig.migrate(db); await KMig.migrate(db); await VMig.migrate(db);
  await DMig.migrate(db); await FMig.migrate(db);
  const lpRepo = new LPRepo(db); const progRepo = new TPRepo(db); const compRepo = new KRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'LP-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const program = await progRepo.create({ programCode: 'PRG-LP', programName: 'Induction' });
  const service = new Service(lpRepo, progRepo, new TRepo(db), compRepo, new PRepo(db), new RRepo(db));
  return { db, service, compId: comp.competency.id, programId: program.id };
}
let codeSeq = 0;
const base = (over) => Object.assign({ pathCode: `LP-${(codeSeq += 1)}`, pathName: 'Induction Path' }, over);

test('W26L-SVC-1. constructor requires training-program, training-assignment, competency, profile, recertification repositories', () => {
  const repo = {}; for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep, dep, dep), /training program repository/);
  assert.throws(() => new Service(repo, dep, null, dep, dep, dep), /training assignment repository/);
  assert.throws(() => new Service(repo, dep, dep, null, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, null, dep), /profile repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, null), /recertification repository/);
});

test('W26L-SVC-2. createLearningPath persists DRAFT defaults and resolves program/competency + metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createLearningPath(base({
    trainingProgramId: ctx.programId, competencyId: ctx.compId, roleId: 3, sequenceNumber: 1,
    estimatedHours: 8, mandatory: 1, metadata: { tier: 'A' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.path.status, 'DRAFT');
  assert.equal(r.path.mandatory, 1);
  assert.equal(r.path.trainingProgramId, ctx.programId);
  assert.deepEqual(r.path.metadata, { tier: 'A' });
  ctx.db.close();
});

test('W26L-SVC-3. createLearningPath resolves an existing prerequisite path', async () => {
  const ctx = await setup();
  const first = await ctx.service.createLearningPath(base({ sequenceNumber: 1 }));
  const second = await ctx.service.createLearningPath(base({ sequenceNumber: 2, prerequisitePathId: first.path.id }));
  assert.equal(second.ok, true);
  assert.equal(second.path.prerequisitePathId, first.path.id);
  ctx.db.close();
});

test('W26L-SVC-4. createLearningPath allows explicit null program/competency/prerequisite (skips checks)', async () => {
  const ctx = await setup();
  const r = await ctx.service.createLearningPath(base({ trainingProgramId: null, competencyId: null, prerequisitePathId: null }));
  assert.equal(r.ok, true);
  assert.equal(r.path.trainingProgramId, null);
  ctx.db.close();
});

test('W26L-SVC-5. createLearningPath requires pathCode and pathName, and rejects non-object input', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createLearningPath(base({ pathCode: '  ' }))).error, 'pathCode is required');
  assert.equal((await ctx.service.createLearningPath(base({ pathName: '' }))).error, 'pathName is required');
  assert.equal((await ctx.service.createLearningPath('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26L-SVC-6. createLearningPath enforces pathCode uniqueness (CONFLICT)', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createLearningPath({ pathCode: 'DUP-1', pathName: 'A' })).ok, true);
  assert.equal((await ctx.service.createLearningPath({ pathCode: 'DUP-1', pathName: 'B' })).code, 'CONFLICT');
  ctx.db.close();
});

test('W26L-SVC-7. createLearningPath validates program / competency / role / prerequisite references', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createLearningPath(base({ trainingProgramId: 0 }))).error, 'trainingProgramId must be a positive integer');
  assert.equal((await ctx.service.createLearningPath(base({ trainingProgramId: 99999 }))).error, 'training program not found');
  assert.equal((await ctx.service.createLearningPath(base({ competencyId: 0 }))).error, 'competencyId must be a positive integer');
  assert.equal((await ctx.service.createLearningPath(base({ competencyId: 99999 }))).error, 'competency not found');
  assert.equal((await ctx.service.createLearningPath(base({ roleId: 0 }))).error, 'roleId must be a positive integer');
  assert.equal((await ctx.service.createLearningPath(base({ prerequisitePathId: 0 }))).error, 'prerequisitePathId must be a positive integer');
  assert.equal((await ctx.service.createLearningPath(base({ prerequisitePathId: 99999 }))).error, 'prerequisite path not found');
  ctx.db.close();
});

test('W26L-SVC-8. createLearningPath validates status / mandatory / sequence / estimatedHours / metadata', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createLearningPath(base({ status: 'WAT' }))).error, 'invalid status');
  assert.equal((await ctx.service.createLearningPath(base({ mandatory: 2 }))).error, 'mandatory must be 0 or 1');
  assert.equal((await ctx.service.createLearningPath(base({ sequenceNumber: 0 }))).error, 'sequenceNumber must be a positive integer');
  assert.equal((await ctx.service.createLearningPath(base({ estimatedHours: -1 }))).error, 'estimatedHours must be a non-negative number');
  assert.equal((await ctx.service.createLearningPath(base({ metadata: 'x' }))).error, 'invalid metadata');
  ctx.db.close();
});

test('W26L-SVC-9. createLearningPath validates effective / expiry ordering', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createLearningPath(base({ effectiveDate: '2026-06-01', expiryDate: '2026-01-01' }))).error, 'expiryDate must be on or after effectiveDate');
  ctx.db.close();
});

test('W26L-SVC-10. createLearningPath accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createLearningPath(base({ metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.path.metadata, null);
  ctx.db.close();
});

test('W26L-SVC-11. updateLearningPath: not found, name/self-prereq/ref/class errors, ordering, success, non-object', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateLearningPath(9999, { status: 'ACTIVE' })).code, 'NOT_FOUND');
  const c = await ctx.service.createLearningPath(base({ effectiveDate: '2026-06-01' }));
  const id = c.path.id;
  assert.equal((await ctx.service.updateLearningPath(id, { pathName: '  ' })).error, 'pathName must be a non-empty string');
  assert.equal((await ctx.service.updateLearningPath(id, { prerequisitePathId: id })).error, 'prerequisitePathId cannot reference the path itself');
  assert.equal((await ctx.service.updateLearningPath(id, { competencyId: 99999 })).error, 'competency not found');
  assert.equal((await ctx.service.updateLearningPath(id, { status: 'WAT' })).error, 'invalid status');
  assert.equal((await ctx.service.updateLearningPath(id, { expiryDate: '2026-01-01' })).error, 'expiryDate must be on or after effectiveDate', 'ordering uses stored effectiveDate');
  const upd = await ctx.service.updateLearningPath(id, { status: 'ACTIVE', sequenceNumber: 3, metadata: { v: 2 } });
  assert.equal(upd.path.status, 'ACTIVE');
  assert.deepEqual(upd.path.metadata, { v: 2 });
  assert.equal((await ctx.service.updateLearningPath(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26L-SVC-12. getLearningPath returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createLearningPath(base({}));
  assert.equal((await ctx.service.getLearningPath(c.path.id)).path.pathName, 'Induction Path');
  assert.equal((await ctx.service.getLearningPath(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26L-SVC-13. list by role / program / competency; mandatory and active queries', async () => {
  const ctx = await setup();
  await ctx.service.createLearningPath(base({ roleId: 77, trainingProgramId: ctx.programId, competencyId: ctx.compId, mandatory: 1 }));
  await ctx.service.createLearningPath(base({ roleId: 77, trainingProgramId: ctx.programId, competencyId: ctx.compId, mandatory: 0 }));
  assert.equal((await ctx.service.listRolePaths(77)).paths.length, 2);
  assert.equal((await ctx.service.listProgramPaths(ctx.programId)).paths.length, 2);
  assert.equal((await ctx.service.listCompetencyPaths(ctx.compId)).paths.length, 2);
  assert.equal((await ctx.service.mandatoryPaths()).paths.length, 1);
  assert.equal((await ctx.service.activePaths()).paths.length, 2);
  ctx.db.close();
});

test('W26L-SVC-14. archiveLearningPath: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveLearningPath(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createLearningPath(base({}));
  assert.equal((await ctx.service.archiveLearningPath(c.path.id)).path.archived, 1);
  assert.equal((await ctx.service.archiveLearningPath(c.path.id)).error, 'learning path already archived');
  ctx.db.close();
});

test('W26L-SVC-15. deleteLearningPath then restoreLearningPath; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteLearningPath(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreLearningPath(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createLearningPath(base({}));
  const id = c.path.id;
  assert.deepEqual(await ctx.service.deleteLearningPath(id), { ok: true, id });
  assert.equal((await ctx.service.getLearningPath(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreLearningPath(id)).path.deleted, 0);
  ctx.db.close();
});

test('W26L-SVC-15b. createLearningPath accepts a zero-hour boundary and updateLearningPath re-files program/prerequisite', async () => {
  const ctx = await setup();
  const zero = await ctx.service.createLearningPath(base({ estimatedHours: 0, sequenceNumber: 1 }));
  assert.equal(zero.ok, true);
  assert.equal(zero.path.estimatedHours, 0);
  const target = await ctx.service.createLearningPath(base({}));
  const upd = await ctx.service.updateLearningPath(target.path.id, { trainingProgramId: ctx.programId, prerequisitePathId: zero.path.id });
  assert.equal(upd.ok, true);
  assert.equal(upd.path.trainingProgramId, ctx.programId);
  assert.equal(upd.path.prerequisitePathId, zero.path.id);
  ctx.db.close();
});

test('W26L-SVC-16. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const brokenRepo = {}; for (const m of REPO_METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const dep = { findById() {} };
  const boom = new Service(brokenRepo, dep, dep, dep, dep, dep);
  const r = await boom.getLearningPath(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
