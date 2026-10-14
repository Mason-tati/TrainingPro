// WP-26 · Phase 13 — Enterprise Competency Recertification routes tests (real Express; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT mounted
// in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises the full HTTP
// path (including /due, /scheduled, /completed, /overdue, /employee/:id, /competency/:id ordering).
// Overdue is stamped relative to the DB clock for determinism.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
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
const { createEnterpriseCompetencyRecertificationController } = require(path.join(EDIR, 'enterprise-competency-recertification-controller.js'));
const { createEnterpriseCompetencyRecertificationRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-competency-recertification-routes.js'));

let db; let server; let baseUrl; let profileId; let compId;
let empSeq = 900;
const nextEmp = () => (empSeq += 1);

before(async () => {
  db = new sqlite3.Database(':memory:');
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
  profileId = prof.profile.id; compId = comp.competency.id;
  const controller = createEnterpriseCompetencyRecertificationController(new Service(recertRepo, profRepo, compRepo, assRepo, mapRepo, evRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseCompetencyRecertificationRoutes(controller));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (db) db.close();
});

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(baseUrl + url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function stampDue(id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseCompetencyRecertification SET dueDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}
const recertBody = (over) => Object.assign({ employeeProfileId: profileId, employeeId: nextEmp(), competencyId: compId, dueDate: '2027-01-01' }, over);

test('W26R-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, recertBody({}))).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/due`)).status, 503);
});

test('W26R-RTE-2. POST creates a recertification (201, default PENDING/PERIODIC)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, recertBody({}));
  assert.equal(r.status, 201);
  assert.equal(r.json.recertification.status, 'PENDING');
  assert.equal(r.json.recertification.recertificationType, 'PERIODIC');
});

test('W26R-RTE-3. POST unknown profile → 400; missing dueDate → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, recertBody({ employeeProfileId: 99999 }))).status, 400);
  assert.equal((await request('POST', MOUNT_PATH, recertBody({ dueDate: '' }))).status, 400);
});

test('W26R-RTE-4. GET /due, /scheduled, /completed, /overdue, /employee/:id, /competency/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const emp = nextEmp();
  await request('POST', MOUNT_PATH, { employeeProfileId: profileId, employeeId: emp, competencyId: compId, dueDate: '2027-01-01', status: 'SCHEDULED', scheduledDate: '2026-12-01' });
  const late = await request('POST', MOUNT_PATH, recertBody({}));
  await stampDue(late.json.recertification.id, '-5 days');
  assert.ok((await request('GET', `${MOUNT_PATH}/due`)).json.recertifications.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/scheduled`)).json.recertifications.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/overdue`)).json.recertifications.some((r) => r.id === late.json.recertification.id));
  assert.equal((await request('GET', `${MOUNT_PATH}/employee/${emp}`)).json.recertifications.length, 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/competency/${compId}`)).json.recertifications.length >= 1);
});

test('W26R-RTE-5. GET /:id returns a recertification; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, recertBody({}));
  const id = created.json.recertification.id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26R-RTE-6. PUT /:id updates; invalid status → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, recertBody({}));
  const id = created.json.recertification.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { recertificationType: 'REMEDIAL' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'WAT' })).status, 400);
});

test('W26R-RTE-7. PUT /:id completes via the boolean completedDate sentinel + result', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, recertBody({}));
  const id = created.json.recertification.id;
  const done = await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'COMPLETED', result: 'PASS', completedDate: true });
  assert.equal(done.status, 200);
  assert.equal(done.json.recertification.status, 'COMPLETED');
  assert.ok((await request('GET', `${MOUNT_PATH}/completed`)).json.recertifications.some((r) => r.id === id));
});

test('W26R-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, recertBody({}));
  const id = created.json.recertification.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26R-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, recertBody({}));
  const id = created.json.recertification.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26R-RTE-10. POST status SCHEDULED without scheduledDate → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, recertBody({ status: 'SCHEDULED' }));
  assert.equal(r.status, 400);
});

test('W26R-RTE-11. GET /:id with a non-numeric id still routes to get (unknown → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
