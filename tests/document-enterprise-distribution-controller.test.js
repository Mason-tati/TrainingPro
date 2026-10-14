// WP-26 · Phase 6 — Enterprise Document Distribution controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseDocumentDistributionController } = require(path.join(EDIR, 'enterprise-document-distribution-controller.js'));

const METHODS = ['createDistribution', 'updateDistribution', 'getDistribution', 'listVersionDistributions', 'pendingDistributions', 'outstandingDistributions', 'acknowledgeDistribution', 'archiveDistribution', 'restoreDistribution', 'deleteDistribution'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', versionId: '3' }, body: {}, query: {} }, over);

test('W26X-CTL-1. create → 201; get/listVersion/pending/outstanding → 200', async () => {
  const ctl = createEnterpriseDocumentDistributionController(fakeService(() => ({ ok: true, distribution: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listVersion', 'pending', 'outstanding']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26X-CTL-2. update/acknowledge/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseDocumentDistributionController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'acknowledge', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26X-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseDocumentDistributionController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseDocumentDistributionController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseDocumentDistributionController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26X-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseDocumentDistributionController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseDocumentDistributionController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26X-CTL-5. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseDocumentDistributionController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseDocumentDistributionController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26X-CTL-6. get parses req.params.id; listVersion parses req.params.versionId', async () => {
  let seenId = null; let seenVer = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getDistribution = async (id) => { seenId = id; return { ok: true }; };
  svc.listVersionDistributions = async (v) => { seenVer = v; return { ok: true }; };
  const ctl = createEnterpriseDocumentDistributionController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.listVersion(reqOf({ params: { versionId: '88' } }), mockRes());
  assert.equal(seenId, 42);
  assert.equal(seenVer, 88);
});

test('W26X-CTL-7. create forwards req.body; update forwards id + body', async () => {
  let body = null; let upd = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.createDistribution = async (b) => { body = b; return { ok: true }; };
  svc.updateDistribution = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseDocumentDistributionController(svc);
  await ctl.create(reqOf({ body: { documentVersionId: 9 } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { deliveryMethod: 'SMS' } }), mockRes());
  assert.deepEqual(body, { documentVersionId: 9 });
  assert.deepEqual(upd, { id: 5, patch: { deliveryMethod: 'SMS' } });
});
