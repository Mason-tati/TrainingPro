// WP-26 · Phase 12 — Enterprise Employee Competency Profile service tests (ephemeral DB; real DI).
// Business rules over the profile repository plus FOUR read-only injected repositories (competency,
// assessment, mapping, evidence). A full in-memory stack (folder → doc-core → version → competency +
// assessment → mapping → evidence) provides real referents so existence validation, classification /
// compliance / risk rules, expiry & review ordering, uniqueness, lifecycle, and copy-on-read are
// exercised end to end. Expiry windows are stamped relative to the DB clock for determinism.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const PMig = require(path.join(EDIR, 'enterprise-employee-competency-profile-migration.js'));
const PRepo = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-employee-competency-profile-service.js'));
const EMig = require(path.join(EDIR, 'enterprise-competency-evidence-migration.js'));
const ERepo = require(path.join(EDIR, 'enterprise-competency-evidence-repository.js'));
const ESvc = require(path.join(EDIR, 'enterprise-competency-evidence-service.js'));
const MMig = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-migration.js'));
const MRepo = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-repository.js'));
const MSvc = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-service.js'));
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

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await PMig.migrate(db); await EMig.migrate(db); await MMig.migrate(db); await KMig.migrate(db);
  await SMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const profRepo = new PRepo(db); const evRepo = new ERepo(db); const mapRepo = new MRepo(db);
  const compRepo = new KRepo(db); const assRepo = new SRepo(db); const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'PR-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const ass = await new SSvc(assRepo, verRepo).createAssessment({ documentVersionId: ver.version.id, assessmentId: 200, assessmentCode: 'A-1', assessmentTitle: 'Q1' });
  const map = await new MSvc(mapRepo, compRepo, assRepo).createMapping({ competencyId: comp.competency.id, assessmentId: ass.assessment.id });
  const ev = await new ESvc(evRepo, compRepo, assRepo, mapRepo).createEvidence({ competencyId: comp.competency.id, assessmentId: ass.assessment.id, mappingId: map.mapping.id, employeeId: 500, evidenceTitle: 'Cert' });
  const service = new Service(profRepo, compRepo, assRepo, mapRepo, evRepo);
  return { db, service, compId: comp.competency.id, assId: ass.assessment.id, mapId: map.mapping.id, evId: ev.evidence.id };
}
const base = (ctx, over) => Object.assign({ employeeId: 500, competencyId: ctx.compId }, over);
function stampExpiry(db, id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseEmployeeCompetencyProfile SET expiryDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}

test('W26P-SVC-1. constructor requires competency, assessment, mapping, and evidence repositories', () => {
  const REPO_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findCompliant', 'findNonCompliant', 'findExpiring', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
  const repo = {}; for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, null, dep, dep), /assessment repository/);
  assert.throws(() => new Service(repo, dep, dep, null, dep), /mapping repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, null), /evidence repository/);
});

test('W26P-SVC-2. createProfile persists defaults and resolves all current references + metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createProfile(base(ctx, {
    currentAssessmentId: ctx.assId, currentMappingId: ctx.mapId, currentEvidenceId: ctx.evId,
    status: 'ACHIEVED', riskLevel: 'MEDIUM', complianceStatus: 'COMPLIANT', metadata: { source: 'audit' },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.profile.employeeId, 500);
  assert.equal(r.profile.competencyId, ctx.compId);
  assert.equal(r.profile.currentEvidenceId, ctx.evId);
  assert.equal(r.profile.status, 'ACHIEVED');
  assert.deepEqual(r.profile.metadata, { source: 'audit' });
  ctx.db.close();
});

test('W26P-SVC-3. createProfile defaults status/risk/compliance when omitted', async () => {
  const ctx = await setup();
  const r = await ctx.service.createProfile(base(ctx, {}));
  assert.equal(r.profile.status, 'NOT_STARTED');
  assert.equal(r.profile.riskLevel, 'LOW');
  assert.equal(r.profile.complianceStatus, 'PENDING');
  ctx.db.close();
});

test('W26P-SVC-4. createProfile rejects missing employeeId / competencyId and non-object input', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProfile(base(ctx, { employeeId: 0 }))).error, 'employeeId is required');
  assert.equal((await ctx.service.createProfile(base(ctx, { competencyId: 0 }))).error, 'competencyId is required');
  assert.equal((await ctx.service.createProfile('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26P-SVC-5. createProfile validates competency existence', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProfile(base(ctx, { competencyId: 99999 }))).error, 'competency not found');
  ctx.db.close();
});

test('W26P-SVC-6. createProfile validates existence of current assessment / mapping / evidence references', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProfile(base(ctx, { currentAssessmentId: 0 }))).error, 'currentAssessmentId must be a positive integer');
  assert.equal((await ctx.service.createProfile(base(ctx, { currentAssessmentId: 99999 }))).error, 'assessment not found');
  assert.equal((await ctx.service.createProfile(base(ctx, { currentMappingId: 0 }))).error, 'currentMappingId must be a positive integer');
  assert.equal((await ctx.service.createProfile(base(ctx, { currentMappingId: 99999 }))).error, 'mapping not found');
  assert.equal((await ctx.service.createProfile(base(ctx, { currentEvidenceId: 0 }))).error, 'currentEvidenceId must be a positive integer');
  assert.equal((await ctx.service.createProfile(base(ctx, { currentEvidenceId: 99999 }))).error, 'evidence not found');
  ctx.db.close();
});

