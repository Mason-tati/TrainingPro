// WP-26 · Phase 10 — Enterprise Competency↔Assessment Mapping service tests (business rules; DB).
// Covers competency + assessment existence validation (via TWO injected read-only repos), mapping
// uniqueness, mandatory / minimumScore / attempt validation, effective/expiry ordering, queries,
// lifecycle, and never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const MMig = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-migration.js'));
const MRepo = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-service.js'));
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

const REPO_METHODS = ['create', 'update', 'findById', 'findByCompetency', 'findByAssessment', 'findMandatory', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await MMig.migrate(db); await KMig.migrate(db); await SMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db); const compRepo = new KRepo(db); const assRepo = new SRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'DOC-1', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const assSvc = new SSvc(assRepo, verRepo);
  const ass1 = await assSvc.createAssessment({ documentVersionId: ver.version.id, assessmentId: 200, assessmentCode: 'A-1', assessmentTitle: 'Quiz 1' });
  const ass2 = await assSvc.createAssessment({ documentVersionId: ver.version.id, assessmentId: 201, assessmentCode: 'A-2', assessmentTitle: 'Quiz 2' });
  const svc = new Service(new MRepo(db), compRepo, assRepo);
  return { db, svc, compId: comp.competency.id, assId: ass1.assessment.id, assId2: ass2.assessment.id };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return { id: 1 }; } }, { findById() { return { id: 1 }; } });
}

// ---- construction ----

test('W26M-SVC-1. constructor validates the mapping repo AND requires competency + assessment repos', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  const fb = { findById() {} };
  assert.throws(() => new Service({}, fb, fb), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}, fb), /requires an injected competency repository/);
  assert.throws(() => new Service(goodRepo, fb, {}), /requires an injected assessment repository/);
  assert.throws(() => new Service(goodRepo, fb, null), /requires an injected assessment repository/);
});

// ---- create: existence + validation ----

test('W26M-SVC-2. createMapping requires valid competencyId + assessmentId and both must exist', async () => {
  const { db, svc, compId, assId } = await freshService();
  assert.equal((await svc.createMapping(null)).code, 'VALIDATION');
  assert.equal((await svc.createMapping({ assessmentId: assId })).code, 'VALIDATION', 'competencyId');
  assert.equal((await svc.createMapping({ competencyId: 0, assessmentId: assId })).code, 'VALIDATION');
  assert.equal((await svc.createMapping({ competencyId: compId })).code, 'VALIDATION', 'assessmentId');
  assert.equal((await svc.createMapping({ competencyId: 9999, assessmentId: assId })).code, 'VALIDATION', 'unknown competency');
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: 9999 })).code, 'VALIDATION', 'unknown assessment');
  db.close();
});

test('W26M-SVC-3. create validates mappingType / required / mandatory / score / attempts / metadata', async () => {
  const { db, svc, compId, assId } = await freshService();
  const base = { competencyId: compId, assessmentId: assId };
  assert.equal((await svc.createMapping({ ...base, mappingType: 'FUZZY' })).code, 'VALIDATION');
  assert.equal((await svc.createMapping({ ...base, required: 2 })).code, 'VALIDATION');
  assert.equal((await svc.createMapping({ ...base, mandatory: 5 })).code, 'VALIDATION');
  assert.equal((await svc.createMapping({ ...base, minimumScore: 200 })).code, 'VALIDATION');
  assert.equal((await svc.createMapping({ ...base, minimumAttempts: 0 })).code, 'VALIDATION');
  assert.equal((await svc.createMapping({ ...base, metadata: 'no' })).code, 'VALIDATION');
  db.close();
});

test('W26M-SVC-4. effective/expiry ordering: expiry before effective is rejected; other combinations pass', async () => {
  const { db, svc, compId, assId, assId2 } = await freshService();
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId, effectiveDate: '2026-06-01', expiryDate: '2026-01-01' })).code, 'VALIDATION', 'expiry < effective');
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId, effectiveDate: '2026-01-01', expiryDate: '2027-01-01' })).ok, true, 'valid window');
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId2, effectiveDate: '2026-01-01' })).ok, true, 'effective only');
  db.close();
});

