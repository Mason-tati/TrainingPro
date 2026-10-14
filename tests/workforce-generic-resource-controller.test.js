// EWP-01a — Workforce Foundation Framework — generic-resource-controller tests.
// Thin HTTP mapper over an injected service (DI). A fake service drives every status-mapping and
// never-throw branch deterministically.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WDIR = path.join(__dirname, '..', 'lib', 'workforce');
const { createResourceController, handler, ERROR_STATUS } = require(path.join(WDIR, 'generic-resource-controller.js'));

const METHODS = ['create', 'get', 'update', 'list', 'listActive', 'listBy', 'archive', 'restore', 'remove'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const reqOf = (over = {}) => Object.assign({ params: { id: '7', roleId: '3' }, body: {}, query: {} }, over);

test('EWP-CTL-1. create → 201; get/update/list/listActive/archive/restore/remove → 200', async () => {
  const ctl = createResourceController(fakeService(() => ({ ok: true, record: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'update', 'list', 'listActive', 'archive', 'restore', 'remove']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('EWP-CTL-2. VALIDATION → 400; CONFLICT → 409; NOT_FOUND → 404; ERROR/unknown → 500', async () => {
  const map = { VALIDATION: 400, CONFLICT: 409, NOT_FOUND: 404, ERROR: 500, WEIRD: 500 };
  for (const [code, status] of Object.entries(map)) {
    const ctl = createResourceController(fakeService(() => ({ ok: false, code, error: 'e' })));
    const res = mockRes(); await ctl.get(reqOf(), res); assert.equal(res.code, status, `${code} → ${status}`);
  }
  assert.deepEqual(ERROR_STATUS, { VALIDATION: 400, CONFLICT: 409, NOT_FOUND: 404, ERROR: 500 });
});

test('EWP-CTL-3. handler never throws — Error → 500 with message; non-Error → generic', async () => {
  const c1 = createResourceController(fakeService(() => { throw new Error('kaboom'); }));
  const r1 = mockRes(); await c1.get(reqOf(), r1); assert.equal(r1.code, 500); assert.equal(r1.body.error, 'kaboom');
  const c2 = createResourceController(fakeService(() => { throw 'stringy'; }));
  const r2 = mockRes(); await c2.get(reqOf(), r2); assert.equal(r2.code, 500); assert.equal(r2.body.error, 'ERROR');
});

test('EWP-CTL-4. default id param parsing; create/update forward body; list forwards query', async () => {
  let seenId = null; let body = null; let upd = null; let query = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.get = async (id) => { seenId = id; return { ok: true }; };
  svc.create = async (b) => { body = b; return { ok: true }; };
  svc.update = async (id, patch) => { upd = { id, patch }; return { ok: true }; };
  svc.list = async (q) => { query = q; return { ok: true }; };
  const ctl = createResourceController(svc);
  await ctl.get(reqOf({ params: { id: '42' } }), mockRes());
  await ctl.create(reqOf({ body: { label: 'X' } }), mockRes());
  await ctl.update(reqOf({ params: { id: '5' }, body: { label: 'Y' } }), mockRes());
  await ctl.list(reqOf({ query: { category: 'X' } }), mockRes());
  assert.equal(seenId, 42);
  assert.deepEqual(body, { label: 'X' });
  assert.deepEqual(upd, { id: 5, patch: { label: 'Y' } });
  assert.deepEqual(query, { category: 'X' });
});

test('EWP-CTL-5. custom paramId; options non-object falls back to defaults', async () => {
  let seenId = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.get = async (id) => { seenId = id; return { ok: true }; };
  const ctl = createResourceController(svc, { paramId: 'personId' });
  await ctl.get(reqOf({ params: { personId: '88' } }), mockRes());
  assert.equal(seenId, 88);
  const dflt = createResourceController(svc, 'not-object');
  const res = mockRes(); await dflt.get(reqOf({ params: { id: '9' } }), res); assert.equal(res.code, 200);
});

test('EWP-CTL-6. listByParam builds a relationship handler (default + explicit param name)', async () => {
  const seen = [];
  const svc = fakeService(() => ({ ok: true }));
  svc.listBy = async (col, val) => { seen.push([col, val]); return { ok: true }; };
  const ctl = createResourceController(svc);
  const byRoleDefault = ctl.listByParam('roleId');
  const byRoleNamed = ctl.listByParam('roleId', 'rid');
  await byRoleDefault(reqOf({ params: { roleId: '3' } }), mockRes());
  await byRoleNamed(reqOf({ params: { rid: '9' } }), mockRes());
  assert.deepEqual(seen, [['roleId', 3], ['roleId', 9]]);
});

test('EWP-CTL-7. exported handler factory maps ok/!ok and never throws', async () => {
  const okH = handler(async () => ({ ok: true }), 201);
  const r1 = mockRes(); await okH(reqOf(), r1); assert.equal(r1.code, 201);
  const badH = handler(async () => ({ ok: false, code: 'CONFLICT' }), 200);
  const r2 = mockRes(); await badH(reqOf(), r2); assert.equal(r2.code, 409);
});
