// WP-26 · Phase 18 (FINAL) — Enterprise Compliance service tests (ephemeral DB; real DI).
// Business rules over the compliance repository plus SEVEN read-only injected repositories (certification,
// qualification, learning path, training program, competency, profile, recertification). A full in-memory
// stack (folder → doc-core → version → competency; qualification / learning-path / certification rows)
// provides real referents. Employee validation, reference existence, classification, expiry ordering, the
// derived overdue calculation, lifecycle, and copy-on-read are exercised end to end. Expiry is stamped
// relative to the DB clock for determinism.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const XMig = require(path.join(EDIR, 'enterprise-compliance-migration.js'));
const XRepo = require(path.join(EDIR, 'enterprise-compliance-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-compliance-service.js'));
const CTMig = require(path.join(EDIR, 'enterprise-certification-migration.js'));
const CTRepo = require(path.join(EDIR, 'enterprise-certification-repository.js'));
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

const REPO_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByRole', 'findByQualification', 'findByCertification', 'findByLearningPath', 'findByCompetency', 'findCompliant', 'findNonCompliant', 'findExpired', 'findOverdue', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await XMig.migrate(db); await CTMig.migrate(db); await QMig.migrate(db); await LPMig.migrate(db);
  await KMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const xRepo = new XRepo(db); const certRepo = new CTRepo(db); const qualRepo = new QRepo(db); const lpRepo = new LPRepo(db); const compRepo = new KRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'CO-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const qual = await qualRepo.create({ qualificationCode: 'QL-X', qualificationName: 'Forklift Licence' });
  const lp = await lpRepo.create({ pathCode: 'LP-X', pathName: 'Induction Path' });
  const cert = await certRepo.create({ certificationCode: 'CT-X', certificationName: 'Forklift Certificate' });
  const service = new Service(xRepo, certRepo, qualRepo, lpRepo, new TPRepo(db), compRepo, new PRepo(db), new RRepo(db));
  return { db, service, compId: comp.competency.id, qualificationId: qual.id, learningPathId: lp.id, certificationId: cert.id };
}
const base = (over) => Object.assign({ employeeId: 500 }, over);
function stampExpiry(db, id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseCompliance SET expiryDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}

test('W26X-SVC-1. constructor requires all seven read-only repositories', () => {
  const repo = {}; for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep, dep, dep, dep, dep), /certification repository/);
  assert.throws(() => new Service(repo, dep, null, dep, dep, dep, dep, dep), /qualification repository/);
  assert.throws(() => new Service(repo, dep, dep, null, dep, dep, dep, dep), /learning path repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, null, dep, dep, dep), /training program repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, null, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, dep, null, dep), /profile repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, dep, dep, null), /recertification repository/);
});

test('W26X-SVC-2. createCompliance persists PENDING/LOW defaults and resolves all references + metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createCompliance(base({
    roleId: 3, certificationId: ctx.certificationId, qualificationId: ctx.qualificationId,
    learningPathId: ctx.learningPathId, competencyId: ctx.compId, riskLevel: 'MEDIUM', metadata: { audit: 'Q3' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.compliance.complianceStatus, 'PENDING');
  assert.equal(r.compliance.riskLevel, 'MEDIUM');
  assert.equal(r.compliance.overdue, 0, 'PENDING is not overdue');
  assert.equal(r.compliance.certificationId, ctx.certificationId);
  assert.deepEqual(r.compliance.metadata, { audit: 'Q3' });
  ctx.db.close();
});

test('W26X-SVC-3. createCompliance allows explicit null references (skips existence checks)', async () => {
  const ctx = await setup();
  const r = await ctx.service.createCompliance(base({ certificationId: null, qualificationId: null, learningPathId: null, competencyId: null }));
  assert.equal(r.ok, true);
  assert.equal(r.compliance.certificationId, null);
  ctx.db.close();
});

