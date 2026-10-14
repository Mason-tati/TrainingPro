// WP-26 · Phase 3 — Enterprise Document Core routes tests (real Express over loopback; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path (including /search and /folder/:folderId ordering before /:id).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const FSvc = require(path.join(EDIR, 'enterprise-folder-service.js'));
const { createEnterpriseDocumentCoreController } = require(path.join(EDIR, 'enterprise-document-core-controller.js'));
const { createEnterpriseDocumentCoreRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-document-core-routes.js'));

let db; let server; let baseUrl; let folderId;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await DMig.migrate(db);
  await FMig.migrate(db);
  const folderRepo = new FRepo(db);
  const folder = await new FSvc(folderRepo).createFolder({ folderNumber: 'RT-FLD', folderName: 'Docs', securityClassification: 'CONFIDENTIAL' });
  folderId = folder.folder.id;
  const controller = createEnterpriseDocumentCoreController(new Service(new DRepo(db), folderRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseDocumentCoreRoutes(controller));
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

test('W26C-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, { documentNumber: 'G', documentTitle: 'G' })).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/search`)).status, 503);
});

test('W26C-RTE-2. POST creates a document inheriting folder security (201)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { documentNumber: 'RT-1', documentTitle: 'Doc', folderId });
  assert.equal(r.status, 201);
  assert.equal(r.json.document.securityClassification, 'CONFIDENTIAL', 'inherited from folder');
});

test('W26C-RTE-3. POST duplicate number → 409; bad folder → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, { documentNumber: 'RT-D', documentTitle: 'A' });
  assert.equal((await request('POST', MOUNT_PATH, { documentNumber: 'RT-D', documentTitle: 'B' })).status, 409);
  assert.equal((await request('POST', MOUNT_PATH, { documentNumber: 'RT-BF', documentTitle: 'B', folderId: 99999 })).status, 400);
});

test('W26C-RTE-4. GET /:id returns a document; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-G', documentTitle: 'GetMe' });
  const id = created.json.document.id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26C-RTE-5. GET /search filters by status and free-text (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, { documentNumber: 'RT-S1', documentTitle: 'Safety Plan', status: 'DRAFT', keywords: 'osha' });
  const byStatus = await request('GET', `${MOUNT_PATH}/search?status=DRAFT`);
  assert.equal(byStatus.status, 200);
  assert.ok(byStatus.json.documents.length >= 1);
  const byText = await request('GET', `${MOUNT_PATH}/search?text=Safety`);
  assert.equal(byText.json.documents.some((d) => d.documentTitle === 'Safety Plan'), true);
  assert.equal((await request('GET', `${MOUNT_PATH}/search?status=BOGUS`)).status, 400);
});

test('W26C-RTE-6. GET /folder/:folderId lists documents in a folder', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, { documentNumber: 'RT-F1', documentTitle: 'InFolder', folderId });
  const r = await request('GET', `${MOUNT_PATH}/folder/${folderId}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.documents.length >= 1);
});

test('W26C-RTE-7. PUT /:id updates; invalid status → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-U', documentTitle: 'Upd' });
  const id = created.json.document.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'APPROVED' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'NOPE' })).status, 400);
});

test('W26C-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-AR', documentTitle: 'Arch' });
  const id = created.json.document.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26C-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-DEL', documentTitle: 'Del' });
  const id = created.json.document.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
