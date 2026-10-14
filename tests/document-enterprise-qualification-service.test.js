// WP-26 · Phase 16 — Enterprise Qualification service tests (ephemeral DB; real DI).
// Business rules over the qualification repository plus FIVE read-only injected repositories (learning
// path, training program, competency, profile, recertification). A full in-memory stack (folder →
// doc-core → version → competency; a learning-path row) provides real referents. Qualification-code
// uniqueness, learning-path/competency existence, role/type/validity/renewal rules, classification,
// effective/expiry ordering, lifecycle, and copy-on-read are exercised end to end.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const QMig = require(path.join(EDIR, 'enterprise-qualification-migration.js'));
const QRepo = require(path.join(EDIR, 'enterprise-qualification-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-qualification-service.js'));
const LPMig = require(path.join(EDIR, 'enterprise-learning-path-migration.js'));
const LPRepo = require(path.join(EDIR, 'enterprise-learning-path-repository.js'));
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
const PRepo = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));
const RRepo = require(path.join(EDIR, 'enterprise-competency-recertification-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByQualificationCode', 'findByRole', 'findByLearningPath', 'findByCompetency', 'findMandatory', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await QMig.migrate(db); await LPMig.migrate(db); await KMig.migrate(db); await VMig.migrate(db);
  await DMig.migrate(db); await FMig.migrate(db);
  const qualRepo = new QRepo(db); const lpRepo = new LPRepo(db); const compRepo = new KRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'QL-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const lp = await lpRepo.create({ pathCode: 'LP-Q', pathName: 'Induction Path' });
  const service = new Service(qualRepo, lpRepo, new TPRepo(db), compRepo, new PRepo(db), new RRepo(db));
  return { db, service, compId: comp.competency.id, learningPathId: lp.id };
}
let codeSeq = 0;
const base = (over) => Object.assign({ qualificationCode: `QL-${(codeSeq += 1)}`, qualificationName: 'Forklift Licence' }, over);

test('W26Q-SVC-1. constructor requires learning-path, training-program, competency, profile, recertification repositories', () => {
  const repo = {}; for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep, dep, dep), /learning path repository/);
  assert.throws(() => new Service(repo, dep, null, dep, dep, dep), /training program repository/);
  assert.throws(() => new Service(repo, dep, dep, null, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, null, dep), /profile repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, null), /recertification repository/);
});

test('W26Q-SVC-2. createQualification persists DRAFT defaults and resolves learning path/competency + metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createQualification(base({
    learningPathId: ctx.learningPathId, competencyId: ctx.compId, roleId: 3, qualificationType: 'LICENSE',
    validityMonths: 24, renewalRequired: 1, mandatory: 1, metadata: { regulator: 'WorkSafe' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.qualification.status, 'DRAFT');
  assert.equal(r.qualification.mandatory, 1);
  assert.equal(r.qualification.learningPathId, ctx.learningPathId);
  assert.deepEqual(r.qualification.metadata, { regulator: 'WorkSafe' });
  ctx.db.close();
});

test('W26Q-SVC-3. createQualification allows explicit null learning path / competency (skips checks)', async () => {
  const ctx = await setup();
  const r = await ctx.service.createQualification(base({ learningPathId: null, competencyId: null }));
  assert.equal(r.ok, true);
  assert.equal(r.qualification.learningPathId, null);
  ctx.db.close();
});

test('W26Q-SVC-4. createQualification requires code and name, and rejects non-object input', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createQualification(base({ qualificationCode: '  ' }))).error, 'qualificationCode is required');
  assert.equal((await ctx.service.createQualification(base({ qualificationName: '' }))).error, 'qualificationName is required');
  assert.equal((await ctx.service.createQualification('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26Q-SVC-5. createQualification enforces qualificationCode uniqueness (CONFLICT)', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createQualification({ qualificationCode: 'DUP-1', qualificationName: 'A' })).ok, true);
  assert.equal((await ctx.service.createQualification({ qualificationCode: 'DUP-1', qualificationName: 'B' })).code, 'CONFLICT');
  ctx.db.close();
});

test('W26Q-SVC-6. createQualification validates learning path / competency / role references', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createQualification(base({ learningPathId: 0 }))).error, 'learningPathId must be a positive integer');
  assert.equal((await ctx.service.createQualification(base({ learningPathId: 99999 }))).error, 'learning path not found');
  assert.equal((await ctx.service.createQualification(base({ competencyId: 0 }))).error, 'competencyId must be a positive integer');
  assert.equal((await ctx.service.createQualification(base({ competencyId: 99999 }))).error, 'competency not found');
  assert.equal((await ctx.service.createQualification(base({ roleId: 0 }))).error, 'roleId must be a positive integer');
  ctx.db.close();
});

test('W26Q-SVC-7. createQualification validates type / status / renewal / mandatory / validity / metadata', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createQualification(base({ qualificationType: 'WAT' }))).error, 'invalid qualificationType');
  assert.equal((await ctx.service.createQualification(base({ status: 'WAT' }))).error, 'invalid status');
  assert.equal((await ctx.service.createQualification(base({ renewalRequired: 2 }))).error, 'renewalRequired must be 0 or 1');
  assert.equal((await ctx.service.createQualification(base({ mandatory: 2 }))).error, 'mandatory must be 0 or 1');
  assert.equal((await ctx.service.createQualification(base({ validityMonths: 0 }))).error, 'validityMonths must be a positive integer');
  assert.equal((await ctx.service.createQualification(base({ metadata: 'x' }))).error, 'invalid metadata');
  ctx.db.close();
});