test('W26X-SVC-4. createCompliance requires employeeId and rejects non-object input', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCompliance(base({ employeeId: 0 }))).error, 'employeeId is required');
  assert.equal((await ctx.service.createCompliance('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26X-SVC-5. createCompliance validates certification / qualification / learning-path / competency / role references', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCompliance(base({ certificationId: 0 }))).error, 'certificationId must be a positive integer');
  assert.equal((await ctx.service.createCompliance(base({ certificationId: 99999 }))).error, 'certification not found');
  assert.equal((await ctx.service.createCompliance(base({ qualificationId: 0 }))).error, 'qualificationId must be a positive integer');
  assert.equal((await ctx.service.createCompliance(base({ qualificationId: 99999 }))).error, 'qualification not found');
  assert.equal((await ctx.service.createCompliance(base({ learningPathId: 0 }))).error, 'learningPathId must be a positive integer');
  assert.equal((await ctx.service.createCompliance(base({ learningPathId: 99999 }))).error, 'learning path not found');
  assert.equal((await ctx.service.createCompliance(base({ competencyId: 0 }))).error, 'competencyId must be a positive integer');
  assert.equal((await ctx.service.createCompliance(base({ competencyId: 99999 }))).error, 'competency not found');
  assert.equal((await ctx.service.createCompliance(base({ roleId: 0 }))).error, 'roleId must be a positive integer');
  ctx.db.close();
});

test('W26X-SVC-6. createCompliance validates status / risk / renewal / metadata', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCompliance(base({ complianceStatus: 'WAT' }))).error, 'invalid complianceStatus');
  assert.equal((await ctx.service.createCompliance(base({ riskLevel: 'EXTREME' }))).error, 'invalid riskLevel');
  assert.equal((await ctx.service.createCompliance(base({ renewalRequired: 2 }))).error, 'renewalRequired must be 0 or 1');
  assert.equal((await ctx.service.createCompliance(base({ metadata: 'x' }))).error, 'invalid metadata');
  ctx.db.close();
});

test('W26X-SVC-7. createCompliance validates compliant / expiry ordering', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCompliance(base({ compliantDate: '2026-06-01', expiryDate: '2026-01-01' }))).error, 'expiryDate must be on or after compliantDate');
  ctx.db.close();
});

test('W26X-SVC-8. overdue is derived from status: NON_COMPLIANT and EXPIRED are overdue; COMPLIANT / PENDING are not', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createCompliance(base({ complianceStatus: 'NON_COMPLIANT' }))).compliance.overdue, 1);
  assert.equal((await ctx.service.createCompliance(base({ complianceStatus: 'EXPIRED' }))).compliance.overdue, 1);
  assert.equal((await ctx.service.createCompliance(base({ complianceStatus: 'COMPLIANT' }))).compliance.overdue, 0);
  assert.equal((await ctx.service.createCompliance(base({ complianceStatus: 'EXEMPT' }))).compliance.overdue, 0);
  ctx.db.close();
});

test('W26X-SVC-9. createCompliance accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createCompliance(base({ metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.compliance.metadata, null);
  ctx.db.close();
});

