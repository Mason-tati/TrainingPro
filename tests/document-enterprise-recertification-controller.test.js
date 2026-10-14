// WP-26 · Phase 13 — Enterprise Competency Recertification controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseCompetencyRecertificationController } = require(path.join(EDIR, 'enterprise-competency-recertification-controller.js'));

const METHODS = ['createRecertification', 'updateRecertification', 'getRecertification', 'listEmployeeRecertifications', 'listCompetencyRecertifications', 'dueRecertifications', 'scheduledRecertifications', 'completedRecertifications', 'overdueRecertifications', 'archiveRecertification', 'restoreRecertification', 'deleteRecertification'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', employeeId: '5', competencyId: '3' }, body: {}, query: {} }, over);

test('W26R-CTL-1. create → 201; get/listEmployee/listCompetency/listDue/listScheduled/listCompleted/listOverdue → 200', async () => {
  const ctl = createEnterpriseCompetencyRecertificationController(fakeService(() => ({ ok: true, recertification: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listEmployee', 'listCompetency', 'listDue', 'listScheduled', 'listCompleted', 'listOverdue']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26R-CTL-2. update/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseCompetencyRecertificationController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26R-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseCompetencyRecertificationController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseCompetencyRecertificationController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseCompetencyRecertificationController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26R-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseCompetencyRecertificationController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseCompetencyRecertificationController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26R-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseCompetencyRecertificationController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseCompetencyRecertificationController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26R-CTL-6. list handlers parse employeeId / competencyId params', async () => {
  let seenEmp = null; let seenComp = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.listEmployeeRecertifications = async (e) => { seenEmp = e; return { ok: true }; };
  svc.listCompetencyRecertifications = async (c) => { seenComp = c; return { ok: true }; };
  const ctl = createEnterpriseCompetencyRecertificationController(svc);
  await ctl.listEmployee(reqOf({ params: { employeeId: '77' } }), mockRes());
  await ctl.listCompetency(reqOf({ params: { competencyId: '88' } }), mockRes());
  assert.equal(seenEmp, 77);
  assert.equal(seenComp, 88);
});

test('W26R-CTL-7. get parses req.params.id; create/update forward id + body', async () => {
  let seenId = null; let body = null; let upd = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getRecertification = async (id) => { seenId = id; return { ok: true }; };
  svc.createRecertification = async (b) => { body = b; return { ok: true }; };
  svc.updateRecertification = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseCompetencyRecertificationController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.create(reqOf({ body: { employeeProfileId: 9 } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { status: 'SCHEDULED' } }), mockRes());
  assert.equal(seenId, 42);
  assert.deepEqual(body, { employeeProfileId: 9 });
  assert.deepEqual(upd, { id: 5, patch: { status: 'SCHEDULED' } });
});
