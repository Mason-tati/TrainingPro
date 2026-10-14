// WP-26 · Phase 17 — Enterprise Certification service tests (ephemeral DB; real DI).
// Business rules over the certification repository plus SIX read-only injected repositories
// (qualification, learning path, training program, competency, profile, recertification). A full
// in-memory stack (folder → doc-core → version → competency; a qualification & learning-path row)
// provides real referents. Certification-code uniqueness, qualification/learning-path/competency
// existence, role/authority/renewal rules, issue/expiry ordering, lifecycle, and copy-on-read are
// exercised end to end.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const CMig = require(path.join(EDIR, 'enterprise-certification-migration.js'));
const CRepo = require(path.join(EDIR, 'enterprise-certification-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-certification-service.js'));
const QMig = require(path.join(EDIR, 'enterprise-qualification-migration.js'));
const QRepo = require(path.join(EDIR, 'enterprise-qualification-repository.js'));
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

const REPO_METHODS = ['create', 'update', 'findById', 'findByCertificationCode', 'findByQualification', 'findByLearningPath', 'findByCompetency', 'findByRole', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await CMig.migrate(db); await QMig.migrate(db); await LPMig.migrate(db); await KMig.migrate(db);
  await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const certRepo = new CRepo(db); const qualRepo = new QRepo(db); const lpRepo = new LPRepo(db); const compRepo = new KRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'CT-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const qual = await qualRepo.create({ qualificationCode: 'QL-C', qualificationName: 'Forklift Licence' });
  const lp = await lpRepo.create({ pathCode: 'LP-C', pathName: 'Induction Path' });
  const service = new Service(certRepo, qualRepo, lpRepo, new TPRepo(db), compRepo, new PRepo(db), new RRepo(db));
  return { db, service, compId: comp.competency.id, qualificationId: qual.id, learningPathId: lp.id };
}
let codeSeq = 0;
const base = (over) => Object.assign({ certificationCode: `CT-${(codeSeq += 1)}`, certificationName: 'Forklift Certificate' }, over);

test('W26C-SVC-1. constructor requires qualification, learning-path, training-program, competency, profile, recertification repositories', () => {
  const repo = {}; for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep, dep, dep, dep), /qualification repository/);
  assert.throws(() => new Service(repo, dep, null, dep, dep, dep, dep), /learning path repository/);
  assert.throws(() => new Service(repo, dep, dep, null, dep, dep, dep), /training program repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, null, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, null, dep), /profile repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, dep, null), /recertification repository/);
});

test('W26C-SVC-2. createCertification persists DRAFT defaults and resolves qualification/learning-path/competency + metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createCertification(base({
    qualificationId: ctx.qualificationId, learningPathId: ctx.learningPathId, competencyId: ctx.compId,
    roleId: 3, issuingAuthority: 'WorkSafe', renewalRequired: 1, metadata: { number: 'C-9001' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.certification.status, 'DRAFT');
  assert.equal(r.certification.qualificationId, ctx.qualificationId);
  assert.equal(r.certification.issuingAuthority, 'WorkSafe');
  assert.deepEqual(r.certification.metadata, { number: 'C-9001' });
  ctx.db.close();
});

test('W26C-SVC-3. createCertification allows explicit null references / authority (skips checks)', async () => {
  const ctx = await setup();
  const r = await ctx.service.createCertification(base({ qualificationId: null, learningPathId: null, competencyId: null, issuingAuthority: null }));
  assert.equal(r.ok, true);
  assert.equal(r.certification.qualificationId, null);
  ctx.db.close();
});

test('W26C-SVC-4. createCertification requires code and name, and rejects non-object input', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCertification(base({ certificationCode: '  ' }))).error, 'certificationCode is required');
  assert.equal((await ctx.service.createCertification(base({ certificationName: '' }))).error, 'certificationName is required');
  assert.equal((await ctx.service.createCertification('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26C-SVC-5. createCertification enforces certificationCode uniqueness (CONFLICT)', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCertification({ certificationCode: 'DUP-1', certificationName: 'A' })).ok, true);
  assert.equal((await ctx.service.createCertification({ certificationCode: 'DUP-1', certificationName: 'B' })).code, 'CONFLICT');
  ctx.db.close();
});

test('W26C-SVC-6. createCertification validates qualification / learning-path / competency / role / authority', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCertification(base({ qualificationId: 0 }))).error, 'qualificationId must be a positive integer');
  assert.equal((await ctx.service.createCertification(base({ qualificationId: 99999 }))).error, 'qualification not found');
  assert.equal((await ctx.service.createCertification(base({ learningPathId: 0 }))).error, 'learningPathId must be a positive integer');
  assert.equal((await ctx.service.createCertification(base({ learningPathId: 99999 }))).error, 'learning path not found');
  assert.equal((await ctx.service.createCertification(base({ competencyId: 0 }))).error, 'competencyId must be a positive integer');
  assert.equal((await ctx.service.createCertification(base({ competencyId: 99999 }))).error, 'competency not found');
  assert.equal((await ctx.service.createCertification(base({ roleId: 0 }))).error, 'roleId must be a positive integer');
  assert.equal((await ctx.service.createCertification(base({ issuingAuthority: '  ' }))).error, 'issuingAuthority must be a non-empty string');
  ctx.db.close();
});