test('W26X-SVC-10. updateCompliance: not found, ref/class errors, ordering, success, non-object patch', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateCompliance(9999, { complianceStatus: 'COMPLIANT' })).code, 'NOT_FOUND');
  const c = await ctx.service.createCompliance(base({ compliantDate: '2026-06-01' }));
  const id = c.compliance.id;
  assert.equal((await ctx.service.updateCompliance(id, { certificationId: 99999 })).error, 'certification not found');
  assert.equal((await ctx.service.updateCompliance(id, { complianceStatus: 'WAT' })).error, 'invalid complianceStatus');
  assert.equal((await ctx.service.updateCompliance(id, { expiryDate: '2026-01-01' })).error, 'expiryDate must be on or after compliantDate', 'ordering uses stored compliantDate');
  const upd = await ctx.service.updateCompliance(id, { complianceStatus: 'COMPLIANT', riskLevel: 'HIGH', metadata: { v: 2 } });
  assert.equal(upd.compliance.complianceStatus, 'COMPLIANT');
  assert.deepEqual(upd.compliance.metadata, { v: 2 });
  assert.equal((await ctx.service.updateCompliance(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26X-SVC-11. updateCompliance recomputes overdue from the effective status (patch and stored)', async () => {
  const ctx = await setup();
  const c = await ctx.service.createCompliance(base({ complianceStatus: 'COMPLIANT' }));
  const id = c.compliance.id;
  assert.equal((await ctx.service.updateCompliance(id, { complianceStatus: 'NON_COMPLIANT' })).compliance.overdue, 1, 'patch status → overdue');
  assert.equal((await ctx.service.updateCompliance(id, { riskLevel: 'HIGH' })).compliance.overdue, 1, 'stored NON_COMPLIANT keeps overdue');
  assert.equal((await ctx.service.updateCompliance(id, { complianceStatus: 'COMPLIANT' })).compliance.overdue, 0, 'back to compliant clears overdue');
  ctx.db.close();
});

test('W26X-SVC-12. getCompliance returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createCompliance(base({}));
  assert.equal((await ctx.service.getCompliance(c.compliance.id)).compliance.employeeId, 500);
  assert.equal((await ctx.service.getCompliance(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26X-SVC-13. list by employee / role / qualification / certification / learning path / competency', async () => {
  const ctx = await setup();
  await ctx.service.createCompliance(base({ employeeId: 601, roleId: 9, qualificationId: ctx.qualificationId, certificationId: ctx.certificationId, learningPathId: ctx.learningPathId, competencyId: ctx.compId }));
  assert.equal((await ctx.service.listEmployeeCompliance(601)).compliance.length, 1);
  assert.equal((await ctx.service.listRoleCompliance(9)).compliance.length, 1);
  assert.equal((await ctx.service.listQualificationCompliance(ctx.qualificationId)).compliance.length, 1);
  assert.equal((await ctx.service.listCertificationCompliance(ctx.certificationId)).compliance.length, 1);
  assert.equal((await ctx.service.listLearningPathCompliance(ctx.learningPathId)).compliance.length, 1);
  assert.equal((await ctx.service.listCompetencyCompliance(ctx.compId)).compliance.length, 1);
  ctx.db.close();
});

test('W26X-SVC-14. compliant / non-compliant / expired / overdue queries', async () => {
  const ctx = await setup();
  await ctx.service.createCompliance(base({ employeeId: 701, complianceStatus: 'COMPLIANT' }));
  await ctx.service.createCompliance(base({ employeeId: 702, complianceStatus: 'NON_COMPLIANT' })); // overdue derived
  const exp = await ctx.service.createCompliance(base({ employeeId: 703 }));
  await stampExpiry(ctx.db, exp.compliance.id, '-5 days');
  assert.equal((await ctx.service.compliantRecords()).compliance.length, 1);
  assert.equal((await ctx.service.nonCompliantRecords()).compliance.length, 1);
  assert.equal((await ctx.service.overdueRecords()).compliance.length, 1, 'the NON_COMPLIANT one');
  assert.equal((await ctx.service.expiredRecords()).compliance.length, 1, 'the past-dated one');
  ctx.db.close();
});

test('W26X-SVC-15. archiveCompliance: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveCompliance(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createCompliance(base({}));
  assert.equal((await ctx.service.archiveCompliance(c.compliance.id)).compliance.archived, 1);
  assert.equal((await ctx.service.archiveCompliance(c.compliance.id)).error, 'compliance record already archived');
  ctx.db.close();
});

test('W26X-SVC-16. deleteCompliance then restoreCompliance; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteCompliance(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreCompliance(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createCompliance(base({}));
  const id = c.compliance.id;
  assert.deepEqual(await ctx.service.deleteCompliance(id), { ok: true, id });
  assert.equal((await ctx.service.getCompliance(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreCompliance(id)).compliance.deleted, 0);
  ctx.db.close();
});

test('W26X-SVC-17. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const brokenRepo = {}; for (const m of REPO_METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const dep = { findById() {} };
  const boom = new Service(brokenRepo, dep, dep, dep, dep, dep, dep, dep);
  const r = await boom.getCompliance(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
