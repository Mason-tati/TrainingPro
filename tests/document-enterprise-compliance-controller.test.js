// WP-26 · Phase 18 (FINAL) — Enterprise Compliance controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseComplianceController } = require(path.join(EDIR, 'enterprise-compliance-controller.js'));

const METHODS = ['createCompliance', 'updateCompliance', 'getCompliance', 'listEmployeeCompliance', 'listRoleCompliance', 'listQualificationCompliance', 'listCertificationCompliance', 'listLearningPathCompliance', 'listCompetencyCompliance', 'compliantRecords', 'nonCompliantRecords', 'expiredRecords', 'overdueRecords', 'archiveCompliance', 'restoreCompliance', 'deleteCompliance'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', employeeId: '2', roleId: '3', qualificationId: '6', certificationId: '9', learningPathId: '5', competencyId: '4' }, body: {}, query: {} }, over);

test('W26X-CTL-1. create → 201; all GET-list handlers → 200', async () => {
  const ctl = createEnterpriseComplianceController(fakeService(() => ({ ok: true, compliance: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listEmployee', 'listRole', 'listQualification', 'listCertification', 'listLearningPath', 'listCompetency', 'listCompliant', 'listNonCompliant', 'listExpired', 'listOverdue']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26X-CTL-2. update/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseComplianceController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26X-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseComplianceController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseComplianceController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseComplianceController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26X-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseComplianceController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseComplianceController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26X-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseComplianceController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseComplianceController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26X-CTL-6. list handlers parse employeeId / roleId / qualificationId / certificationId / learningPathId / competencyId', async () => {
  const seen = {};
  const svc = fakeService(() => ({ ok: true }));
  svc.listEmployeeCompliance = async (v) => { seen.emp = v; return { ok: true }; };
  svc.listRoleCompliance = async (v) => { seen.role = v; return { ok: true }; };
  svc.listQualificationCompliance = async (v) => { seen.qual = v; return { ok: true }; };
  svc.listCertificationCompliance = async (v) => { seen.cert = v; return { ok: true }; };
  svc.listLearningPathCompliance = async (v) => { seen.lp = v; return { ok: true }; };
  svc.listCompetencyCompliance = async (v) => { seen.comp = v; return { ok: true }; };
  const ctl = createEnterpriseComplianceController(svc);
  await ctl.listEmployee(reqOf({ params: { employeeId: '11' } }), mockRes());
  await ctl.listRole(reqOf({ params: { roleId: '22' } }), mockRes());
  await ctl.listQualification(reqOf({ params: { qualificationId: '33' } }), mockRes());
  await ctl.listCertification(reqOf({ params: { certificationId: '44' } }), mockRes());
  await ctl.listLearningPath(reqOf({ params: { learningPathId: '55' } }), mockRes());
  await ctl.listCompetency(reqOf({ params: { competencyId: '66' } }), mockRes());
  assert.deepEqual(seen, { emp: 11, role: 22, qual: 33, cert: 44, lp: 55, comp: 66 });
});

test('W26X-CTL-7. get parses req.params.id; create/update forward id + body', async () => {
  let seenId = null; let body = null; let upd = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getCompliance = async (id) => { seenId = id; return { ok: true }; };
  svc.createCompliance = async (b) => { body = b; return { ok: true }; };
  svc.updateCompliance = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseComplianceController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.create(reqOf({ body: { employeeId: 9 } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { complianceStatus: 'COMPLIANT' } }), mockRes());
  assert.equal(seenId, 42);
  assert.deepEqual(body, { employeeId: 9 });
  assert.deepEqual(upd, { id: 5, patch: { complianceStatus: 'COMPLIANT' } });
});
