// WP-26 · Phase 10 — Enterprise Competency↔Assessment Mapping routes tests (real Express; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path (including /mandatory, /expired, /competency/:id, /assessment/:id ordering).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
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
const { createEnterpriseCompetencyAssessmentMappingController } = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-controller.js'));
const { createEnterpriseCompetencyAssessmentMappingRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-routes.js'));

let db; let server; let baseUrl; let compId; let assId; let assId2;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await MMig.migrate(db); await KMig.migrate(db); await SMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db); const compRepo = new KRepo(db); const assRepo = new SRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'RT-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const assSvc = new SSvc(assRepo, verRepo);
  const a1 = await assSvc.createAssessment({ documentVersionId: ver.version.id, assessmentId: 200, assessmentCode: 'A-1', assessmentTitle: 'Q1' });
  const a2 = await assSvc.createAssessment({ documentVersionId: ver.version.id, assessmentId: 201, assessmentCode: 'A-2', assessmentTitle: 'Q2' });
  compId = comp.competency.id; assId = a1.assessment.id; assId2 = a2.assessment.id;
  const controller = createEnterpriseCompetencyAssessmentMappingController(new Service(new MRepo(db), compRepo, assRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseCompetencyAssessmentMappingRoutes(controller));
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

test('W26M-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, { competencyId: compId, assessmentId: assId })).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/mandatory`)).status, 503);
});

test('W26M-RTE-2. POST creates a mapping (201)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { competencyId: compId, assessmentId: assId, mandatory: 1, expiryDate: '2000-01-01' });
  assert.equal(r.status, 201);
  assert.equal(r.json.mapping.mappingType, 'DIRECT');
});

test('W26M-RTE-3. POST duplicate pair → 409; unknown competency → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, { competencyId: compId, assessmentId: assId })).status, 409, 'duplicate');
  assert.equal((await request('POST', MOUNT_PATH, { competencyId: 99999, assessmentId: assId })).status, 400, 'unknown competency');
});

test('W26M-RTE-4. GET /mandatory, /expired, /competency/:id, /assessment/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.ok((await request('GET', `${MOUNT_PATH}/mandatory`)).json.mappings.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/expired`)).json.mappings.length >= 1, 'the past-dated one');
  assert.ok((await request('GET', `${MOUNT_PATH}/competency/${compId}`)).json.mappings.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/assessment/${assId}`)).json.mappings.length >= 1);
});

test('W26M-RTE-5. GET /:id returns a mapping; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/competency/${compId}`);
  const id = list.json.mappings[0].id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26M-RTE-6. PUT /:id updates; invalid mappingType → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { competencyId: compId, assessmentId: assId2 });
  const id = created.json.mapping.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { mappingType: 'EQUIVALENT' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { mappingType: 'FUZZY' })).status, 400);
});

test('W26M-RTE-7. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/assessment/${assId2}`);
  const id = list.json.mappings[0].id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26M-RTE-8. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/assessment/${assId2}`);
  const id = list.json.mappings[0].id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26M-RTE-9. POST with expiry before effective → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { competencyId: compId, assessmentId: assId2, effectiveDate: '2026-06-01', expiryDate: '2026-01-01' });
  assert.equal(r.status, 400);
});

test('W26M-RTE-10. GET /:id with a non-numeric id still routes to get (unknown → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