test('W26Q-SVC-8. createQualification validates effective / expiry ordering', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createQualification(base({ effectiveDate: '2026-06-01', expiryDate: '2026-01-01' }))).error, 'expiryDate must be on or after effectiveDate');
  ctx.db.close();
});

test('W26Q-SVC-9. createQualification accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createQualification(base({ metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.qualification.metadata, null);
  ctx.db.close();
});

test('W26Q-SVC-10. createQualification accepts every type and a valid full record', async () => {
  const ctx = await setup();
  for (const t of ['CERTIFICATION', 'LICENSE', 'ACCREDITATION', 'TICKET', 'ENDORSEMENT']) {
    const r = await ctx.service.createQualification(base({ qualificationType: t, validityMonths: 12, status: 'ACTIVE' }));
    assert.equal(r.ok, true, `type ${t}`);
    assert.equal(r.qualification.qualificationType, t);
  }
  ctx.db.close();
});

test('W26Q-SVC-11. updateQualification: not found, name/ref/class errors, ordering, success, non-object patch', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateQualification(9999, { status: 'ACTIVE' })).code, 'NOT_FOUND');
  const c = await ctx.service.createQualification(base({ effectiveDate: '2026-06-01' }));
  const id = c.qualification.id;
  assert.equal((await ctx.service.updateQualification(id, { qualificationName: '  ' })).error, 'qualificationName must be a non-empty string');
  assert.equal((await ctx.service.updateQualification(id, { competencyId: 99999 })).error, 'competency not found');
  assert.equal((await ctx.service.updateQualification(id, { status: 'WAT' })).error, 'invalid status');
  assert.equal((await ctx.service.updateQualification(id, { expiryDate: '2026-01-01' })).error, 'expiryDate must be on or after effectiveDate', 'ordering uses stored effectiveDate');
  const upd = await ctx.service.updateQualification(id, { status: 'ACTIVE', learningPathId: ctx.learningPathId, validityMonths: 36, metadata: { v: 2 } });
  assert.equal(upd.qualification.status, 'ACTIVE');
  assert.equal(upd.qualification.learningPathId, ctx.learningPathId);
  assert.deepEqual(upd.qualification.metadata, { v: 2 });
  assert.equal((await ctx.service.updateQualification(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26Q-SVC-12. getQualification returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createQualification(base({}));
  assert.equal((await ctx.service.getQualification(c.qualification.id)).qualification.qualificationName, 'Forklift Licence');
  assert.equal((await ctx.service.getQualification(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26Q-SVC-13. list by role / learning path / competency; mandatory and active queries', async () => {
  const ctx = await setup();
  await ctx.service.createQualification(base({ roleId: 77, learningPathId: ctx.learningPathId, competencyId: ctx.compId, mandatory: 1 }));
  await ctx.service.createQualification(base({ roleId: 77, learningPathId: ctx.learningPathId, competencyId: ctx.compId, mandatory: 0 }));
  assert.equal((await ctx.service.listRoleQualifications(77)).qualifications.length, 2);
  assert.equal((await ctx.service.listLearningPathQualifications(ctx.learningPathId)).qualifications.length, 2);
  assert.equal((await ctx.service.listCompetencyQualifications(ctx.compId)).qualifications.length, 2);
  assert.equal((await ctx.service.mandatoryQualifications()).qualifications.length, 1);
  assert.equal((await ctx.service.activeQualifications()).qualifications.length, 2);
  ctx.db.close();
});

test('W26Q-SVC-14. archiveQualification: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveQualification(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createQualification(base({}));
  assert.equal((await ctx.service.archiveQualification(c.qualification.id)).qualification.archived, 1);
  assert.equal((await ctx.service.archiveQualification(c.qualification.id)).error, 'qualification already archived');
  ctx.db.close();
});

test('W26Q-SVC-15. deleteQualification then restoreQualification; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteQualification(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreQualification(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createQualification(base({}));
  const id = c.qualification.id;
  assert.deepEqual(await ctx.service.deleteQualification(id), { ok: true, id });
  assert.equal((await ctx.service.getQualification(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreQualification(id)).qualification.deleted, 0);
  ctx.db.close();
});

test('W26Q-SVC-15b. updateQualification toggles renewal/mandatory and re-files the role', async () => {
  const ctx = await setup();
  const c = await ctx.service.createQualification(base({ renewalRequired: 0, mandatory: 0 }));
  const upd = await ctx.service.updateQualification(c.qualification.id, { renewalRequired: 1, mandatory: 1, roleId: 42 });
  assert.equal(upd.ok, true);
  assert.equal(upd.qualification.renewalRequired, 1);
  assert.equal(upd.qualification.mandatory, 1);
  assert.equal(upd.qualification.roleId, 42);
  ctx.db.close();
});

test('W26Q-SVC-16. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const brokenRepo = {}; for (const m of REPO_METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const dep = { findById() {} };
  const boom = new Service(brokenRepo, dep, dep, dep, dep, dep);
  const r = await boom.getQualification(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
