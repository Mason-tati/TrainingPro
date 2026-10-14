// EWP-01c — Person & Identity — controller tests. Generic CRUD handlers + Person-specific lookup/search
// handlers, driven by a fake service.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPersonController } = require(path.join(__dirname, '..', 'lib', 'workforce', 'person', 'person-controller.js'));

const METHODS = ['create', 'get', 'update', 'list', 'listActive', 'archive', 'restore', 'remove', 'search', 'detectDuplicates', 'findByUuid', 'findByPersonNumber', 'findByEmail', 'findByPassport', 'findByNationalId', 'getAge'];
function fakeService(behaviour) {
  const svc = {};
  for (const m of METHODS) svc[m] = async () => behaviour(m);
  return svc;
}
function mockRes() { return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const reqOf = (over = {}) => Object.assign({ params: { id: '7' }, body: {}, query: {} }, over);

test('EWP-PCTL-1. create → 201; standard + custom read handlers → 200', async () => {
  const ctl = createPersonController(fakeService(() => ({ ok: true, person: { id: 7 } })));
  const rc = mockRes(); await ctl.create(reqOf(), rc); assert.equal(rc.code, 201);
  for (const h of ['get', 'update', 'list', 'listActive', 'archive', 'restore', 'remove', 'search', 'duplicates', 'byUuid', 'byPersonNumber', 'byEmail', 'byPassport', 'byNationalId', 'age']) {
    const res = mockRes(); await ctl[h](reqOf(), res); assert.equal(res.code, 200, `${h} → 200`);
  }
});

test('EWP-PCTL-2. error codes map; never-throw on exceptions', async () => {
  const cV = createPersonController(fakeService(() => ({ ok: false, code: 'VALIDATION', error: 'e' })));
  const rv = mockRes(); await cV.create(reqOf(), rv); assert.equal(rv.code, 400);
  const cC = createPersonController(fakeService(() => ({ ok: false, code: 'CONFLICT' })));
  const rc = mockRes(); await cC.create(reqOf(), rc); assert.equal(rc.code, 409);
  const cN = createPersonController(fakeService(() => ({ ok: false, code: 'NOT_FOUND' })));
  const rn = mockRes(); await cN.byUuid(reqOf(), rn); assert.equal(rn.code, 404);
  const cT = createPersonController(fakeService(() => { throw new Error('kaboom'); }));
  const rt = mockRes(); await cT.byEmail(reqOf(), rt); assert.equal(rt.code, 500); assert.equal(rt.body.error, 'kaboom');
});

test('EWP-PCTL-2b. lifecycle handlers forward the id param to the service', async () => {
  const seen = {};
  const svc = fakeService(() => ({ ok: true }));
  for (const [h, m] of [['get', 'get'], ['update', 'update'], ['archive', 'archive'], ['restore', 'restore'], ['remove', 'remove']]) {
    svc[m] = async (id) => { seen[h] = id; return { ok: true }; };
  }
  const ctl = createPersonController(svc);
  for (const h of ['get', 'update', 'archive', 'restore', 'remove']) {
    await ctl[h](reqOf({ params: { id: '55' } }), mockRes());
    assert.equal(seen[h], 55, `${h} forwards id`);
  }
});

test('EWP-PCTL-2c. create forwards the request body; list forwards the query', async () => {
  let body = null; let query = null;
  const svc = fakeService(() => ({ ok: true }));
  svc.create = async (b) => { body = b; return { ok: true, person: { id: 1 } }; };
  svc.list = async (q) => { query = q; return { ok: true, persons: [] }; };
  const ctl = createPersonController(svc);
  await ctl.create(reqOf({ body: { firstName: 'Jane', lastName: 'Doe' } }), mockRes());
  await ctl.list(reqOf({ query: { nationality: 'AU' } }), mockRes());
  assert.deepEqual(body, { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(query, { nationality: 'AU' });
});

test('EWP-PCTL-3. custom handlers extract path params and query params', async () => {
  const seen = {};
  const svc = fakeService(() => ({ ok: true }));
  svc.findByUuid = async (v) => { seen.uuid = v; return { ok: true }; };
  svc.findByPersonNumber = async (v) => { seen.pnum = v; return { ok: true }; };
  svc.findByEmail = async (v) => { seen.email = v; return { ok: true }; };
  svc.findByPassport = async (v) => { seen.passport = v; return { ok: true }; };
  svc.findByNationalId = async (v) => { seen.nid = v; return { ok: true }; };
  svc.search = async (q) => { seen.search = q; return { ok: true }; };
  svc.detectDuplicates = async (b) => { seen.dup = b; return { ok: true }; };
  svc.getAge = async (id, asOf) => { seen.age = { id, asOf }; return { ok: true }; };
  const ctl = createPersonController(svc);
  await ctl.byUuid(reqOf({ params: { uuid: 'U1' } }), mockRes());
  await ctl.byPersonNumber(reqOf({ params: { personNumber: 'P1' } }), mockRes());
  await ctl.byEmail(reqOf({ query: { email: 'e@x.com' } }), mockRes());
  await ctl.byPassport(reqOf({ query: { passportNumber: 'PA1' } }), mockRes());
  await ctl.byNationalId(reqOf({ query: { nationalId: 'N1' } }), mockRes());
  await ctl.search(reqOf({ query: { lastName: 'Doe' } }), mockRes());
  await ctl.duplicates(reqOf({ body: { email: 'e@x.com' } }), mockRes());
  await ctl.age(reqOf({ params: { id: '42' }, query: { asOf: '2026-01-01' } }), mockRes());
  assert.equal(seen.uuid, 'U1');
  assert.equal(seen.pnum, 'P1');
  assert.equal(seen.email, 'e@x.com');
  assert.equal(seen.passport, 'PA1');
  assert.equal(seen.nid, 'N1');
  assert.deepEqual(seen.search, { lastName: 'Doe' });
  assert.deepEqual(seen.dup, { email: 'e@x.com' });
  assert.deepEqual(seen.age, { id: 42, asOf: '2026-01-01' });
});
