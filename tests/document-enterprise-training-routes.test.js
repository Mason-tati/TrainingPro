// WP-26 · Phase 7 — Enterprise Document Training routes tests (real Express over loopback; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path (including /pending, /completed, /overdue, /version/:id ordering before /:id).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const TMig = require(path.join(EDIR, 'enterprise-document-training-migration.js'));
const TRepo = require(path.join(EDIR, 'enterprise-document-training-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-training-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const { createEnterpriseDocumentTrainingController } = require(path.join(EDIR, 'enterprise-document-training-controller.js'));
const { createEnterpriseDocumentTrainingRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-document-training-routes.js'));

let db; let server; let baseUrl; let verId;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await TMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'RT-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  verId = ver.version.id;
  const controller = createEnterpriseDocumentTrainingController(new Service(new TRepo(db), verRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseDocumentTrainingRoutes(controller));
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

test('W26T-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, { documentVersionId: verId, userId: 1 })).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/pending`)).status, 503);
});

test('W26T-RTE-2. POST creates a training assignment (201)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { documentVersionId: verId, userId: 100, mandatoryTraining: 1, dueDate: '2000-01-01' });
  assert.equal(r.status, 201);
  assert.equal(r.json.training.trainingStatus, 'ASSIGNED');
});

test('W26T-RTE-3. POST with no user → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, { documentVersionId: verId })).status, 400);
});

test('W26T-RTE-4. GET /pending, /overdue, /version/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.ok((await request('GET', `${MOUNT_PATH}/pending`)).json.trainings.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/overdue`)).json.trainings.length >= 1, 'the past-due one');
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.trainings.length >= 1);
});

test('W26T-RTE-5. GET /:id returns a training; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  const id = list.json.trainings[0].id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26T-RTE-6. POST /:id/complete; re-complete → 400; then it appears in /completed', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentVersionId: verId, userId: 200 });
  const id = created.json.training.id;
  const done = await request('POST', `${MOUNT_PATH}/${id}/complete`, { score: 90 });
  assert.equal(done.status, 200);
  assert.equal(done.json.training.trainingStatus, 'COMPLETED');
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/complete`, {})).status, 400);
  assert.ok((await request('GET', `${MOUNT_PATH}/completed`)).json.trainings.length >= 1);
});

test('W26T-RTE-7. POST /:id/complete blocked when a required assessment is not passed (400)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentVersionId: verId, userId: 250, assessmentRequired: 1 });
  const id = created.json.training.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/complete`, {})).status, 400);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/complete`, { assessmentPassed: 1 })).status, 200);
});

test('W26T-RTE-8. PUT /:id updates; invalid status → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentVersionId: verId, userId: 300 });
  const id = created.json.training.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { trainingStatus: 'IN_PROGRESS' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { trainingStatus: 'NOPE' })).status, 400);
});

test('W26T-RTE-9. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentVersionId: verId, userId: 400 });
  const id = created.json.training.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26T-RTE-10. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentVersionId: verId, userId: 500 });
  const id = created.json.training.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
