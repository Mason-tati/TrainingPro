// WP-26 · Phase 14 — Enterprise Training Program controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseTrainingProgramController } = require(path.join(EDIR, 'enterprise-training-program-controller.js'));

const METHODS = ['createProgram', 'updateProgram', 'getProgram', 'listCompetencyPrograms', 'listTrainerPrograms', 'mandatoryPrograms', 'activePrograms', 'archiveProgram', 'restoreProgram', 'deleteProgram'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', competencyId: '3', trainerId: '4' }, body: {}, query: {} }, over);

test('W26T-CTL-1. create → 201; get/listCompetency/listTrainer/listMandatory/listActive → 200', async () => {
  const ctl = createEnterpriseTrainingProgramController(fakeService(() => ({ ok: true, program: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listCompetency', 'listTrainer', 'listMandatory', 'listActive']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26T-CTL-2. update/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseTrainingProgramController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26T-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseTrainingProgramController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseTrainingProgramController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseTrainingProgramController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26T-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseTrainingProgramController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseTrainingProgramController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26T-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseTrainingProgramController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseTrainingProgramController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26T-CTL-6. list handlers parse competencyId / trainerId params', async () => {
  let seenComp = null; let seenTrainer = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.listCompetencyPrograms = async (c) => { seenComp = c; return { ok: true }; };
  svc.listTrainerPrograms = async (t) => { seenTrainer = t; return { ok: true }; };
  const ctl = createEnterpriseTrainingProgramController(svc);
  await ctl.listCompetency(reqOf({ params: { competencyId: '88' } }), mockRes());
  await ctl.listTrainer(reqOf({ params: { trainerId: '99' } }), mockRes());
  assert.equal(seenComp, 88);
  assert.equal(seenTrainer, 99);
});

test('W26T-CTL-7. get parses req.params.id; create/update forward id + body', async () => {
  let seenId = null; let body = null; let upd = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getProgram = async (id) => { seenId = id; return { ok: true }; };
  svc.createProgram = async (b) => { body = b; return { ok: true }; };
  svc.updateProgram = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseTrainingProgramController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.create(reqOf({ body: { programCode: 'X' } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { status: 'ACTIVE' } }), mockRes());
  assert.equal(seenId, 42);
  assert.deepEqual(body, { programCode: 'X' });
  assert.deepEqual(upd, { id: 5, patch: { status: 'ACTIVE' } });
});
