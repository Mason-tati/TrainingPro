// WP-26 · Phase 11 — Enterprise Competency Evidence controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseCompetencyEvidenceController } = require(path.join(EDIR, 'enterprise-competency-evidence-controller.js'));

const METHODS = ['createEvidence', 'updateEvidence', 'verifyEvidence', 'getEvidence', 'listEmployeeEvidence', 'listCompetencyEvidence', 'listAssessmentEvidence', 'pendingEvidence', 'verifiedEvidence', 'expiredEvidence', 'archiveEvidence', 'restoreEvidence', 'deleteEvidence'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', employeeId: '5', competencyId: '3', assessmentId: '4' }, body: {}, query: {} }, over);

test('W26E-CTL-1. create → 201; get/listEmployee/listCompetency/listAssessment/pending/verified/expired → 200', async () => {
  const ctl = createEnterpriseCompetencyEvidenceController(fakeService(() => ({ ok: true, evidence: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listEmployee', 'listCompetency', 'listAssessment', 'pending', 'verified', 'expired']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26E-CTL-2. update/verify/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseCompetencyEvidenceController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'verify', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26E-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseCompetencyEvidenceController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseCompetencyEvidenceController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseCompetencyEvidenceController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26E-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseCompetencyEvidenceController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseCompetencyEvidenceController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26E-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseCompetencyEvidenceController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseCompetencyEvidenceController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26E-CTL-6. list handlers parse employeeId / competencyId / assessmentId params', async () => {
  let seenEmp = null; let seenComp = null; let seenAss = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.listEmployeeEvidence = async (e) => { seenEmp = e; return { ok: true }; };
  svc.listCompetencyEvidence = async (c) => { seenComp = c; return { ok: true }; };
  svc.listAssessmentEvidence = async (a) => { seenAss = a; return { ok: true }; };
  const ctl = createEnterpriseCompetencyEvidenceController(svc);
  await ctl.listEmployee(reqOf({ params: { employeeId: '77' } }), mockRes());
  await ctl.listCompetency(reqOf({ params: { competencyId: '88' } }), mockRes());
  await ctl.listAssessment(reqOf({ params: { assessmentId: '99' } }), mockRes());
  assert.equal(seenEmp, 77);
  assert.equal(seenComp, 88);
  assert.equal(seenAss, 99);
});

test('W26E-CTL-7. get parses req.params.id; create/update/verify forward id + body', async () => {
  let seenId = null; let body = null; let upd = null; let ver = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getEvidence = async (id) => { seenId = id; return { ok: true }; };
  svc.createEvidence = async (b) => { body = b; return { ok: true }; };
  svc.updateEvidence = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  svc.verifyEvidence = async (id, patch) => { ver = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseCompetencyEvidenceController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.create(reqOf({ body: { employeeId: 9 } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { evidenceTitle: 'z' } }), mockRes());
  await ctl.verify(reqOf({ params: { id: '6' }, body: { verifiedBy: 3 } }), mockRes());
  assert.equal(seenId, 42);
  assert.deepEqual(body, { employeeId: 9 });
  assert.deepEqual(upd, { id: 5, patch: { evidenceTitle: 'z' } });
  assert.deepEqual(ver, { id: 6, patch: { verifiedBy: 3 } });
});
