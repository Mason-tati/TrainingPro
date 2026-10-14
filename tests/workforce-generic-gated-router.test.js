// EWP-01a — Workforce Foundation Framework — generic-gated-router tests (real Express; gated).
// The router short-circuits to 503 when the workforce flag is disabled; otherwise it registers the
// declarative route table (default + custom) against an injected controller. NOT mounted in server.js.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');

const WDIR = path.join(__dirname, '..', 'lib', 'workforce');
const { createResourceController } = require(path.join(WDIR, 'generic-resource-controller.js'));
const { createGatedRouter, DEFAULT_ROUTES } = require(path.join(WDIR, 'generic-gated-router.js'));
const realFlag = require(path.join(WDIR, 'runtime-feature-flag.js'));
const VAR = 'WORKFORCE_ENGINE_ENABLED';

// Deterministic fake service: enough to drive controller → status codes.
function fakeService() {
  return {
    create: async () => ({ ok: true, record: { id: 1 } }),
    get: async () => ({ ok: false, code: 'NOT_FOUND', error: 'x' }),
    update: async () => ({ ok: true, record: { id: 1 } }),
    list: async () => ({ ok: true, records: [] }),
    listActive: async () => ({ ok: true, records: [] }),
    listBy: async () => ({ ok: true, records: [{ id: 9 }] }),
    archive: async () => ({ ok: true, record: { id: 1 } }),
    restore: async () => ({ ok: true, record: { id: 1 } }),
    remove: async () => ({ ok: true, id: 1 }),
  };
}
const enabledFlag = { isEnabled: () => true };
const disabledFlag = { isEnabled: () => false };

let servers = [];
function boot(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/workforce-test', router);
  const server = app.listen(0);
  servers.push(server);
  return new Promise((r) => server.once('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
}
function request(baseUrl, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(baseUrl + url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
before(() => { delete process.env[VAR]; });
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); delete process.env[VAR]; });

test('EWP-RTR-1. disabled flag → every route 503', async () => {
  const ctl = createResourceController(fakeService());
  const base = await boot(createGatedRouter(ctl, { featureFlag: disabledFlag }));
  assert.equal((await request(base, 'POST', '/api/workforce-test', {})).status, 503);
  assert.equal((await request(base, 'GET', '/api/workforce-test/active')).status, 503);
  assert.equal((await request(base, 'DELETE', '/api/workforce-test/1')).status, 503);
});

test('EWP-RTR-2. enabled flag → default CRUD/lifecycle routes work', async () => {
  const ctl = createResourceController(fakeService());
  const base = await boot(createGatedRouter(ctl, { featureFlag: enabledFlag }));
  assert.equal((await request(base, 'POST', '/api/workforce-test', {})).status, 201);
  assert.equal((await request(base, 'GET', '/api/workforce-test/active')).status, 200);
  assert.equal((await request(base, 'GET', '/api/workforce-test')).status, 200);
  assert.equal((await request(base, 'GET', '/api/workforce-test/5')).status, 404);
  assert.equal((await request(base, 'PUT', '/api/workforce-test/5', {})).status, 200);
  assert.equal((await request(base, 'POST', '/api/workforce-test/5/archive')).status, 200);
  assert.equal((await request(base, 'POST', '/api/workforce-test/5/restore')).status, 200);
  assert.equal((await request(base, 'DELETE', '/api/workforce-test/5')).status, 200);
});

test('EWP-RTR-3. a custom route table registers relationship routes before /:id', async () => {
  const ctl = createResourceController(fakeService());
  ctl.listByRole = ctl.listByParam('roleId');
  const routes = [
    { method: 'get', path: '/role/:roleId', handler: 'listByRole' },
    { method: 'get', path: '/:id', handler: 'get' },
  ];
  const base = await boot(createGatedRouter(ctl, { featureFlag: enabledFlag, routes }));
  const r = await request(base, 'GET', '/api/workforce-test/role/3');
  assert.equal(r.status, 200);
  assert.equal(r.json.records[0].id, 9, 'not shadowed by /:id');
});

test('EWP-RTR-4. missing handler in the route table throws at construction', () => {
  const ctl = createResourceController(fakeService());
  assert.throws(() => createGatedRouter(ctl, { featureFlag: enabledFlag, routes: [{ method: 'get', path: '/x', handler: 'doesNotExist' }] }), /no handler 'doesNotExist'/);
});

test('EWP-RTR-5. default feature flag (env) is used when none injected; options non-object falls back', async () => {
  const ctl = createResourceController(fakeService());
  process.env[VAR] = 'true';
  const base = await boot(createGatedRouter(ctl, 'not-object'));
  assert.equal((await request(base, 'GET', '/api/workforce-test/active')).status, 200, 'env-enabled via real flag');
  delete process.env[VAR];
  const base2 = await boot(createGatedRouter(ctl));
  assert.equal((await request(base2, 'GET', '/api/workforce-test/active')).status, 503, 'env-disabled via real flag');
  assert.equal(typeof realFlag.isEnabled, 'function');
});

test('EWP-RTR-6. mutating the exported DEFAULT_ROUTES cannot affect the router internal table', async () => {
  // Poison the exported copy with a route pointing at a non-existent handler.
  DEFAULT_ROUTES.push({ method: 'get', path: '/HACK', handler: 'nope' });
  const ctl = createResourceController(fakeService());
  // If createGatedRouter used the exported (now-poisoned) array it would throw on 'nope'; it does not.
  const base = await boot(createGatedRouter(ctl, { featureFlag: enabledFlag }));
  assert.equal((await request(base, 'GET', '/api/workforce-test/HACK')).status, 404, 'poisoned route never registered');
  assert.equal((await request(base, 'GET', '/api/workforce-test/active')).status, 200, 'internal table intact');
});
