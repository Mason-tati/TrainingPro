// WP-26 · Phase 13 — Enterprise Competency Recertification service tests (ephemeral DB; real DI).
// Business rules over the recertification repository plus FIVE read-only injected repositories (profile,
// competency, assessment, mapping, evidence). A full in-memory stack (folder → doc-core → version →
// competency + assessment → mapping → evidence → profile) provides real referents so existence
// validation, the type/status/result rules, the scheduling & completion workflow, overdue logic,
// lifecycle, and copy-on-read are exercised end to end. Due dates are stamped relative to the DB clock.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const RMig = require(path.join(EDIR, 'enterprise-competency-recertification-migration.js'));
const RRepo = require(path.join(EDIR, 'enterprise-competency-recertification-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-competency-recertification-service.js'));
const PMig = require(path.join(EDIR, 'enterprise-employee-competency-profile-migration.js'));
const PRepo = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));
const PSvc = require(path.join(EDIR, 'enterprise-employee-competency-profile-service.js'));
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

const REPO_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findDue', 'findScheduled', 'findCompleted', 'findOverdue', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function setup() {
  const db = new sqlite3.Database(':memory:');
  await RMig.migrate(db); await PMig.migrate(db); await EMig.migrate(db); await MMig.migrate(db);
  await KMig.migrate(db); await SMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const recertRepo = new RRepo(db); const profRepo = new PRepo(db); const evRepo = new ERepo(db);
  const mapRepo = new MRepo(db); const compRepo = new KRepo(db); const assRepo = new SRepo(db); const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'RC-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const ass = await new SSvc(assRepo, verRepo).createAssessment({ documentVersionId: ver.version.id, assessmentId: 200, assessmentCode: 'A-1', assessmentTitle: 'Q1' });
  const map = await new MSvc(mapRepo, compRepo, assRepo).createMapping({ competencyId: comp.competency.id, assessmentId: ass.assessment.id });
  const ev = await new ESvc(evRepo, compRepo, assRepo, mapRepo).createEvidence({ competencyId: comp.competency.id, assessmentId: ass.assessment.id, mappingId: map.mapping.id, employeeId: 500, evidenceTitle: 'Cert' });
  const prof = await new PSvc(profRepo, compRepo, assRepo, mapRepo, evRepo).createProfile({ employeeId: 500, competencyId: comp.competency.id });
  const service = new Service(recertRepo, profRepo, compRepo, assRepo, mapRepo, evRepo);
  return { db, service, profileId: prof.profile.id, compId: comp.competency.id, assId: ass.assessment.id, mapId: map.mapping.id, evId: ev.evidence.id };
}
const base = (ctx, over) => Object.assign({ employeeProfileId: ctx.profileId, employeeId: 500, competencyId: ctx.compId, dueDate: '2027-01-01' }, over);
function stampDue(db, id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseCompetencyRecertification SET dueDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}

test('W26R-SVC-1. constructor requires profile, competency, assessment, mapping, and evidence repositories', () => {
  const repo = {}; for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep, dep, dep), /profile repository/);
  assert.throws(() => new Service(repo, dep, null, dep, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, dep, null, dep, dep), /assessment repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, null, dep), /mapping repository/);
  assert.throws(() => new Service(repo, dep, dep, dep, dep, null), /evidence repository/);
});

test('W26R-SVC-2. createRecertification persists PENDING defaults and resolves references + metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createRecertification(base(ctx, {
    currentAssessmentId: ctx.assId, currentMappingId: ctx.mapId, currentEvidenceId: ctx.evId,
    recertificationType: 'REGULATORY', assignedTrainerId: 11, assignedAssessorId: 12, metadata: { cycle: 3 },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.recertification.employeeProfileId, ctx.profileId);
  assert.equal(r.recertification.status, 'PENDING');
  assert.equal(r.recertification.recertificationType, 'REGULATORY');
  assert.equal(r.recertification.currentEvidenceId, ctx.evId);
  assert.deepEqual(r.recertification.metadata, { cycle: 3 });
  ctx.db.close();
});

test('W26R-SVC-3. createRecertification rejects missing ids, dueDate, and non-object input', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createRecertification(base(ctx, { employeeProfileId: 0 }))).error, 'employeeProfileId is required');
  assert.equal((await ctx.service.createRecertification(base(ctx, { competencyId: 0 }))).error, 'competencyId is required');
  assert.equal((await ctx.service.createRecertification(base(ctx, { employeeId: 0 }))).error, 'employeeId is required');
  assert.equal((await ctx.service.createRecertification(base(ctx, { dueDate: '   ' }))).error, 'dueDate is required');
  assert.equal((await ctx.service.createRecertification('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26R-SVC-4. createRecertification validates profile and competency existence', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createRecertification(base(ctx, { employeeProfileId: 99999 }))).error, 'employee competency profile not found');
  assert.equal((await ctx.service.createRecertification(base(ctx, { competencyId: 99999 }))).error, 'competency not found');
  ctx.db.close();
});

