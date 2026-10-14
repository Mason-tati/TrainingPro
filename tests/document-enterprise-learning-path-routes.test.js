// WP-26 · Phase 15 — Enterprise Learning Path routes tests (real Express; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT mounted
// in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises the full HTTP
// path (including /mandatory, /active, /role/:id, /program/:id, /competency/:id ordering).
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const LPMig = require(path.join(EDIR, 'enterprise-learning-path-migration.js'));
const LPRepo = require(path.join(EDIR, 'enterprise-learning-path-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-learning-path-service.js'));
const TPMig = require(path.join(EDIR, 'enterprise-training-program-migration.js'));
const TPRepo = require(path.join(EDIR, 'enterprise-training-program-repository.js'));
const KMig = require(path.join(EDIR, 'enterprise-document-competency-migration.js'));
const KRepo = require(path.join(EDIR, 'enterprise-document-competency-repository.js'));
const KSvc = require(path.join(EDIR, 'enterprise-document-competency-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const TRepo = require(path.join(EDIR, 'enterprise-document-training-repository.js'));
const PRepo = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));
const RRepo = require(path.join(EDIR, 'enterprise-competency-recertification-repository.js'));
const { createEnterpriseLearningPathController } = require(path.join(EDIR, 'enterprise-learning-path-controller.js'));
const { createEnterpriseLearningPathRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-learning-path-routes.js'));

let db; let server; let baseUrl; let compId; let programId;
let codeSeq = 0;
const nextCode = () => `RT-LP-${(codeSeq += 1)}`;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await LPMig.migrate(db); await TPMig.migrate(db); await KMig.migrate(db); await VMig.migrate(db);
  await DMig.migrate(db); await FMig.migrate(db);
  const lpRepo = new LPRepo(db); const progRepo = new TPRepo(db); const compRepo = new KRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'LP-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const program = await progRepo.create({ programCode: 'PRG-LP', programName: 'Induction' });
  compId = comp.competency.id; programId = program.id;
  const controller = createEnterpriseLearningPathController(new Service(lpRepo, progRepo, new TRepo(db), compRepo, new PRepo(db), new RRepo(db)));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseLearningPathRoutes(controller));
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
const pathBody = (over) => Object.assign({ pathCode: nextCode(), pathName: 'Induction Path' }, over);

test('W26L-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, pathBody({}))).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/mandatory`)).status, 503);
});

test('W26L-RTE-2. POST creates a learning path (201, default DRAFT)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, pathBody({ mandatory: 1, trainingProgramId: programId, competencyId: compId }));
  assert.equal(r.status, 201);
  assert.equal(r.json.path.status, 'DRAFT');
  assert.equal(r.json.path.mandatory, 1);
});

test('W26L-RTE-3. POST duplicate pathCode → 409; unknown program → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const code = nextCode();
  assert.equal((await request('POST', MOUNT_PATH, { pathCode: code, pathName: 'A' })).status, 201);
  assert.equal((await request('POST', MOUNT_PATH, { pathCode: code, pathName: 'B' })).status, 409);
  assert.equal((await request('POST', MOUNT_PATH, pathBody({ trainingProgramId: 99999 }))).status, 400);
});

test('W26L-RTE-4. GET /mandatory, /active, /role/:id, /program/:id, /competency/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  await request('POST', MOUNT_PATH, pathBody({ mandatory: 1, roleId: 55, trainingProgramId: programId, competencyId: compId }));
  assert.ok((await request('GET', `${MOUNT_PATH}/mandatory`)).json.paths.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/active`)).json.paths.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/role/55`)).json.paths.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/program/${programId}`)).json.paths.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/competency/${compId}`)).json.paths.length >= 1);
});

test('W26L-RTE-5. GET /:id returns a learning path; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, pathBody({}));
  const id = created.json.path.id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26L-RTE-6. PUT /:id updates; invalid status → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, pathBody({}));
  const id = created.json.path.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'ACTIVE', sequenceNumber: 4 })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { status: 'WAT' })).status, 400);
});

test('W26L-RTE-7. PUT /:id rejects a self-referential prerequisite → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, pathBody({}));
  const id = created.json.path.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { prerequisitePathId: id })).status, 400);
});

test('W26L-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, pathBody({}));
  const id = created.json.path.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26L-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, pathBody({}));
  const id = created.json.path.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26L-RTE-10. POST with expiry before effective → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, pathBody({ effectiveDate: '2026-06-01', expiryDate: '2026-01-01' }));
  assert.equal(r.status, 400);
});

test('W26L-RTE-11. GET /:id with a non-numeric id still routes to get (unknown → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
});

test('W26L-RTE-12. gate applies to every verb (active/role/program/competency/PUT/DELETE → 503 when disabled)', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('GET', `${MOUNT_PATH}/active`)).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/role/1`)).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/program/${programId}`)).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/competency/${compId}`)).status, 503);
  assert.equal((await request('PUT', `${MOUNT_PATH}/1`, { status: 'ACTIVE' })).status, 503);
  assert.equal((await request('DELETE', `${MOUNT_PATH}/1`)).status, 503);
});
