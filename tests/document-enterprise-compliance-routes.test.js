// WP-26 · Phase 18 (FINAL) — Enterprise Compliance routes tests (real Express; gated).
// REST router GATED behind runtime-feature-flag: disabled → 503. Created for testing only; NOT mounted
// in server.js. network-guard permits 127.0.0.1, so an ephemeral loopback server exercises the full HTTP
// path (including /compliant, /non-compliant, /expired, /overdue, and the six /by-relation routes). Expiry
// is stamped relative to the DB clock for determinism.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const XMig = require(path.join(EDIR, 'enterprise-compliance-migration.js'));
const XRepo = require(path.join(EDIR, 'enterprise-compliance-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-compliance-service.js'));
const CTMig = require(path.join(EDIR, 'enterprise-certification-migration.js'));
const CTRepo = require(path.join(EDIR, 'enterprise-certification-repository.js'));
const QMig = require(path.join(EDIR, 'enterprise-qualification-migration.js'));
const QRepo = require(path.join(EDIR, 'enterprise-qualification-repository.js'));
const LPMig = require(path.join(EDIR, 'enterprise-learning-path-migration.js'));
const LPRepo = require(path.join(EDIR, 'enterprise-learning-path-repository.js'));
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
const PRepo = require(path.join(EDIR, 'enterprise-employee-competency-profile-repository.js'));
const RRepo = require(path.join(EDIR, 'enterprise-competency-recertification-repository.js'));
const { createEnterpriseComplianceController } = require(path.join(EDIR, 'enterprise-compliance-controller.js'));
const { createEnterpriseComplianceRoutes, MOUNT_PATH } = require(path.join(EDIR, 'enterprise-compliance-routes.js'));

let db; let server; let baseUrl; let compId; let qualificationId; let certificationId; let learningPathId;
let empSeq = 900;
const nextEmp = () => (empSeq += 1);

before(async () => {
  db = new sqlite3.Database(':memory:');
  await XMig.migrate(db); await CTMig.migrate(db); await QMig.migrate(db); await LPMig.migrate(db);
  await KMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const xRepo = new XRepo(db); const certRepo = new CTRepo(db); const qualRepo = new QRepo(db); const lpRepo = new LPRepo(db); const compRepo = new KRepo(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'CO-DOC', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const comp = await new KSvc(compRepo, verRepo).createCompetency({ documentVersionId: ver.version.id, competencyId: 100, competencyCode: 'C-1', competencyName: 'Safety' });
  const qual = await qualRepo.create({ qualificationCode: 'QL-X', qualificationName: 'Forklift Licence' });
  const lp = await lpRepo.create({ pathCode: 'LP-X', pathName: 'Induction Path' });
  const cert = await certRepo.create({ certificationCode: 'CT-X', certificationName: 'Forklift Certificate' });
  compId = comp.competency.id; qualificationId = qual.id; learningPathId = lp.id; certificationId = cert.id;
  const controller = createEnterpriseComplianceController(new Service(xRepo, certRepo, qualRepo, lpRepo, new TPRepo(db), compRepo, new PRepo(db), new RRepo(db)));
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createEnterpriseComplianceRoutes(controller));
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
    db.run("UPDATE tblEnterpriseCompliance SET expiryDate = datetime('now', ?) WHERE id = ?", [modifier, id], (e) => (e ? reject(e) : resolve()));
  });
}
const complianceBody = (over) => Object.assign({ employeeId: nextEmp() }, over);