test('W26R-SVC-5. createRecertification validates existence of current assessment / mapping / evidence', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createRecertification(base(ctx, { currentAssessmentId: 0 }))).error, 'currentAssessmentId must be a positive integer');
  assert.equal((await ctx.service.createRecertification(base(ctx, { currentAssessmentId: 99999 }))).error, 'assessment not found');
  assert.equal((await ctx.service.createRecertification(base(ctx, { currentMappingId: 0 }))).error, 'currentMappingId must be a positive integer');
  assert.equal((await ctx.service.createRecertification(base(ctx, { currentMappingId: 99999 }))).error, 'mapping not found');
  assert.equal((await ctx.service.createRecertification(base(ctx, { currentEvidenceId: 0 }))).error, 'currentEvidenceId must be a positive integer');
  assert.equal((await ctx.service.createRecertification(base(ctx, { currentEvidenceId: 99999 }))).error, 'evidence not found');
  ctx.db.close();
});

test('W26R-SVC-6. createRecertification validates type / status / result / assignees / metadata', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createRecertification(base(ctx, { recertificationType: 'WAT' }))).error, 'invalid recertificationType');
  assert.equal((await ctx.service.createRecertification(base(ctx, { status: 'WAT' }))).error, 'invalid status');
  assert.equal((await ctx.service.createRecertification(base(ctx, { status: 'COMPLETED', completedDate: '2026-01-01', result: 'MAYBE' }))).error, 'invalid result');
  assert.equal((await ctx.service.createRecertification(base(ctx, { assignedTrainerId: 0 }))).error, 'assignedTrainerId must be a positive integer');
  assert.equal((await ctx.service.createRecertification(base(ctx, { assignedAssessorId: 0 }))).error, 'assignedAssessorId must be a positive integer');
  assert.equal((await ctx.service.createRecertification(base(ctx, { metadata: 'x' }))).error, 'invalid metadata');
  ctx.db.close();
});

test('W26R-SVC-7. createRecertification enforces the scheduling/completion workflow', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createRecertification(base(ctx, { status: 'SCHEDULED' }))).error, 'scheduledDate is required when status is SCHEDULED');
  assert.equal((await ctx.service.createRecertification(base(ctx, { status: 'COMPLETED' }))).error, 'completedDate is required when status is COMPLETED');
  assert.equal((await ctx.service.createRecertification(base(ctx, { status: 'COMPLETED', completedDate: '2026-06-01' }))).error, 'result is required when status is COMPLETED');
  assert.equal((await ctx.service.createRecertification(base(ctx, { result: 'PASS' }))).error, 'result requires status COMPLETED');
  assert.equal((await ctx.service.createRecertification(base(ctx, { status: 'COMPLETED', scheduledDate: '2026-06-01', completedDate: '2026-01-01', result: 'PASS' }))).error, 'completedDate must be on or after scheduledDate');
  ctx.db.close();
});

test('W26R-SVC-8. createRecertification accepts a valid SCHEDULED and a valid COMPLETED record', async () => {
  const ctx = await setup();
  const sched = await ctx.service.createRecertification(base(ctx, { status: 'SCHEDULED', scheduledDate: '2026-12-01' }));
  assert.equal(sched.recertification.status, 'SCHEDULED');
  const done = await ctx.service.createRecertification(base(ctx, { competencyId: ctx.compId, status: 'COMPLETED', scheduledDate: '2026-01-01', completedDate: '2026-06-01', result: 'PASS' }));
  assert.equal(done.recertification.status, 'COMPLETED');
  assert.equal(done.recertification.result, 'PASS');
  ctx.db.close();
});

test('W26R-SVC-9. createRecertification accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createRecertification(base(ctx, { metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.recertification.metadata, null);
  ctx.db.close();
});