test('W26M-SVC-5. mapping uniqueness: a duplicate competency+assessment pair is rejected; a different pair is allowed', async () => {
  const { db, svc, compId, assId, assId2 } = await freshService();
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId })).ok, true);
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId })).code, 'CONFLICT', 'same pair');
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId2 })).ok, true, 'different assessment');
  db.close();
});

test('W26M-SVC-6. create (minimal) defaults; (full) persists + parses metadata', async () => {
  const { db, svc, compId, assId, assId2 } = await freshService();
  const min = (await svc.createMapping({ competencyId: compId, assessmentId: assId })).mapping;
  assert.equal(min.mappingType, 'DIRECT');
  assert.equal(min.required, 1);
  assert.equal(min.mandatory, 0);
  assert.equal(min.metadata, null);
  const full = (await svc.createMapping({
    competencyId: compId, assessmentId: assId2, mappingType: 'PREREQUISITE', required: 0, mandatory: 1,
    minimumScore: 80, minimumAttempts: 2, effectiveDate: '2026-01-01', expiryDate: '2027-01-01', metadata: { a: 1 },
  })).mapping;
  assert.equal(full.mappingType, 'PREREQUISITE');
  assert.equal(full.mandatory, 1);
  assert.deepEqual(full.metadata, { a: 1 });
  db.close();
});

// ---- read / queries ----

test('W26M-SVC-7. getMapping found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc, compId, assId } = await freshService();
  const created = await svc.createMapping({ competencyId: compId, assessmentId: assId });
  assert.equal((await svc.getMapping(created.mapping.id)).ok, true);
  assert.equal((await svc.getMapping(9999)).code, 'NOT_FOUND');
  const repo = new MRepo(db);
  const bad = await repo.create({ competencyId: compId, assessmentId: 555, metadataJson: '{oops' });
  assert.equal((await svc.getMapping(bad.id)).mapping.metadata, null);
  db.close();
});

test('W26M-SVC-8. listCompetency / listAssessment / mandatory / expired / active queries', async () => {
  const { db, svc, compId, assId, assId2 } = await freshService();
  await svc.createMapping({ competencyId: compId, assessmentId: assId, mandatory: 1, expiryDate: '2000-01-01' }); // mandatory + expired
  await svc.createMapping({ competencyId: compId, assessmentId: assId2 });
  assert.equal((await svc.listCompetencyMappings(compId)).mappings.length, 2);
  assert.equal((await svc.listAssessmentMappings(assId)).mappings.length, 1);
  assert.equal((await svc.mandatoryMappings()).mappings.length, 1);
  assert.equal((await svc.expiredMappings()).mappings.length, 1);
  assert.equal((await svc.activeMappings()).mappings.length, 2);
  db.close();
});

test('W26M-SVC-9. empty queries for a fresh engine', async () => {
  const { db, svc } = await freshService();
  assert.deepEqual((await svc.listCompetencyMappings(4242)).mappings, []);
  assert.deepEqual((await svc.mandatoryMappings()).mappings, []);
  assert.deepEqual((await svc.expiredMappings()).mappings, []);
  assert.deepEqual((await svc.activeMappings()).mappings, []);
  db.close();
});

// ---- update ----

test('W26M-SVC-10. updateMapping NOT_FOUND / validation / success', async () => {
  const { db, svc, compId, assId } = await freshService();
  assert.equal((await svc.updateMapping(4242, { mappingType: 'DIRECT' })).code, 'NOT_FOUND');
  const created = await svc.createMapping({ competencyId: compId, assessmentId: assId });
  const id = created.mapping.id;
  assert.equal((await svc.updateMapping(id, { mappingType: 'FUZZY' })).code, 'VALIDATION');
  assert.equal((await svc.updateMapping(id, { required: 3 })).code, 'VALIDATION');
  assert.equal((await svc.updateMapping(id, { mandatory: 5 })).code, 'VALIDATION');
  assert.equal((await svc.updateMapping(id, { minimumScore: 200 })).code, 'VALIDATION');
  assert.equal((await svc.updateMapping(id, { minimumAttempts: 0 })).code, 'VALIDATION');
  assert.equal((await svc.updateMapping(id, { metadata: 7 })).code, 'VALIDATION');
  const upd = await svc.updateMapping(id, { mappingType: 'EQUIVALENT', mandatory: 1, metadata: { r: 1 } });
  assert.equal(upd.mapping.mappingType, 'EQUIVALENT');
  assert.deepEqual(upd.mapping.metadata, { r: 1 });
  assert.equal((await svc.updateMapping(id, null)).ok, true, 'non-object patch → no-op success');
  db.close();
});

