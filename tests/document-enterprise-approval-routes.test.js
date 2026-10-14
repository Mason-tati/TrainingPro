// WP-26 · Phase 5 — Enterprise Document Approval routes tests (real Express over loopback; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT
// mounted in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises
// the full HTTP path (including /pending & /version/:id ordering before /:id).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const AMig = require(path.join(EDIR, 'enterprise-document-approval-migration.js'));
const ARepo = require(path.join(EDIR, 'enterprise-document-approval-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-approval-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const { createEnterpriseDocumentApprovalController } = require(path.join(EDIR, 'enterprise-document-approval-controller.js'));
const { createEnterpriseDocumentApprovalRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-document-approval-routes.js'));

let db; let server; let baseUrl; let verId; let versionSvc; let mainDocId; let nextMajor = 5;

// Create a fresh, independent document version (so lifecycle tests are not blocked by sequencing).
async function newVersionId() {
  nextMajor += 1;
  const v = await versionSvc.createVersion({ documentId: mainDocId, majorVersion: nextMajor, minorVersion: 0 });
  return v.version.id;
}

before(async () => {
  db = new sqlite3.Database(':memory:');
  await AMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'RT-DOC', documentTitle: 'Spec' });
  mainDocId = doc.document.id;
  versionSvc = new VSvc(verRepo, docRepo);
  const ver = await versionSvc.createVersion({ documentId: mainDocId });
  verId = ver.version.id;
  const controller = createEnterpriseDocumentApprovalController(new Service(new ARepo(db), verRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseDocumentApprovalRoutes(controller));
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

test('W26A-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, { documentVersionId: verId, approverId: 1 })).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/pending`)).status, 503);
});

test('W26A-RTE-2. POST creates a level-1 approval (201)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, { documentVersionId: verId, approvalLevel: 1, approverId: 10 });
  assert.equal(r.status, 201);
  assert.equal(r.json.approval.approvalStatus, 'PENDING');
});

test('W26A-RTE-3. POST duplicate level → 409; level 2 before level 1 approved → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, { documentVersionId: verId, approvalLevel: 1, approverId: 11 })).status, 409);
  assert.equal((await request('POST', MOUNT_PATH, { documentVersionId: verId, approvalLevel: 2, approverId: 20 })).status, 400);
});

test('W26A-RTE-4. GET /pending and GET /version/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.ok((await request('GET', `${MOUNT_PATH}/pending`)).json.approvals.length >= 1);
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.approvals.length >= 1);
});

test('W26A-RTE-5. GET /:id returns an approval; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  const id = list.json.approvals[0].id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26A-RTE-6. POST /:id/approve then a sequenced level-2 approval', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  const l1id = list.json.approvals.find((a) => a.approvalLevel === 1).id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${l1id}/approve`)).status, 200);
  const l2 = await request('POST', MOUNT_PATH, { documentVersionId: verId, approvalLevel: 2, approverId: 20 });
  assert.equal(l2.status, 201);
});

test('W26A-RTE-7. POST /:id/delegate and /:id/reject', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  const l2id = list.json.approvals.find((a) => a.approvalLevel === 2).id;
  const del = await request('POST', `${MOUNT_PATH}/${l2id}/delegate`, { delegatedTo: 25 });
  assert.equal(del.status, 200);
  assert.equal(del.json.approval.approvalStatus, 'DELEGATED');
  assert.equal((await request('POST', `${MOUNT_PATH}/${l2id}/reject`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${l2id}/approve`)).status, 400, 'cannot approve a decided approval');
});

test('W26A-RTE-8. PUT /:id updates content; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const list = await request('GET', `${MOUNT_PATH}/version/${verId}`);
  const id = list.json.approvals[0].id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { approverRole: 'Director' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/999999`, { approverRole: 'x' })).status, 404);
});

test('W26A-RTE-9. POST /:id/archive then /:id/restore (fresh version, level 1)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const freshVer = await newVersionId();
  const created = await request('POST', MOUNT_PATH, { documentVersionId: freshVer, approvalLevel: 1, approverId: 30 });
  const id = created.json.approval.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26A-RTE-10. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const freshVer = await newVersionId();
  const created = await request('POST', MOUNT_PATH, { documentVersionId: freshVer, approvalLevel: 1, approverId: 40 });
  const id = created.json.approval.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
