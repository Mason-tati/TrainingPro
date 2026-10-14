// WP-26 · Phase 8 — Enterprise Document Competency controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseDocumentCompetencyController } = require(path.join(EDIR, 'enterprise-document-competency-controller.js'));

const METHODS = ['createCompetency', 'updateCompetency', 'getCompetency', 'listVersionCompetencies', 'mandatoryCompetencies', 'expiredCompetencies', 'archiveCompetency', 'restoreCompetency', 'deleteCompetency'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', versionId: '3' }, body: {}, query: {} }, over);

test('W26K-CTL-1. create → 201; get/listVersion/mandatory/expired → 200', async () => {
  const ctl = createEnterpriseDocumentCompetencyController(fakeService(() => ({ ok: true, competency: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listVersion', 'mandatory', 'expired']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26K-CTL-2. update/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseDocumentCompetencyController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26K-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseDocumentCompetencyController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseDocumentCompetencyController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseDocumentCompetencyController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26K-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseDocumentCompetencyController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseDocumentCompetencyController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26K-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseDocumentCompetencyController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseDocumentCompetencyController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26K-CTL-6. get parses req.params.id; listVersion parses req.params.versionId', async () => {
  let seenId = null; let seenVer = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getCompetency = async (id) => { seenId = id; return { ok: true }; };
  svc.listVersionCompetencies = async (v) => { seenVer = v; return { ok: true }; };
  const ctl = createEnterpriseDocumentCompetencyController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.listVersion(reqOf({ params: { versionId: '88' } }), mockRes());
  assert.equal(seenId, 42);
  assert.equal(seenVer, 88);
});

test('W26K-CTL-7. create forwards req.body; update forwards id + body', async () => {
  let body = null; let upd = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.createCompetency = async (b) => { body = b; return { ok: true }; };
  svc.updateCompetency = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseDocumentCompetencyController(svc);
  await ctl.create(reqOf({ body: { competencyId: 9 } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { competencyLevel: 'EXPERT' } }), mockRes());
  assert.deepEqual(body, { competencyId: 9 });
  assert.deepEqual(upd, { id: 5, patch: { competencyLevel: 'EXPERT' } });
});
