// WP-14 · A5 — Route permission registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const RP = require(path.join(ROOT, 'lib', 'auth', 'route-permissions.js'));
const { PERMISSIONS } = require(path.join(ROOT, 'lib', 'auth', 'permissions.js'));

// 1. Registry exists and every entry is well-formed.
test('A5-1. registry exists with well-formed rules', () => {
  assert.ok(Array.isArray(RP.ROUTE_PERMISSIONS) && RP.ROUTE_PERMISSIONS.length > 20);
  for (const r of RP.ROUTE_PERMISSIONS) {
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'].includes(r.method), `method ${r.method}`);
    assert.equal(typeof r.pathPattern, 'string');
    assert.ok(r.pathPattern.startsWith('/api/'));
    assert.ok(Array.isArray(r.permissions) && r.permissions.length >= 1);
    assert.equal(typeof r.description, 'string');
  }
});

// 2. Registry (and rules + permissions) immutable.
test('A5-2. registry immutable', () => {
  assert.ok(Object.isFrozen(RP.ROUTE_PERMISSIONS));
  for (const r of RP.ROUTE_PERMISSIONS) { assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(r.permissions)); }
  try { RP.ROUTE_PERMISSIONS.push({}); } catch { /* strict throw ok */ }
  try { RP.ROUTE_PERMISSIONS[0].method = 'HACK'; } catch { /* strict throw ok */ }
  assert.ok(RP.ROUTE_PERMISSIONS.every((r) => r.method !== 'HACK'));
});

// 3. Every permission is a known A1 permission.
test('A5-3. every referenced permission is known', () => {
  for (const r of RP.ROUTE_PERMISSIONS) {
    for (const p of r.permissions) assert.ok(Object.prototype.hasOwnProperty.call(PERMISSIONS, p), `${p} known`);
  }
});

// 4. Every mode is report.
test('A5-4. every mode is report', () => {
  for (const r of RP.ROUTE_PERMISSIONS) assert.equal(r.mode, 'report');
});

// 5. Exact match.
test('A5-5. exact path match', () => {
  const r = RP.getRoutePermissions('GET', '/api/users');
  assert.equal(r.matched, true);
  assert.deepEqual(r.permissions, ['users.read']);
  assert.equal(r.mode, 'report');
});

// 6. Parameter match.
test('A5-6. parameter path match', () => {
  const r = RP.getRoutePermissions('DELETE', '/api/users/42');
  assert.equal(r.matched, true);
  assert.deepEqual(r.permissions, ['users.delete']);
});

// 7. Wildcard match.
test('A5-7. wildcard path match', () => {
  const r = RP.getRoutePermissions('GET', '/api/exams/123/questions');
  assert.equal(r.matched, true);
  assert.deepEqual(r.permissions, ['assessments.read']);
});

// 8. Unknown route → safe default.
test('A5-8. unknown route safe default', () => {
  const r = RP.getRoutePermissions('GET', '/api/does-not-exist');
  assert.deepEqual(r, { permissions: [], mode: 'report', matched: false });
});

// 9. Method-specific beats method="*".
test('A5-9. method-specific beats wildcard method', () => {
  assert.deepEqual(RP.getRoutePermissions('GET', '/api/analytics').permissions, ['reports.read'], 'GET-specific wins');
  assert.deepEqual(RP.getRoutePermissions('POST', '/api/analytics').permissions, ['reports.export'], 'POST falls to * rule');
});

// 10. Exact path beats wildcard path.
test('A5-10. exact path beats wildcard path', () => {
  assert.deepEqual(RP.getRoutePermissions('GET', '/api/reports/export').permissions, ['reports.export'], 'exact wins');
  assert.deepEqual(RP.getRoutePermissions('GET', '/api/reports/monthly').permissions, ['reports.read'], 'wildcard for others');
});

// 11. Method is case-insensitive.
test('A5-11. method case-insensitive', () => {
  assert.deepEqual(RP.getRoutePermissions('get', '/api/users').permissions, ['users.read']);
  assert.deepEqual(RP.getRoutePermissions('  DeLeTe  ', '/api/users/9').permissions, ['users.delete']);
});

// 12. Malformed inputs never throw.
test('A5-12. malformed inputs never throw', () => {
  const inputs = [undefined, null, NaN, {}, [], true, 5, '', Symbol('x'), () => {}, '///', '/api//users//'];
  for (const m of inputs) for (const p of inputs) {
    assert.doesNotThrow(() => RP.getRoutePermissions(m, p));
    assert.doesNotThrow(() => RP.matchRoutePermission(m, p));
  }
  // normalized double slashes still match
  assert.equal(RP.getRoutePermissions('GET', '/api//users').matched, true);
  assert.equal(RP.getRoutePermissions('GET', '/api/users/').matched, true, 'trailing slash tolerated');
});

// 13. Returned arrays are fresh copies.
test('A5-13. returned arrays are fresh', () => {
  const a = RP.getRoutePermissions('GET', '/api/users');
  a.permissions.push('hack');
  assert.ok(!RP.getRoutePermissions('GET', '/api/users').permissions.includes('hack'));
  const list = RP.listRoutePermissionRules();
  list.pop();
  assert.equal(RP.listRoutePermissionRules().length, RP.ROUTE_PERMISSIONS.length, 'list is a fresh copy');
});

// 14. Registry cannot be mutated through a result.
test('A5-14. registry not mutable via result.rule', () => {
  const r = RP.getRoutePermissions('GET', '/api/users');
  r.rule.method = 'HACK';
  r.rule.permissions.push('admin.full');
  const again = RP.getRoutePermissions('GET', '/api/users');
  assert.equal(again.rule.method, 'GET');
  assert.deepEqual(again.permissions, ['users.read']);
});

// 15. No duplicate (method, pathPattern) rules.
test('A5-15. no duplicate method/path rules', () => {
  const keys = RP.ROUTE_PERMISSIONS.map((r) => `${r.method} ${r.pathPattern}`);
  assert.equal(keys.length, new Set(keys).size);
});

// 16. Route families covered.
test('A5-16. route families covered', () => {
  const cases = [
    ['GET', '/api/users'], ['GET', '/api/staff'], ['GET', '/api/reports/x'], ['GET', '/api/analytics'],
    ['GET', '/api/lookup/x'], ['GET', '/api/training/x'], ['GET', '/api/documents/x'], ['POST', '/api/ai/generate'],
    ['GET', '/api/competency/x'], ['GET', '/api/exams/x'], ['GET', '/api/forms/x'], ['GET', '/api/workflows/x'],
    ['GET', '/api/settings'], ['GET', '/api/disciplinary/x'], ['GET', '/api/onboarding/x'], ['GET', '/api/safety/x'],
    ['GET', '/api/powerpoints/x'], ['GET', '/api/translator/x'], ['GET', '/api/admin/x'],
  ];
  for (const [m, p] of cases) assert.equal(RP.getRoutePermissions(m, p).matched, true, `${m} ${p} covered`);
});

// 17. No runtime route/server imports this registry yet.
test('A5-17. no runtime imports yet', () => {
  const files = [path.join(ROOT, 'server.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) files.push(path.join(routesDir, f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('auth/route-permissions'), `${path.basename(f)} must not import it`);
  }
});

// 18. matchRoutePermission returns null for unknown (helper parity).
test('A5-18. matchRoutePermission null for unknown', () => {
  assert.equal(RP.matchRoutePermission('GET', '/api/nope'), null);
  assert.equal(RP.matchRoutePermission('GET', ''), null);
  const rule = RP.matchRoutePermission('GET', '/api/users');
  assert.equal(rule.pathPattern, '/api/users');
});
