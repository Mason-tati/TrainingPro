// WP-07 · C13 — Broad GET-surface liveness smoke (migrated from tests/regression.js).
// Confirms every read surface responds 200 for an authenticated admin against a
// FRESH temporary database — catching router-mcount regressions and crashes on
// empty data. Isolated harness + network guard; synthetic data only.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

// Read surfaces across every mounted router (from the legacy suite, curated to
// real endpoints). Authenticated admin; empty temp DB should still return 200.
const SURFACES = [
  '/api/staff', '/api/certs', '/api/classes', '/api/register', '/api/requirements',
  '/api/lookup/depts', '/api/lookup/shifts', '/api/reports/matrix', '/api/reports/dashboard',
  '/api/analytics', '/api/users', '/api/exams/tests', '/api/exams/bank', '/api/audit?limit=5',
  '/api/settings', '/api/files', '/api/trainers', '/api/roster/patterns', '/api/roster/shift-types',
  '/api/forms/templates', '/api/forms/submissions', '/api/workflows', '/api/workflows/events',
  '/api/translator/languages', '/api/translator/jobs', '/api/translator/metrics', '/api/translator/terms',
  '/api/content/types', '/api/me/profile', '/api/competency/frameworks', '/api/kb/articles',
];

test('all read surfaces return 200 for an authenticated admin', async () => {
  const failures = [];
  for (const p of SURFACES) {
    const r = await app.request('GET', p);
    if (r.status !== 200) failures.push(`${p} → ${r.status}`);
  }
  assert.equal(failures.length, 0, 'non-200 surfaces: ' + failures.join(', '));
});

test('read surfaces reject unauthenticated access', async () => {
  // A representative protected surface must 401 without a session.
  assert.equal((await app.request('GET', '/api/staff', null, null)).status, 401);
  assert.equal((await app.request('GET', '/api/workflows', null, null)).status, 401);
});