test('W26X-RTE-1. gate: disabled flag → 503', async () => {
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('POST', MOUNT_PATH, complianceBody({}))).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/compliant`)).status, 503);
});

test('W26X-RTE-2. POST creates a compliance record (201, default PENDING/LOW, not overdue)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, complianceBody({ certificationId, qualificationId, learningPathId, competencyId: compId }));
  assert.equal(r.status, 201);
  assert.equal(r.json.compliance.complianceStatus, 'PENDING');
  assert.equal(r.json.compliance.riskLevel, 'LOW');
  assert.equal(r.json.compliance.overdue, 0);
});

test('W26X-RTE-3. POST missing employeeId → 400; unknown certification → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('POST', MOUNT_PATH, complianceBody({ employeeId: 0 }))).status, 400);
  assert.equal((await request('POST', MOUNT_PATH, complianceBody({ certificationId: 99999 }))).status, 400);
});

test('W26X-RTE-4. GET /compliant, /non-compliant, /expired, /overdue and the by-relation routes (not shadowed by /:id)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const emp = nextEmp();
  await request('POST', MOUNT_PATH, { employeeId: emp, roleId: 55, certificationId, qualificationId, learningPathId, competencyId: compId, complianceStatus: 'COMPLIANT' });
  await request('POST', MOUNT_PATH, complianceBody({ complianceStatus: 'NON_COMPLIANT' }));
  const exp = await request('POST', MOUNT_PATH, complianceBody({}));
  await stampExpiry(exp.json.compliance.id, '-5 days');
  assert.ok((await request('GET', `${MOUNT_PATH}/compliant`)).json.compliance.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/non-compliant`)).json.compliance.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/overdue`)).json.compliance.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/expired`)).json.compliance.some((r) => r.id === exp.json.compliance.id));
  assert.equal((await request('GET', `${MOUNT_PATH}/employee/${emp}`)).json.compliance.length, 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/role/55`)).json.compliance.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/qualification/${qualificationId}`)).json.compliance.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/certification/${certificationId}`)).json.compliance.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/learning-path/${learningPathId}`)).json.compliance.length >= 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/competency/${compId}`)).json.compliance.length >= 1);
});

test('W26X-RTE-5. GET /:id returns a compliance record; unknown → 404', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, complianceBody({}));
  const id = created.json.compliance.id;
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/999999`)).status, 404);
});

test('W26X-RTE-6. PUT /:id updates; invalid complianceStatus → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, complianceBody({}));
  const id = created.json.compliance.id;
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { complianceStatus: 'COMPLIANT', riskLevel: 'HIGH' })).status, 200);
  assert.equal((await request('PUT', `${MOUNT_PATH}/${id}`, { complianceStatus: 'WAT' })).status, 400);
});

test('W26X-RTE-7. PUT /:id to NON_COMPLIANT derives overdue and surfaces in /overdue', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, complianceBody({ complianceStatus: 'COMPLIANT' }));
  const id = created.json.compliance.id;
  const upd = await request('PUT', `${MOUNT_PATH}/${id}`, { complianceStatus: 'NON_COMPLIANT' });
  assert.equal(upd.json.compliance.overdue, 1);
  assert.ok((await request('GET', `${MOUNT_PATH}/overdue`)).json.compliance.some((r) => r.id === id));
});

test('W26X-RTE-8. POST /:id/archive then /:id/restore', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, complianceBody({}));
  const id = created.json.compliance.id;
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${MOUNT_PATH}/${id}/restore`)).status, 200);
});

test('W26X-RTE-9. DELETE /:id soft-deletes (subsequent GET → 404)', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const created = await request('POST', MOUNT_PATH, complianceBody({}));
  const id = created.json.compliance.id;
  assert.equal((await request('DELETE', `${MOUNT_PATH}/${id}`)).status, 200);
  assert.equal((await request('GET', `${MOUNT_PATH}/${id}`)).status, 404);
});

test('W26X-RTE-10. POST with expiry before compliant → 400', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  const r = await request('POST', MOUNT_PATH, complianceBody({ compliantDate: '2026-06-01', expiryDate: '2026-01-01' }));
  assert.equal(r.status, 400);
});

test('W26X-RTE-11. GET /:id with a non-numeric id still routes to get (unknown → 404); gate applies to every verb', async () => {
  process.env.DOCUMENT_ENGINE_ENABLED = 'true';
  assert.equal((await request('GET', `${MOUNT_PATH}/abc`)).status, 404);
  delete process.env.DOCUMENT_ENGINE_ENABLED;
  assert.equal((await request('GET', `${MOUNT_PATH}/expired`)).status, 503);
  assert.equal((await request('GET', `${MOUNT_PATH}/employee/1`)).status, 503);
  assert.equal((await request('PUT', `${MOUNT_PATH}/1`, { complianceStatus: 'COMPLIANT' })).status, 503);
  assert.equal((await request('DELETE', `${MOUNT_PATH}/1`)).status, 503);
});
