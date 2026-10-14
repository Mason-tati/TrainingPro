// WP-26 · Phase 4 — Enterprise Document Version routes tests (real Express over loopback; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path (including /document/:id/current & /document/:id ordering before /:id).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const { createEnterpriseDocumentVersionController } = require(path.join(EDIR, 'enterprise-document-version-controller.js'));
const { createEnterpriseDocumentVersionRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-document-version-routes.js'));

let db; let server; let baseUrl; let docId;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'RT-DOC', documentTitle: 'Spec' });
  docId = doc.document.id;
  const controller = createEnterpriseDocumentVersionController(new Service(new VRepo(db), docRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseDocumentVersionRoutes(controller));
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

test('W26V-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, { documentId: docId })).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/document/${docId}`)).status, 503);
});

test('W26V-RTE-2. POST creates the first version (201, 1.0)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { documentId: docId, changeSummary: 'init' });
  assert.equal(r.status, 201);
  assert.equal(r.json.version.versionNumber, '1.0');
});

test('W26V-RTE-3. POST duplicate version → 409; unknown document → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, { documentId: docId, majorVersion: 1, minorVersion: 0 })).status, 409);
  assert.equal((await request('POST', MOUNT_PATH, { documentId: 999999, majorVersion: 1 })).status, 400);
});

test('W26V-RTE-4. POST a newer version supersedes; GET /document/:id/current returns it', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const v2 = await request('POST', MOUNT_PATH, { documentId: docId, majorVersion: 2, minorVersion: 0 });
  assert.equal(v2.status, 201);
  const current = await request('GET', `${MOUNT_PATH}/document/${docId}/current`);
  assert.equal(current.status, 200);
  assert.equal(current.json.version.versionNumber, '2.0');
});

test('W26V-RTE-5. GET /document/:id lists versions (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/document/${docId}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.versions.length >= 2);
});

test('W26V-RTE-6. GET /:id returns a version; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/document/${docId}`);
  const id = list.json.versions[0].id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26V-RTE-7. PUT /:id updates approval; invalid status → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/document/${docId}`);
  const id = list.json.versions[list.json.versions.length - 1].id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { approvalStatus: 'APPROVED' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { approvalStatus: 'NOPE' })).status, 400);
});

test('W26V-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentId: docId, majorVersion: 3, minorVersion: 0 });
  const id = created.json.version.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26V-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentId: docId, majorVersion: 4, minorVersion: 0 });
  const id = created.json.version.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26V-RTE-10. GET /document/:id/current → 404 for a document with no versions', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const otherDoc = await new DSvc(new DRepo(db), new FRepo(db)).createDocument({ documentNumber: 'RT-DOC2', documentTitle: 'Empty' });
  assert.equal((await request('GET', `${MOUNT_PATH}/document/${otherDoc.document.id}/current`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
