// WP-07 · C8 — Lookup / reference-data API tests (routes/lookup.js).
// Isolated harness; temporary DB + session storage; synthetic data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

// 10. Unauthenticated access → 401.
test('10. unauthenticated lookup returns 401', async () => {
  assert.equal((await app.request('GET', '/api/lookup/depts', null, null)).status, 401);
});

// 6. Lookup endpoints return arrays and reflect created reference data deterministically.
test('6. lookup GET returns arrays for reference tables', async () => {
  for (const p of ['/api/lookup/depts', '/api/lookup/jobs', '/api/lookup/locations', '/api/lookup/shifts']) {
    const r = await app.request('GET', p);
    assert.equal(r.status, 200, `${p} → 200`);
    assert.ok(Array.isArray(r.json()), `${p} returns an array`);
  }
});

test('6b. created reference values are returned deterministically', async () => {
  const dept = await app.request('POST', '/api/lookup/depts', { Department: 'C8 Reference Dept' });
  assert.equal(dept.status, 200);
  assert.ok(dept.json().DeptID > 0, 'POST returns new DeptID');

  const depts = await app.request('GET', '/api/lookup/depts');
  assert.ok(depts.json().some((d) => d.Department === 'C8 Reference Dept'), 'created dept is listed');

  const job = await app.request('POST', '/api/lookup/jobs', { Title: 'C8 Operator' });
  assert.ok(job.json().JobID > 0, 'POST returns new JobID');
  const jobs = await app.request('GET', '/api/lookup/jobs');
  assert.ok(jobs.json().some((j) => j.Title === 'C8 Operator'), 'created job is listed');
});
