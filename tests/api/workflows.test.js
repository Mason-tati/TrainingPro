// WP-07 · C9 — Workflow API tests (event catalogue, CRUD, safe fire).
// Isolated harness; temporary DB + session storage; synthetic data only.
// No SMTP is configured and no email is sent: workflows are created without
// recipients (skipped path), plus one with a recipient to prove the fire path
// survives a send failure gracefully (transport is null → no mail leaves).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

// 11. Unauthenticated access → 401 (all workflow routes require auth).
test('11. unauthenticated /api/workflows/events returns 401', async () => {
  assert.equal((await app.request('GET', '/api/workflows/events', null, null)).status, 401);
});

// 9. Event catalogue is exposed as currently implemented.
test('9. workflow event catalogue is exposed', async () => {
  const r = await app.request('GET', '/api/workflows/events');
  assert.equal(r.status, 200);
  const events = r.json();
  assert.ok(Array.isArray(events) && events.length === 9, '9 trigger events');
  for (const e of events) {
    assert.equal(typeof e.key, 'string');
    assert.equal(typeof e.label, 'string');
  }
});

// 8. Workflow CRUD.
test('8. workflow create, list, delete', async () => {
  const created = await app.request('POST', '/api/workflows', {
    Name: 'C9 WF', TriggerEvent: 'employee_added', Recipients: '', Active: true,
  });
  assert.equal(created.status, 200);
  const id = created.json().WorkflowID;
  assert.ok(id > 0, 'returns WorkflowID');

  const list = await app.request('GET', '/api/workflows');
  assert.ok(list.json().some((w) => w.WorkflowID === id), 'workflow listed');

  const del = await app.request('DELETE', `/api/workflows/${id}`);
  assert.equal(del.status, 200);
  const after = await app.request('GET', '/api/workflows');
  assert.ok(!after.json().some((w) => w.WorkflowID === id), 'workflow removed');
});

// 10a. Fire is safe with a no-recipient workflow (skipped path, no email).
test('10a. firing a no-recipient workflow does not break the triggering action', async () => {
  const wf = await app.request('POST', '/api/workflows', {
    Name: 'C9 Empty', TriggerEvent: 'employee_added', Recipients: '', Active: true,
  });
  assert.ok(wf.json().WorkflowID > 0);
  // Creating a staff record fires 'employee_added'; with no recipients it is skipped.
  const s = await app.request('POST', '/api/staff', { LastName: 'Fire', FirstName: 'Empty', Status: 'Active', FileNum: 'C9-WF1' });
  assert.equal(s.status, 200, 'staff creation survives workflow fire (no recipients)');
  assert.ok(s.json().StaffID > 0);
});

// 10b. Fire survives a send failure (recipient set, but SMTP unconfigured).
test('10b. firing a recipient workflow survives missing SMTP without crashing', async () => {
  const wf = await app.request('POST', '/api/workflows', {
    Name: 'C9 Recip', TriggerEvent: 'employee_added', Recipients: 'nobody@example.com', Active: true,
  });
  assert.ok(wf.json().WorkflowID > 0);
  // SMTP is not configured → sendMail throws internally, is caught per-workflow,
  // and no email is sent (transport is null). Staff creation still succeeds.
  const s = await app.request('POST', '/api/staff', { LastName: 'Fire', FirstName: 'Recip', Status: 'Active', FileNum: 'C9-WF2' });
  assert.equal(s.status, 200, 'staff creation survives workflow send failure');
  assert.ok(s.json().StaffID > 0);
});
