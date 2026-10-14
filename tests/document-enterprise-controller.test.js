// WP-26 · Phase 1 — Enterprise Document controller tests.
// The controller is a thin HTTP mapper over an injected service (DI). These tests inject a fake
// service to drive every status-mapping and never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseDocumentController } = require(path.join(EDIR, 'enterprise-document-controller.js'));

// A fake service whose every method returns (or throws) a preset value.
function fakeService(behaviour) {
  const methods = ['createDocument', 'updateDocument', 'getDocument', 'listDocuments', 'archiveDocument', 'deleteDocument', 'restoreDocument'];
  const svc = {};
  for (const m of methods) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7' }, body: {}, query: {} }, over);

test('W26-CTL-1. create maps ok → 201; get/list map ok → 200', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => ({ ok: true, document: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  const rg = mockRes(); await ctl.get(reqOf(), rg); assert.equal(rg.code, 200);
  const rl = mockRes(); await ctl.list(reqOf(), rl); assert.equal(rl.code, 200);
});

test('W26-CTL-2. update/archive/restore/remove map ok → 200', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26-CTL-3. VALIDATION → 400', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const res = mockRes(); await ctl.create(reqOf(), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'bad');
});

test('W26-CTL-4. CONFLICT → 409', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const res = mockRes(); await ctl.create(reqOf(), res);
  assert.equal(res.code, 409);
});

test('W26-CTL-5. NOT_FOUND → 404', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const res = mockRes(); await ctl.get(reqOf(), res);
  assert.equal(res.code, 404);
});

test('W26-CTL-6. mapped ERROR code → 500', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const res = mockRes(); await ctl.get(reqOf(), res);
  assert.equal(res.code, 500);
});

test('W26-CTL-7. unknown/absent result code → 500 fallback', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => ({ ok: false, code: 'SOMETHING_ELSE' })));
  const res = mockRes(); await ctl.get(reqOf(), res);
  assert.equal(res.code, 500);
});

test('W26-CTL-8. handler never throws — a thrown Error becomes 500 with its message', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => { throw new Error('kaboom'); }));
  const res = mockRes(); await ctl.get(reqOf(), res);
  assert.equal(res.code, 500);
  assert.equal(res.body.error, 'kaboom');
  assert.equal(res.body.code, 'ERROR');
});

test('W26-CTL-9. handler never throws — a thrown non-Error becomes 500 with a generic message', async () => {
  const ctl = createEnterpriseDocumentController(fakeService(() => { throw 'stringy'; }));
  const res = mockRes(); await ctl.get(reqOf(), res);
  assert.equal(res.code, 500);
  assert.equal(res.body.error, 'ERROR');
});

test('W26-CTL-10. id is parsed from req.params for id-bearing handlers', async () => {
  let seen = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getDocument = async (id) => { seen = id; return { ok: true, id }; };
  const ctl = createEnterpriseDocumentController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  assert.equal(seen, 42);
});
