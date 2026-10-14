// WP-07 · C8 — Reporting + analytics API shape tests.
// Isolated harness; temporary DB + session storage; synthetic data only.
// Shape-focused assertions (no brittle totals except data the test itself creates).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
let staffId;
before(async () => {
  app = await startTestApp();
  // One synthetic active employee so the matrix has a deterministic row.
  const r = await app.request('POST', '/api/staff', {
    LastName: 'Matrix', FirstName: 'Row', Status: 'Active', FileNum: 'C8-MTX',
  });
  staffId = r.json().StaffID;
});
after(async () => { if (app) await app.close(); });

// 10. Unauthenticated access → 401.
test('10. unauthenticated report endpoints return 401', async () => {
  assert.equal((await app.request('GET', '/api/reports/matrix', null, null)).status, 401);
  assert.equal((await app.request('GET', '/api/analytics', null, null)).status, 401);
});

// 8. Reports matrix returns the expected JSON shape and includes synthetic staff.
test('8. reports/matrix returns { courses, rows } shape', async () => {
  const r = await app.request('GET', '/api/reports/matrix');
  assert.equal(r.status, 200);
  const body = r.json();
  assert.ok(Array.isArray(body.courses), 'courses is an array');
  assert.ok(Array.isArray(body.rows), 'rows is an array');
  const mine = body.rows.find((row) => row.StaffID === staffId);
  assert.ok(mine, 'synthetic active staff appears as a matrix row');
  assert.equal(mine.name, 'Matrix, Row');
  assert.ok(typeof mine.cells === 'object' && mine.cells !== null, 'row has a cells object');
});

// 9. Analytics returns the expected JSON shape.
test('9. analytics returns summary + series shape', async () => {
  const r = await app.request('GET', '/api/analytics');
  assert.equal(r.status, 200);
  const body = r.json();
  assert.ok(body.summary && typeof body.summary === 'object', 'summary object present');
  for (const k of ['employees', 'completionsMonth', 'expiring30']) {
    assert.equal(typeof body.summary[k], 'number', `summary.${k} is numeric`);
  }
  assert.ok('complianceRate' in body.summary, 'summary includes complianceRate');
  assert.ok(Array.isArray(body.monthly) && body.monthly.length === 12, 'monthly is a 12-point series');
  for (const arr of ['byDept', 'topCourses', 'byType', 'recentCompletions']) {
    assert.ok(Array.isArray(body[arr]), `${arr} is an array`);
  }
  // The synthetic active employee is counted.
  assert.ok(body.summary.employees >= 1, 'employee count reflects synthetic staff');
});

// Bonus (within scope): dashboard summary shape.
test('reports/dashboard returns a numeric summary shape', async () => {
  const r = await app.request('GET', '/api/reports/dashboard');
  assert.equal(r.status, 200);
  const body = r.json();
  for (const k of ['totalStaff', 'totalCerts', 'totalClasses', 'complianceRate']) {
    assert.equal(typeof body[k], 'number', `${k} is numeric`);
  }
  assert.ok(Array.isArray(body.recentCompletions), 'recentCompletions is an array');
});
