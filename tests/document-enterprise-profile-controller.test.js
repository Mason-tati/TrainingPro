// WP-26 · Phase 12 — Enterprise Employee Competency Profile controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseEmployeeCompetencyProfileController } = require(path.join(EDIR, 'enterprise-employee-competency-profile-controller.js'));

const METHODS = ['createProfile', 'updateProfile', 'getProfile', 'listEmployeeProfiles', 'listCompetencyProfiles', 'compliantProfiles', 'nonCompliantProfiles', 'expiringProfiles', 'expiredProfiles', 'archiveProfile', 'restoreProfile', 'deleteProfile'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', employeeId: '5', competencyId: '3' }, body: {}, query: {} }, over);

test('W26P-CTL-1. create → 201; get/listEmployee/listCompetency/listCompliant/listNonCompliant/listExpiring/listExpired → 200', async () => {
  const ctl = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => ({ ok: true, profile: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listEmployee', 'listCompetency', 'listCompliant', 'listNonCompliant', 'listExpiring', 'listExpired']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26P-CTL-2. update/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26P-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26P-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26P-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseEmployeeCompetencyProfileController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26P-CTL-6. list handlers parse employeeId / competencyId; expiring parses withinDays (present + absent)', async () => {
  let seenEmp = null; let seenComp = null; const seenDays = [];
  const svc = fakeService(() => ({ ok: true }));
  svc.listEmployeeProfiles = async (e) => { seenEmp = e; return { ok: true }; };
  svc.listCompetencyProfiles = async (c) => { seenComp = c; return { ok: true }; };
  svc.expiringProfiles = async (d) => { seenDays.push(d); return { ok: true }; };
  const ctl = createEnterpriseEmployeeCompetencyProfileController(svc);
  await ctl.listEmployee(reqOf({ params: { employeeId: '77' } }), mockRes());
  await ctl.listCompetency(reqOf({ params: { competencyId: '88' } }), mockRes());
  await ctl.listExpiring(reqOf({ query: { withinDays: '14' } }), mockRes());
  await ctl.listExpiring(reqOf({ query: {} }), mockRes());
  assert.equal(seenEmp, 77);
  assert.equal(seenComp, 88);
  assert.deepEqual(seenDays, [14, undefined]);
});

test('W26P-CTL-7. get parses req.params.id; create/update forward id + body', async () => {
  let seenId = null; let body = null; let upd = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getProfile = async (id) => { seenId = id; return { ok: true }; };
  svc.createProfile = async (b) => { body = b; return { ok: true }; };
  svc.updateProfile = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseEmployeeCompetencyProfileController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.create(reqOf({ body: { employeeId: 9 } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { status: 'ACHIEVED' } }), mockRes());
  assert.equal(seenId, 42);
  assert.deepEqual(body, { employeeId: 9 });
  assert.deepEqual(upd, { id: 5, patch: { status: 'ACHIEVED' } });
});