test('W26C-SVC-7. createCertification validates status / renewal / metadata', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCertification(base({ status: 'WAT' }))).error, 'invalid status');
  assert.equal((await ctx.service.createCertification(base({ renewalRequired: 2 }))).error, 'renewalRequired must be 0 or 1');
  assert.equal((await ctx.service.createCertification(base({ metadata: 'x' }))).error, 'invalid metadata');
  ctx.db.close();
});

test('W26C-SVC-8. createCertification validates issue / expiry ordering', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCertification(base({ issueDate: '2026-06-01', expiryDate: '2026-01-01' }))).error, 'expiryDate must be on or after issueDate');
  ctx.db.close();
});

test('W26C-SVC-9. createCertification accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createCertification(base({ metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.certification.metadata, null);
  ctx.db.close();
});

test('W26C-SVC-10. createCertification accepts every status value', async () => {
  const ctx = await setup();
  for (const s of ['DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED']) {
    const r = await ctx.service.createCertification(base({ status: s }));
    assert.equal(r.ok, true, `status ${s}`);
    assert.equal(r.certification.status, s);
  }
  ctx.db.close();
});

test('W26C-SVC-11. updateCertification: not found, name/ref/class errors, ordering, success, non-object patch', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateCertification(9999, { status: 'ACTIVE' })).code, 'NOT_FOUND');
  const c = await ctx.service.createCertification(base({ issueDate: '2026-06-01' }));
  const id = c.certification.id;
  assert.equal((await ctx.service.updateCertification(id, { certificationName: '  ' })).error, 'certificationName must be a non-empty string');
  assert.equal((await ctx.service.updateCertification(id, { qualificationId: 99999 })).error, 'qualification not found');
  assert.equal((await ctx.service.updateCertification(id, { status: 'WAT' })).error, 'invalid status');
  assert.equal((await ctx.service.updateCertification(id, { expiryDate: '2026-01-01' })).error, 'expiryDate must be on or after issueDate', 'ordering uses stored issueDate');
  const upd = await ctx.service.updateCertification(id, { status: 'ACTIVE', qualificationId: ctx.qualificationId, issuingAuthority: 'RTO-9', metadata: { v: 2 } });
  assert.equal(upd.certification.status, 'ACTIVE');
  assert.equal(upd.certification.qualificationId, ctx.qualificationId);
  assert.deepEqual(upd.certification.metadata, { v: 2 });
  assert.equal((await ctx.service.updateCertification(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26C-SVC-12. getCertification returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createCertification(base({}));
  assert.equal((await ctx.service.getCertification(c.certification.id)).certification.certificationName, 'Forklift Certificate');
  assert.equal((await ctx.service.getCertification(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26C-SVC-13. list by role / qualification / learning path / competency; active query', async () => {
  const ctx = await setup();
  await ctx.service.createCertification(base({ roleId: 77, qualificationId: ctx.qualificationId, learningPathId: ctx.learningPathId, competencyId: ctx.compId }));
  await ctx.service.createCertification(base({ roleId: 77, qualificationId: ctx.qualificationId, learningPathId: ctx.learningPathId, competencyId: ctx.compId }));
  assert.equal((await ctx.service.listRoleCertifications(77)).certifications.length, 2);
  assert.equal((await ctx.service.listQualificationCertifications(ctx.qualificationId)).certifications.length, 2);
  assert.equal((await ctx.service.listLearningPathCertifications(ctx.learningPathId)).certifications.length, 2);
  assert.equal((await ctx.service.listCompetencyCertifications(ctx.compId)).certifications.length, 2);
  assert.equal((await ctx.service.activeCertifications()).certifications.length, 2);
  ctx.db.close();
});

test('W26C-SVC-14. archiveCertification: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveCertification(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createCertification(base({}));
  assert.equal((await ctx.service.archiveCertification(c.certification.id)).certification.archived, 1);
  assert.equal((await ctx.service.archiveCertification(c.certification.id)).error, 'certification already archived');
  ctx.db.close();
});

test('W26C-SVC-15. deleteCertification then restoreCertification; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteCertification(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreCertification(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createCertification(base({}));
  const id = c.certification.id;
  assert.deepEqual(await ctx.service.deleteCertification(id), { ok: true, id });
  assert.equal((await ctx.service.getCertification(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreCertification(id)).certification.deleted, 0);
  ctx.db.close();
});

test('W26C-SVC-15b. updateCertification re-files valid learning-path/competency and toggles renewal', async () => {
  const ctx = await setup();
  const c = await ctx.service.createCertification(base({ renewalRequired: 0 }));
  const upd = await ctx.service.updateCertification(c.certification.id, { learningPathId: ctx.learningPathId, competencyId: ctx.compId, renewalRequired: 1, roleId: 42 });
  assert.equal(upd.ok, true);
  assert.equal(upd.certification.learningPathId, ctx.learningPathId);
  assert.equal(upd.certification.competencyId, ctx.compId);
  assert.equal(upd.certification.renewalRequired, 1);
  assert.equal(upd.certification.roleId, 42);
  ctx.db.close();
});

test('W26C-SVC-16. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const brokenRepo = {}; for (const m of REPO_METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const dep = { findById() {} };
  const boom = new Service(brokenRepo, dep, dep, dep, dep, dep, dep);
  const r = await boom.getCertification(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
