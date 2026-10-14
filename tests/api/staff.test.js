// WP-07 · C8 — Core staff CRUD + full-report + self-profile API tests.
// Isolated in-process app harness; temporary DATABASE_PATH + SESSION_DB_DIR.
// Synthetic data only. Production DB / session DB never touched. No AI/SMTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

// 10. Unauthenticated access to a protected endpoint → 401.
test('10. unauthenticated /api/staff returns 401', async () => {
  assert.equal((await app.request('GET', '/api/staff', null, null)).status, 401);
});

// 1/2. Create a synthetic staff record, then list + retrieve it.
test('1/2. create staff, then list and retrieve', async () => {
  const created = await app.request('POST', '/api/staff', {
    LastName: 'Tester', FirstName: 'C8', Status: 'Active', FileNum: 'C8-001', Email: '',
  });
  assert.equal(created.status, 200);
  const id = created.json().StaffID;
  assert.ok(id > 0, 'returns a new StaffID');

  const list = await app.request('GET', '/api/staff');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json()));
  assert.ok(list.json().some((s) => s.StaffID === id), 'new staff appears in the list');

  const one = await app.request('GET', `/api/staff/${id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json().LastName, 'Tester');
  assert.equal(one.json().FirstName, 'C8');
});

// 3. Full-report endpoint returns the expected shape for the synthetic record.
test('3. full-report returns expected shape', async () => {
  const created = await app.request('POST', '/api/staff', {
    LastName: 'Report', FirstName: 'Full', Status: 'Active', FileNum: 'C8-RPT',
  });
  const id = created.json().StaffID;
  const rep = await app.request('GET', `/api/staff/${id}/full-report`);
  assert.equal(rep.status, 200);
  const body = rep.json();
  assert.ok(body.emp && body.emp.StaffID === id, 'emp block present for the record');
  assert.equal(body.emp.LastName, 'Report');
  assert.ok(Array.isArray(body.completed), 'completed is an array');
  assert.ok(Array.isArray(body.required), 'required is an array');
});

// 4. Update a safe deterministic field.
test('4. staff update persists a changed field', async () => {
  const created = await app.request('POST', '/api/staff', {
    LastName: 'Editable', FirstName: 'Before', Status: 'Active', FileNum: 'C8-UPD',
  });
  const id = created.json().StaffID;
  const upd = await app.request('PUT', `/api/staff/${id}`, {
    LastName: 'Editable', FirstName: 'After', Status: 'Active', FileNum: 'C8-UPD',
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.json().success, true);
  const one = await app.request('GET', `/api/staff/${id}`);
  assert.equal(one.json().FirstName, 'After', 'updated field persisted');
});

// 5. Soft-delete removes the record from the active list (as implemented).
test('5. staff soft-delete excludes the record from the list', async () => {
  const created = await app.request('POST', '/api/staff', {
    LastName: 'Deletable', FirstName: 'Temp', Status: 'Active', FileNum: 'C8-DEL',
  });
  const id = created.json().StaffID;
  const del = await app.request('DELETE', `/api/staff/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json().success, true);
  const list = await app.request('GET', '/api/staff');
  assert.ok(!list.json().some((s) => s.StaffID === id), 'soft-deleted staff no longer listed');
});

// 7. Self-profile endpoint returns the expected authenticated shape.
test('7. /api/me/profile returns authenticated shape', async () => {
  const r = await app.request('GET', '/api/me/profile'); // admin cookie; admin has no linked staffID
  assert.equal(r.status, 200);
  assert.ok('linked' in r.json(), 'profile has a linked flag');
  assert.equal(r.json().linked, false, 'admin user is not linked to a staff record');
});
