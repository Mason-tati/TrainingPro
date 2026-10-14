// WP-26 · Phase 7 — Enterprise Document Training controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseDocumentTrainingController } = require(path.join(EDIR, 'enterprise-document-training-controller.js'));

const METHODS = ['createTraining', 'updateTraining', 'getTraining', 'listVersionTraining', 'pendingTraining', 'completedTraining', 'overdueTraining', 'completeTraining', 'archiveTraining', 'restoreTraining', 'deleteTraining'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', versionId: '3' }, body: {}, query: {} }, over);

test('W26T-CTL-1. create → 201; get/listVersion/pending/completed/overdue → 200', async () => {
  const ctl = createEnterpriseDocumentTrainingController(fakeService(() => ({ ok: true, training: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listVersion', 'pending', 'completed', 'overdue']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26T-CTL-2. update/complete/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseDocumentTrainingController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'complete', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26T-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseDocumentTrainingController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseDocumentTrainingController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseDocumentTrainingController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26T-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseDocumentTrainingController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseDocumentTrainingController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26T-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseDocumentTrainingController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseDocumentTrainingController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26T-CTL-6. get parses req.params.id; listVersion parses req.params.versionId', async () => {
  let seenId = null; let seenVer = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getTraining = async (id) => { seenId = id; return { ok: true }; };
  svc.listVersionTraining = async (v) => { seenVer = v; return { ok: true }; };
  const ctl = createEnterpriseDocumentTrainingController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.listVersion(reqOf({ params: { versionId: '88' } }), mockRes());
  assert.equal(seenId, 42);
  assert.equal(seenVer, 88);
});

test('W26T-CTL-7. create forwards req.body; complete forwards id + body', async () => {
  let body = null; let comp = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.createTraining = async (b) => { body = b; return { ok: true }; };
  svc.completeTraining = async (id, input) => { comp = { id, input }; return { ok: true }; };
  const ctl = createEnterpriseDocumentTrainingController(svc);
  await ctl.create(reqOf({ body: { documentVersionId: 9 } }), mockRes());
  await ctl.complete(reqOf({ params: { id: '5' }, body: { assessmentPassed: 1 } }), mockRes());
  assert.deepEqual(body, { documentVersionId: 9 });
  assert.deepEqual(comp, { id: 5, input: { assessmentPassed: 1 } });
});
