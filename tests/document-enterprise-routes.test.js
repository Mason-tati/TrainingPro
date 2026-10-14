// WP-26 · Phase 1 — Enterprise Document routes tests (real Express over loopback; gated).
// The router is REST-compliant and GATED behind runtime-feature-flag: disabled → 503, no handler
// runs. It is created here for testing only and is NOT mounted in server.js. network-guard allows
// 127.0.0.1, so an ephemeral loopback server exercises the full HTTP path.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-service.js'));
const { createEnterpriseDocumentController } = require(path.join(EDIR, 'enterprise-document-controller.js'));
const { createEnterpriseDocumentRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-document-routes.js'));

let db; let server; let baseUrl;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  const controller = createEnterpriseDocumentController(new Service(new Repository(db)));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseDocumentRoutes(controller));
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

test('W26-RTE-1. gate: disabled flag → 503 for every route (no handler runs)', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  const r = await request('POST', MOUNT_PATH, { documentNumber: 'GATED', title: 'x' });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'DISABLED');
  assert.equal((await request('GET', MOUNT_PATH)).status, 503);
});

test('W26-RTE-2. POST creates a document (201) when enabled', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { documentNumber: 'RT-1', title: 'Route Doc', category: 'OPS' });
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.document.id >= 1);
});

test('W26-RTE-3. POST duplicate number → 409', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, { documentNumber: 'RT-DUP', title: 'A' });
  const r = await request('POST', MOUNT_PATH, { documentNumber: 'RT-DUP', title: 'B' });
  assert.equal(r.status, 409);
});

test('W26-RTE-4. GET /:id returns the document; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-2', title: 'Get Me' });
  const id = created.json.document.id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26-RTE-5. GET / lists documents (filterable)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, { documentNumber: 'RT-L1', title: 'a', category: 'LEGAL' });
  const r = await request('GET', `${MOUNT_PATH}?category=LEGAL`);
  assert.equal(r.status, 200);
  assert.equal(r.json.documents.length, 1);
});

test('W26-RTE-6. PUT /:id updates; invalid status → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-3', title: 'Upd' });
  const id = created.json.document.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'APPROVED' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'NOPE' })).status, 400);
});

test('W26-RTE-7. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-4', title: 'Arch' });
  const id = created.json.document.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26-RTE-8. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, { documentNumber: 'RT-5', title: 'Del' });
  const id = created.json.document.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
