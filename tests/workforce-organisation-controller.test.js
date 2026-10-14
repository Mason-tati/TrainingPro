// EWP-01b — Reference & Organisation — controller tests.
// Thin HTTP mapper built from the generic handler factory; a fake service drives status mapping and
// level/id/code extraction.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RDIR = path.join(__dirname, '..', 'lib', 'workforce', 'reference');
const { createOrganisationController } = require(path.join(RDIR, 'organisation-controller.js'));

function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { level: 'COMPANY', id: '7' }, body: {}, query: {} }, over);
const CRUD = ['create', 'get', 'update', 'list', 'archive', 'restore', 'remove'];
const HIER = ['children', 'parent', 'ancestors', 'descendants', 'tree', 'breadcrumb', 'lookup', 'hierarchy'];
const SVC_METHODS = ['createNode', 'getNode', 'updateNode', 'listLevel', 'archiveNode', 'restoreNode', 'removeNode', 'children', 'parent', 'ancestors', 'descendants', 'tree', 'breadcrumb', 'lookupByCode', 'hierarchy'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of SVC_METHODS) svc[m] = async () => behaviour(m);
  return svc;
}

test('EWP-OCTL-1. create → 201; all other handlers → 200', async () => {
  const ctl = createOrganisationController(fakeService(() => ({ ok: true, node: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of CRUD.slice(1).concat(HIER)) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('EWP-OCTL-2. { ok:false } codes map to HTTP status; never-throw on exceptions', async () => {
  const ctlV = createOrganisationController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'e' })));
  const rv = mockRes(); await ctlV.create(reqOf(), rv); assert.equal(rv.code, 400);
  const ctlC = createOrganisationController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const rc = mockRes(); await ctlC.create(reqOf(), rc); assert.equal(rc.code, 409);
  const ctlN = createOrganisationController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const rn = mockRes(); await ctlN.get(reqOf(), rn); assert.equal(rn.code, 404);
  const ctlT = createOrganisationController(fakeService(() => { throw new Error('kaboom'); }));
  const rt = mockRes(); await ctlT.get(reqOf(), rt); assert.equal(rt.code, 500); assert.equal(rt.body.error, 'kaboom');
});

test('EWP-OCTL-3. handlers forward level / id / body / query.code to the service', async () => {
  const seen = {};
  const svc = fakeService(() => ({ ok: true }));
  svc.createNode = async (level, body) => { seen.create = { level, body }; return { ok: true }; };
  svc.getNode = async (level, id) => { seen.get = { level, id }; return { ok: true }; };
  svc.updateNode = async (level, id, patch) => { seen.update = { level, id, patch }; return { ok: true }; };
  svc.listLevel = async (level, filters) => { seen.list = { level, filters }; return { ok: true }; };
  svc.children = async (level, id) => { seen.children = { level, id }; return { ok: true }; };
  svc.lookupByCode = async (level, code) => { seen.lookup = { level, code }; return { ok: true }; };
  const ctl = createOrganisationController(svc);
  await ctl.create(reqOf({ params: { level: 'SITE' }, body: { code: 'S' } }), mockRes());
  await ctl.get(reqOf({ params: { level: 'SITE', id: '42' } }), mockRes());
  await ctl.update(reqOf({ params: { level: 'SITE', id: '5' }, body: { name: 'X' } }), mockRes());
  await ctl.list(reqOf({ params: { level: 'SITE' }, query: { code: 'S' } }), mockRes());
  await ctl.children(reqOf({ params: { level: 'DIVISION', id: '9' } }), mockRes());
  await ctl.lookup(reqOf({ params: { level: 'SITE' }, query: { code: 'SITE-1' } }), mockRes());
  assert.deepEqual(seen.create, { level: 'SITE', body: { code: 'S' } });
  assert.deepEqual(seen.get, { level: 'SITE', id: 42 });
  assert.deepEqual(seen.update, { level: 'SITE', id: 5, patch: { name: 'X' } });
  assert.deepEqual(seen.list, { level: 'SITE', filters: { code: 'S' } });
  assert.deepEqual(seen.children, { level: 'DIVISION', id: 9 });
  assert.deepEqual(seen.lookup, { level: 'SITE', code: 'SITE-1' });
});

test('EWP-OCTL-5. lifecycle + remaining hierarchy handlers forward level + id', async () => {
  const seen = {};
  const svc = fakeService(() => ({ ok: true }));
  for (const [h, m] of [['archive', 'archiveNode'], ['restore', 'restoreNode'], ['remove', 'removeNode'], ['ancestors', 'ancestors'], ['descendants', 'descendants'], ['tree', 'tree'], ['breadcrumb', 'breadcrumb'], ['parent', 'parent']]) {
    svc[m] = async (level, id) => { seen[h] = { level, id }; return { ok: true }; };
  }
  const ctl = createOrganisationController(svc);
  const req = reqOf({ params: { level: 'DEPARTMENT', id: '12' } });
  for (const h of ['archive', 'restore', 'remove', 'ancestors', 'descendants', 'tree', 'breadcrumb', 'parent']) {
    await ctl[h](req, mockRes());
    assert.deepEqual(seen[h], { level: 'DEPARTMENT', id: 12 }, `${h} forwards level+id`);
  }
});

test('EWP-OCTL-4. hierarchy handler takes no params and calls service.hierarchy', async () => {
  let called = false;
  const svc = fakeService(() => ({ ok: true }));
  svc.hierarchy = async () => { called = true; return { ok: true, hierarchy: [] }; };
  const ctl = createOrganisationController(svc);
  const res = mockRes(); await ctl.hierarchy(reqOf(), res);
  assert.equal(res.code, 200);
  assert.equal(called, true);
});
