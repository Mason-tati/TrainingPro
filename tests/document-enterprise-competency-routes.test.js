// WP-26 · Phase 8 — Enterprise Document Competency routes tests (real Express over loopback; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path (including /mandatory, /expired, /version/:id ordering before /:id).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const CMig = require(path.join(EDIR, 'enterprise-document-competency-migration.js'));
const CRepo = require(path.join(EDIR, 'enterprise-document-competency-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-competency-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const { createEnterpriseDocumentCompetencyController } = require(path.join(EDIR, 'enterprise-document-competency-controller.js'));
const { createEnterpriseDocumentCompetencyRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-document-competency-routes.js'));

let db; let server; let baseUrl; let verId;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await CMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'RT-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  verId = ver.version.id;
  const controller = createEnterpriseDocumentCompetencyController(new Service(new CRepo(db), verRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseDocumentCompetencyRoutes(controller));
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
const mk = (over) => Object.assign({ documentVersionId: verId, competencyId: 5, competencyCode: 'RT-C1', competencyName: 'One' }, over);

test('W26K-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, mk({}))).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/mandatory`)).status, 503);
});

test('W26K-RTE-2. POST creates a competency (201) with computed expiry', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, mk({ competencyCode: 'RT-A', mandatoryCompetency: 1, effectiveDate: '2026-03-01', validationPeriodMonths: 12 }));
  assert.equal(r.status, 201);
  assert.equal(r.json.competency.expiryDate, '2027-03-01');
});

test('W26K-RTE-3. POST with no competencyId → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, { documentVersionId: verId, competencyCode: 'x', competencyName: 'x' })).status, 400);
});

test('W26K-RTE-4. GET /mandatory, /expired, /version/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, mk({ competencyId: 6, competencyCode: 'RT-EXP', effectiveDate: '2000-01-01', validationPeriodMonths: 1 }));
  assert.ok((await request('GET', `${MOUNT_PATH}/mandatory`)).json.competencies.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/expired`)).json.competencies.length >= 1, 'the past-dated one');
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.competencies.length >= 1);
});

test('W26K-RTE-5. GET /:id returns a competency; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  const id = list.json.competencies[0].id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26K-RTE-6. PUT /:id updates; invalid level → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, mk({ competencyId: 7, competencyCode: 'RT-U' }));
  const id = created.json.competency.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { competencyLevel: 'ADVANCED' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { competencyLevel: 'GURU' })).status, 400);
});

test('W26K-RTE-7. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, mk({ competencyId: 8, competencyCode: 'RT-AR' }));
  const id = created.json.competency.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26K-RTE-8. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, mk({ competencyId: 9, competencyCode: 'RT-DEL' }));
  const id = created.json.competency.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26K-RTE-9. duplicate competencyCode is allowed (no unique constraint) — creates two rows', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const a = await request('POST', MOUNT_PATH, mk({ competencyId: 20, competencyCode: 'RT-DUP' }));
  const b = await request('POST', MOUNT_PATH, mk({ competencyId: 21, competencyCode: 'RT-DUP' }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
});

test('W26K-RTE-10. GET /:id with a non-numeric id still routes to get (unknown → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
