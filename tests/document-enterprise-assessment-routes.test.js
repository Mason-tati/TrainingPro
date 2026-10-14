// WP-26 · Phase 9 — Enterprise Document Assessment routes tests (real Express over loopback; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path (including /published, /expired, /version/:id ordering before /:id).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const AMig = require(path.join(EDIR, 'enterprise-document-assessment-migration.js'));
const ARepo = require(path.join(EDIR, 'enterprise-document-assessment-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-assessment-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const { createEnterpriseDocumentAssessmentController } = require(path.join(EDIR, 'enterprise-document-assessment-controller.js'));
const { createEnterpriseDocumentAssessmentRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-document-assessment-routes.js'));

let db; let server; let baseUrl; let verId;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await AMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'RT-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  verId = ver.version.id;
  const controller = createEnterpriseDocumentAssessmentController(new Service(new ARepo(db), verRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseDocumentAssessmentRoutes(controller));
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
const mk = (over) => Object.assign({ documentVersionId: verId, assessmentId: 5, assessmentCode: 'RT-A1', assessmentTitle: 'One' }, over);

test('W26S-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, mk({}))).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/published`)).status, 503);
});

test('W26S-RTE-2. POST creates an assessment (201, DRAFT)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, mk({ assessmentType: 'EXAM', passMark: 80, questionCount: 20 }));
  assert.equal(r.status, 201);
  assert.equal(r.json.assessment.assessmentStatus, 'DRAFT');
});

test('W26S-RTE-3. POST with no assessmentId → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, { documentVersionId: verId, assessmentCode: 'x', assessmentTitle: 'x' })).status, 400);
});

test('W26S-RTE-4. GET /published, /expired, /version/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, mk({ assessmentId: 6, assessmentCode: 'RT-PUB', assessmentStatus: 'PUBLISHED', expiryDate: '2000-01-01' }));
  assert.ok((await request('GET', `${MOUNT_PATH}/published`)).json.assessments.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/expired`)).json.assessments.length >= 1, 'the past-dated one');
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.assessments.length >= 1);
});

test('W26S-RTE-5. GET /:id returns an assessment; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  const id = list.json.assessments[0].id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26S-RTE-6. PUT /:id updates; invalid type → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, mk({ assessmentId: 7, assessmentCode: 'RT-U' }));
  const id = created.json.assessment.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { assessmentType: 'SURVEY' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { assessmentType: 'GAME' })).status, 400);
});

test('W26S-RTE-7. PUT /:id can transition status to PUBLISHED (appears in /published)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, mk({ assessmentId: 8, assessmentCode: 'RT-P2', passMark: 70, questionCount: 15 }));
  const id = created.json.assessment.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { assessmentStatus: 'PUBLISHED' })).status, 200);
  const published = await request('GET', `${MOUNT_PATH}/published`);
  assert.ok(published.json.assessments.some((a) => a.id === id));
});

test('W26S-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, mk({ assessmentId: 9, assessmentCode: 'RT-AR' }));
  const id = created.json.assessment.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26S-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, mk({ assessmentId: 10, assessmentCode: 'RT-DEL' }));
  const id = created.json.assessment.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26S-RTE-10. duplicate assessmentCode is allowed (no unique constraint) — creates two rows', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const a = await request('POST', MOUNT_PATH, mk({ assessmentId: 20, assessmentCode: 'RT-DUP' }));
  const b = await request('POST', MOUNT_PATH, mk({ assessmentId: 21, assessmentCode: 'RT-DUP' }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
});

test('W26S-RTE-11. GET /:id with a non-numeric id still routes to get (unknown → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