test('W26P-SVC-7. createProfile validates status, riskLevel, complianceStatus, metadata', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProfile(base(ctx, { status: 'WAT' }))).error, 'invalid status');
  assert.equal((await ctx.service.createProfile(base(ctx, { riskLevel: 'EXTREME' }))).error, 'invalid riskLevel');
  assert.equal((await ctx.service.createProfile(base(ctx, { complianceStatus: 'PARTIAL' }))).error, 'invalid complianceStatus');
  assert.equal((await ctx.service.createProfile(base(ctx, { metadata: 'x' }))).error, 'invalid metadata');
  ctx.db.close();
});

test('W26P-SVC-8. createProfile validates expiry / next-review ordering', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProfile(base(ctx, { achievedDate: '2026-06-01', expiryDate: '2026-01-01' }))).error, 'expiryDate must be on or after achievedDate');
  assert.equal((await ctx.service.createProfile(base(ctx, { achievedDate: '2026-06-01', nextReviewDate: '2026-01-01' }))).error, 'nextReviewDate must be on or after achievedDate');
  ctx.db.close();
});

test('W26P-SVC-9. createProfile enforces one profile per employee×competency (CONFLICT)', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createProfile(base(ctx, {}))).ok, true);
  assert.equal((await ctx.service.createProfile(base(ctx, {}))).code, 'CONFLICT');
  ctx.db.close();
});

test('W26P-SVC-10. createProfile accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createProfile(base(ctx, { metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.profile.metadata, null);
  ctx.db.close();
});

test('W26P-SVC-11. updateProfile: not found, ref/class errors, ordering, success, non-object patch', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateProfile(9999, { status: 'ACHIEVED' })).code, 'NOT_FOUND');
  const c = await ctx.service.createProfile(base(ctx, { achievedDate: '2026-06-01' }));
  const id = c.profile.id;
  assert.equal((await ctx.service.updateProfile(id, { currentEvidenceId: 99999 })).error, 'evidence not found');
  assert.equal((await ctx.service.updateProfile(id, { status: 'WAT' })).error, 'invalid status');
  assert.equal((await ctx.service.updateProfile(id, { expiryDate: '2026-01-01' })).error, 'expiryDate must be on or after achievedDate', 'ordering uses stored achievedDate');
  assert.equal((await ctx.service.updateProfile(id, { nextReviewDate: '2026-01-01' })).error, 'nextReviewDate must be on or after achievedDate');
  const upd = await ctx.service.updateProfile(id, { status: 'ACHIEVED', complianceStatus: 'COMPLIANT', currentEvidenceId: ctx.evId, metadata: { v: 2 } });
  assert.equal(upd.profile.status, 'ACHIEVED');
  assert.deepEqual(upd.profile.metadata, { v: 2 });
  assert.equal((await ctx.service.updateProfile(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26P-SVC-12. getProfile returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createProfile(base(ctx, {}));
  assert.equal((await ctx.service.getProfile(c.profile.id)).profile.employeeId, 500);
  assert.equal((await ctx.service.getProfile(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26P-SVC-13. list by employee and by competency', async () => {
  const ctx = await setup();
  await ctx.service.createProfile(base(ctx, { employeeId: 501 }));
  await ctx.service.createProfile(base(ctx, { employeeId: 502 }));
  assert.equal((await ctx.service.listEmployeeProfiles(501)).profiles.length, 1);
  assert.equal((await ctx.service.listCompetencyProfiles(ctx.compId)).profiles.length, 2);
  ctx.db.close();
});

test('W26P-SVC-14. compliant / non-compliant / expiring / expired / active queries', async () => {
  const ctx = await setup();
  const a = await ctx.service.createProfile(base(ctx, { employeeId: 601, complianceStatus: 'COMPLIANT' }));
  await ctx.service.createProfile(base(ctx, { employeeId: 602, complianceStatus: 'NON_COMPLIANT' }));
  const soon = await ctx.service.createProfile(base(ctx, { employeeId: 603 }));
  const past = await ctx.service.createProfile(base(ctx, { employeeId: 604 }));
  await stampExpiry(ctx.db, soon.profile.id, '+5 days');
  await stampExpiry(ctx.db, past.profile.id, '-5 days');
  assert.equal((await ctx.service.compliantProfiles()).profiles.length, 1);
  assert.equal((await ctx.service.nonCompliantProfiles()).profiles.length, 1);
  assert.equal((await ctx.service.expiringProfiles(30)).profiles.length, 1);
  assert.equal((await ctx.service.expiringProfiles()).profiles.length, 1, 'default window');
  assert.equal((await ctx.service.expiredProfiles()).profiles.length, 1);
  assert.equal((await ctx.service.activeProfiles()).profiles.length, 4);
  assert.ok(a.ok);
  ctx.db.close();
});

test('W26P-SVC-15. archiveProfile: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveProfile(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createProfile(base(ctx, {}));
  assert.equal((await ctx.service.archiveProfile(c.profile.id)).profile.archived, 1);
  assert.equal((await ctx.service.archiveProfile(c.profile.id)).error, 'profile already archived');
  ctx.db.close();
});

test('W26P-SVC-16. deleteProfile then restoreProfile; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteProfile(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreProfile(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createProfile(base(ctx, {}));
  const id = c.profile.id;
  assert.deepEqual(await ctx.service.deleteProfile(id), { ok: true, id });
  assert.equal((await ctx.service.getProfile(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreProfile(id)).profile.deleted, 0);
  ctx.db.close();
});

test('W26P-SVC-17. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const REPO_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findCompliant', 'findNonCompliant', 'findExpiring', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
  const brokenRepo = {}; for (const m of REPO_METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const boom = new Service(brokenRepo, { findById() {} }, { findById() {} }, { findById() {} }, { findById() {} });
  const r = await boom.getProfile(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
