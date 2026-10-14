// WP-26 · Phase 11 — Enterprise Competency Evidence service tests (ephemeral DB; real DI).
// Business rules over the evidence repository plus THREE read-only injected repositories (competency,
// assessment, mapping). A full in-memory stack (folder → doc-core → version → competency + assessment →
// mapping) provides real referents so existence validation, the verification workflow, lifecycle, and
// copy-on-read are exercised end to end.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const EMig = require(path.join(EDIR, 'enterprise-competency-evidence-migration.js'));
const ERepo = require(path.join(EDIR, 'enterprise-competency-evidence-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-competency-evidence-service.js'));
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
  await EMig.migrate(db); await MMig.migrate(db); await KMig.migrate(db); await SMig.migrate(db);
  await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const evRepo = new ERepo(db);
  const mapRepo = new MRepo(db); const compRepo = new KRepo(db); const assRepo = new SRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'EV-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const ass = await new SSvc(assRepo, verRepo).createAssessment({ documentVersionId: ver.version.id, assessmentId: 200, assessmentCode: 'A-1', assessmentTitle: 'Q1' });
  const map = await new MSvc(mapRepo, compRepo, assRepo).createMapping({ competencyId: comp.competency.id, assessmentId: ass.assessment.id });
  const service = new Service(evRepo, compRepo, assRepo, mapRepo);
  return { db, service, compId: comp.competency.id, assId: ass.assessment.id, mapId: map.mapping.id };
}
const base = (ctx, over) => Object.assign({ competencyId: ctx.compId, assessmentId: ctx.assId, mappingId: ctx.mapId, employeeId: 500, evidenceTitle: 'Forklift cert' }, over);

test('W26E-SVC-1. constructor requires competency, assessment, and mapping repositories', () => {
  const REPO_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findByAssessment', 'findPendingVerification', 'findVerified', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => {};
  const dep = { findById() {} };
  assert.throws(() => new Service(repo, null, dep, dep), /competency repository/);
  assert.throws(() => new Service(repo, dep, null, dep), /assessment repository/);
  assert.throws(() => new Service(repo, dep, dep, null), /mapping repository/);
});

test('W26E-SVC-2. createEvidence persists a PENDING record with resolved referents and metadata', async () => {
  const ctx = await setup();
  const r = await ctx.service.createEvidence(base(ctx, { evidenceType: 'CERTIFICATE', metadata: { score: 92 } }));
  assert.equal(r.ok, true);
  assert.equal(r.evidence.competencyId, ctx.compId);
  assert.equal(r.evidence.assessmentId, ctx.assId);
  assert.equal(r.evidence.mappingId, ctx.mapId);
  assert.equal(r.evidence.verificationStatus, 'PENDING');
  assert.deepEqual(r.evidence.metadata, { score: 92 });
  ctx.db.close();
});

test('W26E-SVC-3. createEvidence rejects missing/invalid FK ids and employeeId', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createEvidence(base(ctx, { competencyId: 0 }))).code, 'VALIDATION');
  assert.equal((await ctx.service.createEvidence(base(ctx, { assessmentId: 0 }))).code, 'VALIDATION');
  assert.equal((await ctx.service.createEvidence(base(ctx, { mappingId: 0 }))).code, 'VALIDATION');
  assert.equal((await ctx.service.createEvidence(base(ctx, { employeeId: 0 }))).code, 'VALIDATION');
  assert.equal((await ctx.service.createEvidence('nope')).code, 'VALIDATION');
  ctx.db.close();
});

test('W26E-SVC-4. createEvidence validates existence of competency, assessment, and mapping', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createEvidence(base(ctx, { competencyId: 99999 }))).error, 'competency not found');
  assert.equal((await ctx.service.createEvidence(base(ctx, { assessmentId: 99999 }))).error, 'assessment not found');
  assert.equal((await ctx.service.createEvidence(base(ctx, { mappingId: 99999 }))).error, 'mapping not found');
  ctx.db.close();
});

test('W26E-SVC-5. createEvidence validates evidenceType, title, reference, status, verifiedBy, metadata, dates', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.createEvidence(base(ctx, { evidenceType: 'FUZZY' }))).error, 'invalid evidenceType');
  assert.equal((await ctx.service.createEvidence(base(ctx, { evidenceTitle: '   ' }))).error, 'evidenceTitle is required');
  assert.equal((await ctx.service.createEvidence(base(ctx, { evidenceReference: '' }))).code, 'VALIDATION');
  assert.equal((await ctx.service.createEvidence(base(ctx, { verificationStatus: 'MAYBE' }))).error, 'invalid verificationStatus');
  assert.equal((await ctx.service.createEvidence(base(ctx, { verifiedBy: 0 }))).error, 'verifiedBy must be a positive integer');
  assert.equal((await ctx.service.createEvidence(base(ctx, { metadata: 'x' }))).error, 'invalid metadata');
  assert.equal((await ctx.service.createEvidence(base(ctx, { effectiveDate: '2026-06-01', expiryDate: '2026-01-01' }))).error, 'expiryDate must be on or after effectiveDate');
  ctx.db.close();
});

test('W26E-SVC-6. createEvidence accepts a raw metadataJson fallback; corrupt JSON reads back as null', async () => {
  const ctx = await setup();
  const r = await ctx.service.createEvidence(base(ctx, { metadataJson: '{bad json' }));
  assert.equal(r.ok, true);
  assert.equal(r.evidence.metadata, null, 'unparseable metadataJson → null');
  ctx.db.close();
});

