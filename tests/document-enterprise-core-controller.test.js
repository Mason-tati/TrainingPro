// WP-26 · Phase 3 — Enterprise Document Core controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseDocumentCoreController } = require(path.join(EDIR, 'enterprise-document-core-controller.js'));

const METHODS = ['createDocument', 'updateDocument', 'getDocument', 'searchDocuments', 'listFolderDocuments', 'archiveDocument', 'restoreDocument', 'deleteDocument'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', folderId: '3' }, body: {}, query: {} }, over);

test('W26C-CTL-1. create → 201; get/search/listFolder → 200', async () => {
  const ctl = createEnterpriseDocumentCoreController(fakeService(() => ({ ok: true, document: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'search', 'listFolder']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26C-CTL-2. update/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseDocumentCoreController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26C-CTL-3. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseDocumentCoreController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 400); assert.equal(r1.body.error, 'bad');
  const c2 = createEnterpriseDocumentCoreController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r2 = mockRes(); await c2.create(reqOf(), r2); assert.equal(r2.code, 409);
  const c3 = createEnterpriseDocumentCoreController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r3 = mockRes(); await c3.get(reqOf(), r3); assert.equal(r3.code, 404);
});

test('W26C-CTL-4. mapped ERROR → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseDocumentCoreController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseDocumentCoreController(fakeService(() => ({ ok: false, code: 'WEIRD' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26C-CTL-5. handler never throws — thrown Error → 500 with message; non-Error → generic', async () => {
  const c1 = createEnterpriseDocumentCoreController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createEnterpriseDocumentCoreController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('W26C-CTL-6. get parses req.params.id; listFolder parses req.params.folderId', async () => {
  let seenId = null; let seenFolder = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.getDocument = async (id) => { seenId = id; return { ok: true }; };
  svc.listFolderDocuments = async (fid) => { seenFolder = fid; return { ok: true }; };
  const ctl = createEnterpriseDocumentCoreController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.listFolder(reqOf({ params: { folderId: '99' } }), mockRes());
  assert.equal(seenId, 42);
  assert.equal(seenFolder, 99);
});

test('W26C-CTL-7. create forwards req.body; search forwards req.query', async () => {
  let body = null; let query = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.createDocument = async (b) => { body = b; return { ok: true }; };
  svc.searchDocuments = async (q) => { query = q; return { ok: true }; };
  const ctl = createEnterpriseDocumentCoreController(svc);
  await ctl.create(reqOf({ body: { documentNumber: 'Z' } }), mockRes());
  await ctl.search(reqOf({ query: { text: 'x' } }), mockRes());
  assert.deepEqual(body, { documentNumber: 'Z' });
  assert.deepEqual(query, { text: 'x' });
});

test('W26C-CTL-8. update forwards id + body', async () => {
  let seen = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.updateDocument = async (id, patch) => { seen = { id, patch }; return { ok: true }; };
  const ctl = createEnterpriseDocumentCoreController(svc);
  await ctl.update(reqOf({ params: { id: '5' }, body: { status: 'APPROVED' } }), mockRes());
  assert.deepEqual(seen, { id: 5, patch: { status: 'APPROVED' } });
});
