// EWP-01c — Person & Identity — routes tests (real Express; gated). Real service over an in-memory DB.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const sqlite3 = require('sqlite3');

const PDIR = path.join(__dirname, '..', 'lib', 'workforce', 'person');
const Mig = require(path.join(PDIR, 'person-migration.js'));
const { createPersonRepository } = require(path.join(PDIR, 'person-repository.js'));
const { createPersonService } = require(path.join(PDIR, 'person-service.js'));
const { createPersonController } = require(path.join(PDIR, 'person-controller.js'));
const { createPersonRoutes, MOUNT_PATH, ROUTES } = require(path.join(PDIR, 'person-routes.js'));

let db; let server; let base; let flagOn;
const flag = { isEnabled: () => flagOn };
const P = MOUNT_PATH;

before(async () => {
  db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  let n = 0;
  const service = createPersonService(createPersonRepository(db), { uuid: () => `u-${(n += 1)}`, referenceDate: '2026-07-09' });
  const app = express();
  app.use(express.json());
  app.use(MOUNT_PATH, createPersonRoutes(createPersonController(service), { featureFlag: flag }));
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

test('EWP-PRTE-1. disabled flag → 503 on every route', async () => {
  flagOn = false;
  assert.equal((await request('POST', P, { firstName: 'A', lastName: 'B' })).status, 503);
  assert.equal((await request('GET', `${P}/search`)).status, 503);
});

test('EWP-PRTE-2. create a person (201) with a server uuid', async () => {
  flagOn = true;
  const r = await request('POST', P, { personNumber: 'P001', firstName: 'Jane', lastName: 'Doe', email: 'jane@x.com', passportNumber: 'PA1', nationalId: 'N1', dateOfBirth: '1990-05-15' });
  assert.equal(r.status, 201);
  assert.match(r.json.person.uuid, /^u-\d+$/);
});

test('EWP-PRTE-3. validation maps to HTTP status (400 / 409)', async () => {
  flagOn = true;
  assert.equal((await request('POST', P, { lastName: 'X' })).status, 400, 'missing firstName');
  assert.equal((await request('POST', P, { firstName: 'Dup', lastName: 'Y', email: 'jane@x.com' })).status, 409, 'duplicate email');
});

test('EWP-PRTE-4. identity lookups: /uuid/:uuid, /number/:personNumber, /email, /passport, /national-id', async () => {
  flagOn = true;
  assert.equal((await request('GET', `${P}/uuid/u-1`)).json.person.firstName, 'Jane');
  assert.equal((await request('GET', `${P}/number/P001`)).json.person.personNumber, 'P001');
  assert.equal((await request('GET', `${P}/email?email=jane@x.com`)).json.person.email, 'jane@x.com');
  assert.equal((await request('GET', `${P}/passport?passportNumber=PA1`)).json.person.passportNumber, 'PA1');
  assert.equal((await request('GET', `${P}/national-id?nationalId=N1`)).json.person.nationalId, 'N1');
  assert.equal((await request('GET', `${P}/email?email=none@x.com`)).status, 404);
});

test('EWP-PRTE-5. /search and POST /duplicates are not shadowed by /:id', async () => {
  flagOn = true;
  const s = await request('GET', `${P}/search?lastName=Doe`);
  assert.equal(s.status, 200);
  assert.ok(s.json.persons.length >= 1);
  const d = await request('POST', `${P}/duplicates`, { email: 'jane@x.com' });
  assert.equal(d.status, 200);
  assert.equal(d.json.duplicates.length, 1);
});

test('EWP-PRTE-6. /:id, /:id/age, PUT, archive/restore, DELETE', async () => {
  flagOn = true;
  const list = await request('GET', `${P}/search?personNumber=P001`);
  const id = list.json.persons[0].id;
  assert.equal((await request('GET', `${P}/${id}`)).status, 200);
  assert.equal((await request('GET', `${P}/${id}/age`)).json.age, 36);
  assert.equal((await request('GET', `${P}/${id}/age?asOf=2010-01-01`)).json.age, 19);
  assert.equal((await request('PUT', `${P}/${id}`, { preferredName: 'Janie' })).status, 200);
  assert.equal((await request('POST', `${P}/${id}/archive`)).status, 200);
  assert.equal((await request('POST', `${P}/${id}/restore`)).status, 200);
  assert.equal((await request('DELETE', `${P}/${id}`)).status, 200);
  assert.equal((await request('GET', `${P}/${id}`)).status, 404);
});

test('EWP-PRTE-7. GET /active and GET / (list)', async () => {
  flagOn = true;
  await request('POST', P, { firstName: 'Bob', lastName: 'Roe', personNumber: 'P002' });
  assert.ok((await request('GET', `${P}/active`)).json.persons.length >= 1);
  assert.ok((await request('GET', P)).json.persons.length >= 1);
});

test('EWP-PRTE-7c. PUT with an invalid gender → 400; /search by nationality filters', async () => {
  flagOn = true;
  const created = await request('POST', P, { firstName: 'Ann', lastName: 'Lee', personNumber: 'P010', nationality: 'NZ' });
  const id = created.json.person.id;
  assert.equal((await request('PUT', `${P}/${id}`, { gender: 'ZZ' })).status, 400);
  assert.equal((await request('PUT', `${P}/${id}`, { gender: 'FEMALE' })).status, 200);
  assert.ok((await request('GET', `${P}/search?nationality=NZ`)).json.persons.length >= 1);
});

test('EWP-PRTE-7b. lookups and age on a missing person → 404; duplicates with no match → []', async () => {
  flagOn = true;
  assert.equal((await request('GET', `${P}/uuid/no-such-uuid`)).status, 404);
  assert.equal((await request('GET', `${P}/999999/age`)).status, 404);
  assert.deepEqual((await request('POST', `${P}/duplicates`, { email: 'nobody@x.com' })).json.duplicates, []);
});

test('EWP-PRTE-8. createPersonRoutes tolerates missing / non-object options; ROUTES table well-formed', () => {
  const controller = createPersonController(createPersonService(createPersonRepository(db), { uuid: () => 'x' }));
  assert.equal(typeof createPersonRoutes(controller), 'function');
  assert.equal(typeof createPersonRoutes(controller, 'nope'), 'function');
  assert.equal(MOUNT_PATH, '/api/workforce/person');
  assert.ok(ROUTES.every((r) => typeof r.method === 'string' && typeof r.path === 'string' && typeof r.handler === 'string'));
  const idx = (h) => ROUTES.findIndex((r) => r.handler === h);
  assert.ok(idx('search') < idx('get') && idx('byUuid') < idx('get') && idx('age') < idx('get'));
});
