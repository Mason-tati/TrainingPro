// WP-26 · Phase 2 — Enterprise Folder controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const { createEnterpriseFolderController } = require(path.join(EDIR, 'enterprise-folder-controller.js'));

const METHODS = ['createFolder', 'updateFolder', 'getFolder', 'listRootFolders', 'listChildren', 'moveFolder', 'archiveFolder', 'restoreFolder', 'deleteFolder'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7' }, body: {}, query: {} }, over);

test('W26F-CTL-1. create → 201; get/listRoot/listChildren → 200', async () => {
  const ctl = createEnterpriseFolderController(fakeService(() => ({ ok: true, folder: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'listRoot', 'listChildren']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26F-CTL-2. update/move/archive/restore/remove → 200', async () => {
  const ctl = createEnterpriseFolderController(fakeService(() => ({ ok: true })));
  for (const h of ['update', 'move', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('W26F-CTL-3. VALIDATION → 400', async () => {
  const ctl = createEnterpriseFolderController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'bad' })));
  const res = mockRes(); await ctl.create(reqOf(), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'bad');
});

test('W26F-CTL-4. CONFLICT → 409; NOT_FOUND → 404', async () => {
  const c1 = createEnterpriseFolderController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const r1 = mockRes(); await c1.create(reqOf(), r1); assert.equal(r1.code, 409);
  const c2 = createEnterpriseFolderController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 404);
});

test('W26F-CTL-5. mapped ERROR code → 500; unknown code → 500 fallback', async () => {
  const c1 = createEnterpriseFolderController(fakeService(() => ({ ok: false, code: 'ERROR' })));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500);
  const c2 = createEnterpriseFolderController(fakeService(() => ({ ok: false, code: 'WHATEVER' })));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500);
});

test('W26F-CTL-6. handler never throws — thrown Error → 500 with its message', async () => {
  const ctl = createEnterpriseFolderController(fakeService(() => { throw new Error('kaboom'); }));
  const res = mockRes(); await ctl.get(reqOf(), res);
  assert.equal(res.code, 500);
  assert.equal(res.body.error, 'kaboom');
});

test('W26F-CTL-7. handler never throws — thrown non-Error → 500 generic', async () => {
  const ctl = createEnterpriseFolderController(fakeService(() => { throw 'stringy'; }));
  const res = mockRes(); await ctl.get(reqOf(), res);
  assert.equal(res.code, 500);
  assert.equal(res.body.error, 'ERROR');
});

test('W26F-CTL-8. move forwards req.params.id and req.body.parentFolderId to the service', async () => {
  let seen = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.moveFolder = async (id, parentId) => { seen = { id, parentId }; return { ok: true }; };
  const ctl = createEnterpriseFolderController(svc);
  await ctl.move(reqOf({ params: { id: '12' }, body: { parentFolderId: 3 } }), mockRes());
  assert.deepEqual(seen, { id: 12, parentId: 3 });
});