test('W26R-SVC-10. updateRecertification: not found, ref/enum/dueDate errors, and a successful edit', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateRecertification(9999, { status: 'SCHEDULED' })).code, 'NOT_FOUND');
  const c = await ctx.service.createRecertification(base(ctx, {}));
  const id = c.recertification.id;
  assert.equal((await ctx.service.updateRecertification(id, { currentEvidenceId: 99999 })).error, 'evidence not found');
  assert.equal((await ctx.service.updateRecertification(id, { status: 'WAT' })).error, 'invalid status');
  assert.equal((await ctx.service.updateRecertification(id, { dueDate: '' })).error, 'dueDate must be a non-empty string');
  const upd = await ctx.service.updateRecertification(id, { recertificationType: 'REMEDIAL', comments: 'reassigned', metadata: { n: 1 } });
  assert.equal(upd.recertification.recertificationType, 'REMEDIAL');
  assert.deepEqual(upd.recertification.metadata, { n: 1 });
  assert.equal((await ctx.service.updateRecertification(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26R-SVC-11. updateRecertification enforces the workflow against the merged (current+patch) state', async () => {
  const ctx = await setup();
  const c = await ctx.service.createRecertification(base(ctx, {}));
  const id = c.recertification.id;
  assert.equal((await ctx.service.updateRecertification(id, { status: 'COMPLETED' })).error, 'completedDate is required when status is COMPLETED', 'uses stored null completedDate');
  assert.equal((await ctx.service.updateRecertification(id, { result: 'PASS' })).error, 'result requires status COMPLETED', 'uses stored PENDING status');
  const sched = await ctx.service.updateRecertification(id, { status: 'SCHEDULED', scheduledDate: '2026-12-01' });
  assert.equal(sched.recertification.status, 'SCHEDULED', 'patch-supplied scheduledDate honoured');
  const done = await ctx.service.updateRecertification(id, { status: 'COMPLETED', result: 'PASS', completedDate: true });
  assert.equal(done.recertification.status, 'COMPLETED');
  assert.match(done.recertification.completedDate, /^\d{4}-\d{2}-\d{2} /, 'sentinel stamped by SQLite');
  ctx.db.close();
});

test('W26R-SVC-12. getRecertification returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createRecertification(base(ctx, {}));
  assert.equal((await ctx.service.getRecertification(c.recertification.id)).recertification.employeeId, 500);
  assert.equal((await ctx.service.getRecertification(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26R-SVC-13. list by employee and by competency', async () => {
  const ctx = await setup();
  await ctx.service.createRecertification(base(ctx, { employeeId: 501 }));
  await ctx.service.createRecertification(base(ctx, { employeeId: 501, competencyId: ctx.compId }));
  assert.equal((await ctx.service.listEmployeeRecertifications(501)).recertifications.length, 2);
  assert.equal((await ctx.service.listCompetencyRecertifications(ctx.compId)).recertifications.length, 2);
  ctx.db.close();
});

test('W26R-SVC-14. due / scheduled / completed / overdue / active queries', async () => {
  const ctx = await setup();
  await ctx.service.createRecertification(base(ctx, { employeeId: 601 })); // PENDING → due
  await ctx.service.createRecertification(base(ctx, { employeeId: 602, status: 'SCHEDULED', scheduledDate: '2026-12-01' }));
  await ctx.service.createRecertification(base(ctx, { employeeId: 603, status: 'COMPLETED', scheduledDate: '2026-01-01', completedDate: '2026-06-01', result: 'PASS' }));
  const late = await ctx.service.createRecertification(base(ctx, { employeeId: 604 }));
  await stampDue(ctx.db, late.recertification.id, '-5 days');
  assert.equal((await ctx.service.dueRecertifications()).recertifications.length, 2, 'two PENDING');
  assert.equal((await ctx.service.scheduledRecertifications()).recertifications.length, 1);
  assert.equal((await ctx.service.completedRecertifications()).recertifications.length, 1);
  assert.equal((await ctx.service.overdueRecertifications()).recertifications.length, 1);
  assert.equal((await ctx.service.activeRecertifications()).recertifications.length, 4);
  ctx.db.close();
});

test('W26R-SVC-15. archiveRecertification: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveRecertification(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createRecertification(base(ctx, {}));
  assert.equal((await ctx.service.archiveRecertification(c.recertification.id)).recertification.archived, 1);
  assert.equal((await ctx.service.archiveRecertification(c.recertification.id)).error, 'recertification already archived');
  ctx.db.close();
});

test('W26R-SVC-16. deleteRecertification then restoreRecertification; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteRecertification(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreRecertification(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createRecertification(base(ctx, {}));
  const id = c.recertification.id;
  assert.deepEqual(await ctx.service.deleteRecertification(id), { ok: true, id });
  assert.equal((await ctx.service.getRecertification(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreRecertification(id)).recertification.deleted, 0);
  ctx.db.close();
});

test('W26R-SVC-17. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const brokenRepo = {}; for (const m of REPO_METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const dep = { findById() {} };
  const boom = new Service(brokenRepo, dep, dep, dep, dep, dep);
  const r = await boom.getRecertification(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
