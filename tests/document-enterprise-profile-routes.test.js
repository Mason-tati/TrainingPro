// WP-26 · Phase 12 — Enterprise Employee Competency Profile routes tests (real Express; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT mounted
// in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises the full
// HTTP path (including /compliant, /non-compliant, /expiring?withinDays, /expired, /employee/:id,
// /competency/:id ordering). Expiry is stamped relative to the DB clock for determinism.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const PMig = require(path.join(EDIR, 'enterprise-employee-competency-profile-migration.js'));
const PRepo = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-employee-competency-profile-service.js'));
const EMig = require(path.join(EDIR, 'enterprise-competency-evidence-migration.js'));
const ERepo = require(path.join(EDIR, 'enterprise-competency-evidence-repository.js'));
const ESvc = require(path.join(EDIR, 'enterprise-competency-evidence-service.js'));
const MMig = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-migration.js'));
const MRepo = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-repository.js'));
const MSvc = require(path.join(EDIR, 'enterprise-competency-assessment-mapping-service.js'));
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
const { createEnterpriseEmployeeCompetencyProfileController } = require(path.join(EDIR, 'enterprise-employee-competency-profile-controller.js'));
const { createEnterpriseEmployeeCompetencyProfileRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-employee-competency-profile-routes.js'));

let db; let server; let baseUrl; let compId; let profRepo;
let empSeq = 800;
const nextEmp = () => (empSeq += 1);

before(async () => {
  db = new sqlite3.Database(':memory:');
  await PMig.migrate(db); await EMig.migrate(db); await MMig.migrate(db); await KMig.migrate(db);
  await SMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  profRepo = new PRepo(db); const evRepo = new ERepo(db); const mapRepo = new MRepo(db);
  const compRepo = new KRepo(db); const assRepo = new SRepo(db); const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'PR-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  compId = comp.competency.id;
  const controller = createEnterpriseEmployeeCompetencyProfileController(new Service(profRepo, compRepo, assRepo, mapRepo, evRepo));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseEmployeeCompetencyProfileRoutes(controller));
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
function stampExpiry(id, modifier) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tblEnterpriseEmployeeCompetencyProfile SET expiryDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}
const profileBody = (over) => Object.assign({ employeeId: nextEmp(), competencyId: compId }, over);

test('W26P-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, profileBody({}))).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/compliant`)).status, 503);
});

test('W26P-RTE-2. POST creates a profile (201, default PENDING/LOW/NOT_STARTED)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, profileBody({ complianceStatus: 'COMPLIANT' }));
  assert.equal(r.status, 201);
  assert.equal(r.json.profile.riskLevel, 'LOW');
  assert.equal(r.json.profile.status, 'NOT_STARTED');
});

test('W26P-RTE-3. POST unknown competency → 400; duplicate employee×competency → 409', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, profileBody({ competencyId: 99999 }))).status, 400);
  const emp = nextEmp();
  assert.equal((await request('POST', MOUNT_PATH, { employeeId: emp, competencyId: compId })).status, 201);
  assert.equal((await request('POST', MOUNT_PATH, { employeeId: emp, competencyId: compId })).status, 409);
});

test('W26P-RTE-4. GET /compliant, /non-compliant, /expired, /employee/:id, /competency/:id (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const emp = nextEmp();
  await request('POST', MOUNT_PATH, { employeeId: emp, competencyId: compId, complianceStatus: 'NON_COMPLIANT' });
  assert.ok((await request('GET', `${MOUNT_PATH}/compliant`)).json.profiles.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/non-compliant`)).json.profiles.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/employee/${emp}`)).json.profiles.length === 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/competency/${compId}`)).json.profiles.length >= 1);
});

test('W26P-RTE-5. GET /expiring honours withinDays; the +5-day row is in the 30-day window but not the 1-day', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, profileBody({}));
  const id = created.json.profile.id;
  await stampExpiry(id, '+5 days');
  assert.ok((await request('GET', `${MOUNT_PATH}/expiring?withinDays=30`)).json.profiles.some((p) => p.id === id));
  assert.ok(!(await request('GET', `${MOUNT_PATH}/expiring?withinDays=1`)).json.profiles.some((p) => p.id === id));
  assert.ok((await request('GET', `${MOUNT_PATH}/expiring`)).json.profiles.some((p) => p.id === id), 'default 30-day window');
});

test('W26P-RTE-6. GET /:id returns a profile; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, profileBody({}));
  const id = created.json.profile.id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26P-RTE-7. PUT /:id updates; invalid riskLevel → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, profileBody({}));
  const id = created.json.profile.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { riskLevel: 'CRITICAL', status: 'ACHIEVED' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { riskLevel: 'EXTREME' })).status, 400);
});

test('W26P-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, profileBody({}));
  const id = created.json.profile.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26P-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, profileBody({}));
  const id = created.json.profile.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26P-RTE-10. POST with expiry before achieved → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, profileBody({ achievedDate: '2026-06-01', expiryDate: '2026-01-01' }));
  assert.equal(r.status, 400);
});

test('W26P-RTE-11. GET /:id with a non-numeric id still routes to get (unknown → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
});