test('W26E-SVC-7. updateEvidence: not found, validation, and a successful content edit', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.updateEvidence(9999, { evidenceTitle: 'x' })).code, 'NOT_FOUND');
  const c = await ctx.service.createEvidence(base(ctx, {}));
  const id = c.evidence.id;
  assert.equal((await ctx.service.updateEvidence(id, { evidenceType: 'FUZZY' })).error, 'invalid evidenceType');
  assert.equal((await ctx.service.updateEvidence(id, { evidenceTitle: '  ' })).code, 'VALIDATION');
  assert.equal((await ctx.service.updateEvidence(id, { evidenceReference: '' })).code, 'VALIDATION');
  assert.equal((await ctx.service.updateEvidence(id, { metadata: 7 })).error, 'invalid metadata');
  const upd = await ctx.service.updateEvidence(id, { evidenceType: 'DOCUMENT', evidenceTitle: 'Updated', metadata: { v: 2 } });
  assert.equal(upd.evidence.evidenceType, 'DOCUMENT');
  assert.deepEqual(upd.evidence.metadata, { v: 2 });
  assert.equal((await ctx.service.updateEvidence(id, null)).ok, true, 'non-object patch treated as empty');
  ctx.db.close();
});

test('W26E-SVC-8. verifyEvidence workflow: not found, invalid status, missing verifier, then VERIFIED/REJECTED', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.verifyEvidence(9999, { verifiedBy: 3 })).code, 'NOT_FOUND');
  const c = await ctx.service.createEvidence(base(ctx, {}));
  const id = c.evidence.id;
  assert.equal((await ctx.service.verifyEvidence(id, { verificationStatus: 'PENDING', verifiedBy: 3 })).code, 'VALIDATION');
  assert.equal((await ctx.service.verifyEvidence(id, { verifiedBy: 0 })).error, 'verifiedBy is required');
  assert.equal((await ctx.service.verifyEvidence(id, null)).error, 'verifiedBy is required', 'non-object input treated as empty');
  const ok = await ctx.service.verifyEvidence(id, { verifiedBy: 42 });
  assert.equal(ok.evidence.verificationStatus, 'VERIFIED');
  assert.equal(ok.evidence.verifiedBy, 42);
  assert.match(ok.evidence.verifiedDate, /^\d{4}-\d{2}-\d{2} /);
  const rej = await ctx.service.verifyEvidence(id, { verificationStatus: 'REJECTED', verifiedBy: 42 });
  assert.equal(rej.evidence.verificationStatus, 'REJECTED');
  ctx.db.close();
});

test('W26E-SVC-9. getEvidence returns a record or NOT_FOUND', async () => {
  const ctx = await setup();
  const c = await ctx.service.createEvidence(base(ctx, {}));
  assert.equal((await ctx.service.getEvidence(c.evidence.id)).evidence.employeeId, 500);
  assert.equal((await ctx.service.getEvidence(9999)).code, 'NOT_FOUND');
  ctx.db.close();
});

test('W26E-SVC-10. list by employee / competency / assessment', async () => {
  const ctx = await setup();
  await ctx.service.createEvidence(base(ctx, { employeeId: 501, evidenceTitle: 'A' }));
  await ctx.service.createEvidence(base(ctx, { employeeId: 501, evidenceTitle: 'B' }));
  assert.equal((await ctx.service.listEmployeeEvidence(501)).evidence.length, 2);
  assert.equal((await ctx.service.listCompetencyEvidence(ctx.compId)).evidence.length, 2);
  assert.equal((await ctx.service.listAssessmentEvidence(ctx.assId)).evidence.length, 2);
  ctx.db.close();
});

test('W26E-SVC-11. pending / verified / expired / active queries', async () => {
  const ctx = await setup();
  const p = await ctx.service.createEvidence(base(ctx, { evidenceTitle: 'pending' }));
  await ctx.service.createEvidence(base(ctx, { evidenceTitle: 'exp', expiryDate: '2000-01-01' }));
  await ctx.service.verifyEvidence(p.evidence.id, { verifiedBy: 1 });
  assert.equal((await ctx.service.pendingEvidence()).evidence.length, 1);
  assert.equal((await ctx.service.verifiedEvidence()).evidence.length, 1);
  assert.equal((await ctx.service.expiredEvidence()).evidence.length, 1);
  assert.equal((await ctx.service.activeEvidence()).evidence.length, 2);
  ctx.db.close();
});

test('W26E-SVC-12. archiveEvidence: success, not-found, and already-archived guard', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.archiveEvidence(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createEvidence(base(ctx, {}));
  assert.equal((await ctx.service.archiveEvidence(c.evidence.id)).evidence.archived, 1);
  assert.equal((await ctx.service.archiveEvidence(c.evidence.id)).error, 'evidence already archived');
  ctx.db.close();
});

test('W26E-SVC-13. deleteEvidence then restoreEvidence; both guard NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.deleteEvidence(9999)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreEvidence(9999)).code, 'NOT_FOUND');
  const c = await ctx.service.createEvidence(base(ctx, {}));
  const id = c.evidence.id;
  assert.deepEqual(await ctx.service.deleteEvidence(id), { ok: true, id });
  assert.equal((await ctx.service.getEvidence(id)).code, 'NOT_FOUND');
  assert.equal((await ctx.service.restoreEvidence(id)).evidence.deleted, 0);
  ctx.db.close();
});

test('W26E-SVC-14. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const ctx = await setup();
  const METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findByAssessment', 'findPendingVerification', 'findVerified', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
  const brokenRepo = {};
  for (const m of METHODS) brokenRepo[m] = () => { throw new Error('db down'); };
  const boom = new Service(brokenRepo, { findById() {} }, { findById() {} }, { findById() {} });
  const r = await boom.getEvidence(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db down');
  ctx.db.close();
});