// ---- lifecycle ----

test('W26M-SVC-11. archiveMapping success / NOT_FOUND / already-archived', async () => {
  const { db, svc, compId, assId } = await freshService();
  const created = await svc.createMapping({ competencyId: compId, assessmentId: assId });
  const id = created.mapping.id;
  assert.equal((await svc.archiveMapping(id)).mapping.archived, 1);
  assert.equal((await svc.archiveMapping(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveMapping(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26M-SVC-12. deleteMapping success then NOT_FOUND on re-delete', async () => {
  const { db, svc, compId, assId } = await freshService();
  const created = await svc.createMapping({ competencyId: compId, assessmentId: assId });
  const id = created.mapping.id;
  assert.equal((await svc.deleteMapping(id)).ok, true);
  assert.equal((await svc.deleteMapping(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26M-SVC-13. restoreMapping restores a soft-deleted row; NOT_FOUND for unknown id', async () => {
  const { db, svc, compId, assId } = await freshService();
  const created = await svc.createMapping({ competencyId: compId, assessmentId: assId });
  const id = created.mapping.id;
  await svc.deleteMapping(id);
  const restored = await svc.restoreMapping(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.mapping.deleted, 0);
  assert.equal((await svc.restoreMapping(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26M-SVC-14. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getMapping(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26M-SVC-15. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findMandatory', 'boom-string');
  const r = await svc.mandatoryMappings();
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});

test('W26M-SVC-16. minimumScore boundaries (0 and 100) and a valid minimumAttempts are accepted', async () => {
  const { db, svc, compId, assId, assId2 } = await freshService();
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId, minimumScore: 0, minimumAttempts: 1 })).ok, true);
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId2, minimumScore: 100, minimumAttempts: 5 })).ok, true);
  db.close();
});

test('W26M-SVC-17. the same assessment can map to a different competency (uniqueness is per pair)', async () => {
  const { db, svc, compId, assId } = await freshService();
  // build a second competency in the same in-memory DB via the competency service
  const KRepo2 = require(path.join(EDIR, 'enterprise-document-competency-repository.js'));
  const KSvc2 = require(path.join(EDIR, 'enterprise-document-competency-service.js'));
  const VRepo2 = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
  const DRepo2 = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
  const DSvc2 = require(path.join(EDIR, 'enterprise-document-core-service.js'));
  const FRepo2 = require(path.join(EDIR, 'enterprise-folder-repository.js'));
  const VSvc2 = require(path.join(EDIR, 'enterprise-document-version-service.js'));
  const doc = await new DSvc2(new DRepo2(db), new FRepo2(db)).createDocument({ documentNumber: 'DOC-2', documentTitle: 'Second' });
  const ver = await new VSvc2(new VRepo2(db), new DRepo2(db)).createVersion({ documentId: doc.document.id });
  const comp2 = await new KSvc2(new KRepo2(db), new VRepo2(db)).createCompetency({ documentVersionId: ver.version.id, competencyId: 300, competencyCode: 'C-2', competencyName: 'Fire' });
  assert.equal((await svc.createMapping({ competencyId: compId, assessmentId: assId })).ok, true);
  assert.equal((await svc.createMapping({ competencyId: comp2.competency.id, assessmentId: assId })).ok, true, 'same assessment, different competency');
  assert.equal((await svc.listAssessmentMappings(assId)).mappings.length, 2, 'assessment shared by two competencies');
  db.close();
});
