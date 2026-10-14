// WP-26 · Phase 2 — Enterprise Folder routes tests (real Express over loopback; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-folder-service.js'));
const { createEnterpriseFolderController } = require(path.join(EDIR, 'enterprise-folder-controller.js'));
const { createEnterpriseFolderRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-folder-routes.js'));

let db; let server; let baseUrl;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  const controller = createEnterpriseFolderController(new Service(new Repository(db)));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseFolderRoutes(controller));
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

test('W26F-RTE-1. gate: disabled flag → 503 for every route', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, { folderNumber: 'G', folderName: 'G' })).status, 503);
  assert.equal((await request('GET', MOUNT_PATH)).status, 503);
});

test('W26F-RTE-2. POST creates a root folder (201)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { folderNumber: 'RT-R', folderName: 'Root', securityClassification: 'INTERNAL' });
  assert.equal(r.status, 201);
  assert.equal(r.json.folder.folderPath, '/Root');
});

test('W26F-RTE-3. POST duplicate number → 409', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, { folderNumber: 'RT-D', folderName: 'Dee' });
  assert.equal((await request('POST', MOUNT_PATH, { folderNumber: 'RT-D', folderName: 'Dee2' })).status, 409);
});

test('W26F-RTE-4. GET / lists roots; GET /:id returns a folder; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { folderNumber: 'RT-G', folderName: 'GetMe' });
  const id = created.json.folder.id;
  assert.ok((await request('GET', MOUNT_PATH)).json.folders.length >= 1);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26F-RTE-5. GET /:id/children lists direct children', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const parent = await request('POST', MOUNT_PATH, { folderNumber: 'RT-P', folderName: 'Parent' });
  const pid = parent.json.folder.id;
  await request('POST', MOUNT_PATH, { folderNumber: 'RT-C', folderName: 'Kid', parentFolderId: pid });
  const kids = await request('GET', `${MOUNT_PATH}/${pid}/children`);
  assert.equal(kids.status, 200);
  assert.equal(kids.json.folders.length, 1);
});

test('W26F-RTE-6. PUT /:id updates; invalid classification → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { folderNumber: 'RT-U', folderName: 'Upd' });
  const id = created.json.folder.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { description: 'd' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { securityClassification: 'NOPE' })).status, 400);
});

test('W26F-RTE-7. POST /:id/move relocates under a new parent', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const a = await request('POST', MOUNT_PATH, { folderNumber: 'RT-MA', folderName: 'MA' });
  const b = await request('POST', MOUNT_PATH, { folderNumber: 'RT-MB', folderName: 'MB' });
  const moved = await request('POST', `${MOUNT_PATH}/${b.json.folder.id}/move`, { parentFolderId: a.json.folder.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.folder.folderPath, '/MA/MB');
});

test('W26F-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { folderNumber: 'RT-AR', folderName: 'Arch' });
  const id = created.json.folder.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26F-RTE-9. DELETE /:id soft-deletes an empty folder (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { folderNumber: 'RT-DEL', folderName: 'Del' });
  const id = created.json.folder.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26F-RTE-10. DELETE /:id on a non-empty folder → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const parent = await request('POST', MOUNT_PATH, { folderNumber: 'RT-NE', folderName: 'NE' });
  const pid = parent.json.folder.id;
  await request('POST', MOUNT_PATH, { folderNumber: 'RT-NEC', folderName: 'NEC', parentFolderId: pid });
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${pid}`)).status, 400);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
