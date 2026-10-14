// EWP-01b — Reference & Organisation — routes tests (real Express; gated).
// The organisation REST surface over a real in-memory service, gated by the workforce flag. NOT mounted
// in server.js. Verifies gating, literal-before-parameter route ordering, and the hierarchy endpoints.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const RDIR = path.join(__dirname, '..', 'lib', 'workforce', 'reference');
const Mig = require(path.join(RDIR, 'organisation-migration.js'));
const { createOrganisationRegistry } = require(path.join(RDIR, 'organisation-repository.js'));
const { createOrganisationService } = require(path.join(RDIR, 'organisation-service.js'));
const { createOrganisationController } = require(path.join(RDIR, 'organisation-controller.js'));
const { createOrganisationRoutes, MOUNT_PATH, ROUTES } = require(path.join(RDIR, 'organisation-routes.js'));

let db; let server; let base; let flagOn;
const flag = { isEnabled: () => flagOn };

before(async () => {
  db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  let n = 0;
  const service = createOrganisationService(createOrganisationRegistry(db), { uuid: () => `uuid-${(n += 1)}` });
  const controller = createOrganisationController(service);
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createOrganisationRoutes(controller, { featureFlag: flag }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((r) => server.close(r)); if (db) db.close(); });

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(base + url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const P = MOUNT_PATH;

test('EWP-ORTE-1. disabled flag → 503 on every route', async () => {
  flagOn = false;
  assert.equal((await request('POST', `${P}/COMPANY`, { code: 'C', name: 'Co' })).status, 503);
  assert.equal((await request('GET', `${P}/hierarchy`)).status, 503);
  assert.equal((await request('GET', `${P}/COMPANY`)).status, 503);
});

test('EWP-ORTE-2. enabled flag → create a company and business unit (201)', async () => {
  flagOn = true;
  const co = await request('POST', `${P}/COMPANY`, { code: 'C1', name: 'Company One' });
  assert.equal(co.status, 201);
  assert.match(co.json.node.uuid, /^uuid-\d+$/);
  const bu = await request('POST', `${P}/BUSINESS_UNIT`, { code: 'BU1', name: 'BU One', parentId: co.json.node.id });
  assert.equal(bu.status, 201);
});

test('EWP-ORTE-3. validation errors map to HTTP status (400 / 409)', async () => {
  flagOn = true;
  assert.equal((await request('POST', `${P}/BOGUS`, { code: 'X', name: 'Y' })).status, 400, 'unknown level');
  assert.equal((await request('POST', `${P}/COMPANY`, { code: 'C1', name: 'Dup' })).status, 409, 'duplicate code');
  assert.equal((await request('POST', `${P}/SITE`, { code: 'S', name: 'Si', parentId: 9999 })).status, 400, 'parent not found');
});

test('EWP-ORTE-4. /hierarchy is not shadowed by /:level; /:level/lookup is not shadowed by /:level/:id', async () => {
  flagOn = true;
  const h = await request('GET', `${P}/hierarchy`);
  assert.equal(h.status, 200);
  assert.ok(Array.isArray(h.json.hierarchy));
  const look = await request('GET', `${P}/COMPANY/lookup?code=C1`);
  assert.equal(look.status, 200);
  assert.equal(look.json.node.code, 'C1');
  assert.equal((await request('GET', `${P}/COMPANY/lookup?code=NOPE`)).status, 404);
});

test('EWP-ORTE-5. GET /:level and GET /:level/:id (list + get; unknown id → 404)', async () => {
  flagOn = true;
  assert.ok((await request('GET', `${P}/COMPANY`)).json.nodes.length >= 1);
  const list = await request('GET', `${P}/COMPANY`);
  const id = list.json.nodes[0].id;
  assert.equal((await request('GET', `${P}/COMPANY/${id}`)).status, 200);
  assert.equal((await request('GET', `${P}/COMPANY/999999`)).status, 404);
});

test('EWP-ORTE-6. hierarchy endpoints: children / parent / ancestors / descendants / tree / breadcrumb', async () => {
  flagOn = true;
  const co = (await request('GET', `${P}/COMPANY/lookup?code=C1`)).json.node;
  const bu = (await request('GET', `${P}/BUSINESS_UNIT/lookup?code=BU1`)).json.node;
  assert.equal((await request('GET', `${P}/COMPANY/${co.id}/children`)).json.level, 'BUSINESS_UNIT');
  assert.equal((await request('GET', `${P}/BUSINESS_UNIT/${bu.id}/parent`)).json.parent.code, 'C1');
  assert.deepEqual((await request('GET', `${P}/BUSINESS_UNIT/${bu.id}/ancestors`)).json.ancestors.map((a) => a.level), ['COMPANY']);
  assert.equal((await request('GET', `${P}/COMPANY/${co.id}/descendants`)).json.descendants.length >= 1, true);
  assert.equal((await request('GET', `${P}/COMPANY/${co.id}/tree`)).json.tree.level, 'COMPANY');
  const bc = (await request('GET', `${P}/BUSINESS_UNIT/${bu.id}/breadcrumb`)).json.breadcrumb;
  assert.equal(bc[0].level, 'COMPANY');
  assert.equal(bc[bc.length - 1].level, 'BUSINESS_UNIT');
});

test('EWP-ORTE-7. PUT update; POST archive/restore; DELETE remove', async () => {
  flagOn = true;
  const created = await request('POST', `${P}/COMPANY`, { code: 'C9', name: 'Company Nine' });
  const id = created.json.node.id;
  assert.equal((await request('PUT', `${P}/COMPANY/${id}`, { description: 'edited' })).status, 200);
  assert.equal((await request('POST', `${P}/COMPANY/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${P}/COMPANY/${id}/restore`)).status, 200);
  assert.equal((await request('DELETE', `${P}/COMPANY/${id}`)).status, 200);
  assert.equal((await request('GET', `${P}/COMPANY/${id}`)).status, 404);
});

test('EWP-ORTE-9. createOrganisationRoutes tolerates missing / non-object options (default flag)', () => {
  const controller = createOrganisationController(createOrganisationService(createOrganisationRegistry(db), { uuid: () => 'x' }));
  assert.equal(typeof createOrganisationRoutes(controller), 'function', 'router built with no options');
  assert.equal(typeof createOrganisationRoutes(controller, 'nope'), 'function', 'non-object options tolerated');
});

test('EWP-ORTE-8. MOUNT_PATH and the exported ROUTES table are well-formed', () => {
  assert.equal(MOUNT_PATH, '/api/workforce/organisation');
  assert.equal(ROUTES.length, 15);
  assert.ok(ROUTES.every((r) => typeof r.method === 'string' && typeof r.path === 'string' && typeof r.handler === 'string'));
  assert.ok(ROUTES.some((r) => r.handler === 'hierarchy'));
  // '/hierarchy' precedes '/:level'; '/:level/lookup' precedes '/:level/:id' (literal-before-parameter).
  const idx = (h) => ROUTES.findIndex((r) => r.handler === h);
  assert.ok(idx('hierarchy') < idx('list'));
  assert.ok(idx('lookup') < idx('get'));
});
