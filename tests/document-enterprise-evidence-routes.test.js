// WP-26 · Phase 11 — Enterprise Competency Evidence routes tests (real Express; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT mounted
// in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises the full
// HTTP path (including /pending, /verified, /expired, /employee/:id, /competency/:id, /assessment/:id
// ordering and the /:id/verify workflow endpoint).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
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
const { createEnterpriseCompetencyEvidenceController } = require(path.join(EDIR, 'enterprise-competency-evidence-controller.js'));
const { createEnterpriseCompetencyEvidenceRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-competency-evidence-routes.js'));

let db; let server; let baseUrl; let compId; let assId; let mapId; const EMP = 700;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await EMig.migrate(db); await MMig.migrate(db); await KMig.migrate(db); await SMig.migrate(db);
  await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const mapRepo = new MRepo(db); const compRepo = new KRepo(db); const assRepo = new SRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'EV-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const ass = await new SSvc(assRepo, verRepo).createAssessment({ documentVersionId: ver.version.id, assessmentId: 200, assessmentCode: 'A-1', assessmentTitle: 'Q1' });
  const map = await new MSvc(mapRepo, compRepo, assRepo).createMapping({ competencyId: comp.competency.id, assessmentId: ass.assessment.id });
  compId = comp.competency.id; assId = ass.assessment.id; mapId = map.mapping.id;
  const controller = createEnterpriseCompetencyEvidenceController(new Service(new ERepo(db), compRepo, assRepo, mapRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseCompetencyEvidenceRoutes(controller));
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
const evidenceBody = (over) => Object.assign({ competencyId: compId, assessmentId: assId, mappingId: mapId, employeeId: EMP, evidenceTitle: 'Forklift cert' }, over);

test('W26E-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, evidenceBody({}))).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/pending`)).status, 503);
});

test('W26E-RTE-2. POST creates evidence (201, PENDING)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, evidenceBody({ evidenceType: 'CERTIFICATE', expiryDate: '2000-01-01' }));
  assert.equal(r.status, 201);
  assert.equal(r.json.evidence.verificationStatus, 'PENDING');
});

test('W26E-RTE-3. POST unknown competency → 400; missing employeeId → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, evidenceBody({ competencyId: 99999 }))).status, 400);
  assert.equal((await request('POST', MOUNT_PATH, evidenceBody({ employeeId: 0 }))).status, 400);
});

test('W26E-RTE-4. GET /pending, /expired, /employee/:id, /competency/:id, /assessment/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.ok((await request('GET', `${MOUNT_PATH}/pending`)).json.evidence.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/expired`)).json.evidence.length >= 1, 'the past-dated one');
  assert.ok((await request('GET', `${MOUNT_PATH}/employee/${EMP}`)).json.evidence.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/competency/${compId}`)).json.evidence.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/assessment/${assId}`)).json.evidence.length >= 1);
});

test('W26E-RTE-5. GET /:id returns evidence; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/employee/${EMP}`);
  const id = list.json.evidence[0].id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26E-RTE-6. PUT /:id updates; invalid evidenceType → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, evidenceBody({ employeeId: 701 }));
  const id = created.json.evidence.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { evidenceType: 'OBSERVATION' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { evidenceType: 'FUZZY' })).status, 400);
});

test('W26E-RTE-7. POST /:id/verify transitions to VERIFIED and appears in /verified', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, evidenceBody({ employeeId: 702 }));
  const id = created.json.evidence.id;
  const v = await request('POST', `${MOUNT_PATH}/${id}/verify`, { verifiedBy: 55 });
  assert.equal(v.status, 200);
  assert.equal(v.json.evidence.verificationStatus, 'VERIFIED');
  assert.ok((await request('GET', `${MOUNT_PATH}/verified`)).json.evidence.some((e) => e.id === id));
});

test('W26E-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, evidenceBody({ employeeId: 703 }));
  const id = created.json.evidence.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26E-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, evidenceBody({ employeeId: 704 }));
  const id = created.json.evidence.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26E-RTE-10. POST with expiry before effective → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, evidenceBody({ employeeId: 705, effectiveDate: '2026-06-01', expiryDate: '2026-01-01' }));
  assert.equal(r.status, 400);
});

test('W26E-RTE-11. GET /:id with a non-numeric id still routes to get (unknown → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
