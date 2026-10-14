// WP-14 · A4 — Report-only authorization middleware tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'lib', 'auth', 'authorize.js'));
const requestContext = require(path.join(ROOT, 'lib', 'request-context.js'));
const logger = require(path.join(ROOT, 'lib', 'logger.js'));
const { validateLogRecord } = require(path.join(ROOT, 'lib', 'log-schema.js'));

const ADMIN = { roles: ['ADMIN'] };
const VIEWER = { roles: ['VIEWER'] };
const TRAINER = { roles: ['TRAINER'] };

// 1. No permission required → authorized true.
test('A4-1. no required permission → authorized', () => {
  for (const req of [null, undefined, [], '']) {
    const r = A.evaluateAuthorization(VIEWER, req);
    assert.equal(r.authorized, true);
    assert.deepEqual(r.requiredPermissions, []);
    assert.deepEqual(r.missingPermissions, []);
  }
});

// 2. Single permission success.
test('A4-2. single permission success', () => {
  const r = A.evaluateAuthorization(TRAINER, 'training.read');
  assert.equal(r.authorized, true);
  assert.deepEqual(r.missingPermissions, []);
});

// 3. Single permission failure.
test('A4-3. single permission failure', () => {
  const r = A.evaluateAuthorization(VIEWER, 'training.write');
  assert.equal(r.authorized, false);
  assert.deepEqual(r.missingPermissions, ['training.write']);
});

// 4. Multiple permission success.
test('A4-4. multiple permission success', () => {
  const r = A.evaluateAuthorization(ADMIN, ['users.read', 'training.write', 'admin.full']);
  assert.equal(r.authorized, true);
  assert.deepEqual(r.missingPermissions, []);
});

// 5. Multiple permission partial failure.
test('A4-5. multiple permission partial failure', () => {
  const r = A.evaluateAuthorization(VIEWER, ['training.read', 'training.write']);
  assert.equal(r.authorized, false);
  assert.deepEqual(r.missingPermissions, ['training.write']);
  assert.ok(r.requiredPermissions.includes('training.read'));
});

// 6. Unknown permission is treated as missing.
test('A4-6. unknown permission → missing', () => {
  const r = A.evaluateAuthorization(ADMIN, ['not.aperm']);
  assert.equal(r.authorized, false, 'even admin cannot satisfy an unknown permission');
  assert.deepEqual(r.missingPermissions, ['not.aperm']);
});

// 7. Unknown / empty user → no permissions → not authorized when required.
test('A4-7. unknown user', () => {
  for (const u of [null, undefined, {}, 'nope', 5]) {
    const r = A.evaluateAuthorization(u, 'training.read');
    assert.equal(r.authorized, false);
    assert.deepEqual(r.evaluatedPermissions, []);
    assert.deepEqual(r.missingPermissions, ['training.read']);
  }
});

// 8. Duplicate permission inputs are removed.
test('A4-8. duplicates removed', () => {
  const r = A.evaluateAuthorization(TRAINER, ['training.read', 'training.read', 'training.read']);
  assert.deepEqual(r.requiredPermissions, ['training.read']);
});

// 9. No mutation of inputs.
test('A4-9. no mutation of inputs', () => {
  const user = { roles: ['TRAINER'] };
  const req = ['training.write', 'training.read'];
  const us = JSON.parse(JSON.stringify(user));
  const rs = [...req];
  A.evaluateAuthorization(user, req);
  assert.deepEqual(user, us);
  assert.deepEqual(req, rs);
});

// 10. Fresh arrays returned.
test('A4-10. fresh arrays', () => {
  const r = A.evaluateAuthorization(ADMIN, ['users.read']);
  r.requiredPermissions.push('hack');
  r.evaluatedPermissions.push('hack');
  const r2 = A.evaluateAuthorization(ADMIN, ['users.read']);
  assert.ok(!r2.requiredPermissions.includes('hack'));
  assert.ok(!r2.evaluatedPermissions.includes('hack'));
});

// 11. Never throws on malformed input.
test('A4-11. never throws', () => {
  const inputs = [undefined, null, NaN, {}, [], true, 5, '', Symbol('x'), () => {}, { roles: 5 }];
  for (const u of inputs) for (const p of inputs) {
    assert.doesNotThrow(() => A.evaluateAuthorization(u, p));
  }
});

// 12. Empty arrays → authorized true.
test('A4-12. empty required array', () => {
  const r = A.evaluateAuthorization(VIEWER, []);
  assert.equal(r.authorized, true);
});

// 13. Sorted outputs.
test('A4-13. sorted outputs', () => {
  const r = A.evaluateAuthorization(ADMIN, ['training.write', 'ai.use', 'training.read']);
  assert.deepEqual(r.requiredPermissions, ['ai.use', 'training.read', 'training.write']);
  assert.deepEqual([...r.evaluatedPermissions], [...r.evaluatedPermissions].sort());
});

// 14. String input.
test('A4-14. string input', () => {
  assert.deepEqual(A.evaluateAuthorization(ADMIN, 'users.read').requiredPermissions, ['users.read']);
});

// 15. Array input.
test('A4-15. array input', () => {
  assert.deepEqual(A.evaluateAuthorization(ADMIN, ['users.read', 'training.read']).requiredPermissions, ['training.read', 'users.read']);
});

// 16. Null input.
test('A4-16. null input', () => {
  const r = A.evaluateAuthorization(ADMIN, null);
  assert.equal(r.authorized, true);
  assert.deepEqual(r.requiredPermissions, []);
});

// 17. Undefined input.
test('A4-17. undefined input', () => {
  const r = A.evaluateAuthorization(ADMIN, undefined);
  assert.equal(r.authorized, true);
  assert.deepEqual(r.requiredPermissions, []);
});

// 18. Middleware always calls next().
test('A4-18. middleware always calls next()', () => {
  requestContext.run({ module: 'System' }, () => {
    for (const req of [{ session: { user: ADMIN } }, { session: {} }, {}, null]) {
      let nexted = false;
      const mw = A.authorize('training.read');
      assert.doesNotThrow(() => mw(req, {}, () => { nexted = true; }));
      assert.equal(nexted, true);
    }
  });
});

// 19. Middleware never changes the response.
test('A4-19. middleware never touches the response', () => {
  requestContext.run({ module: 'System' }, () => {
    const res = { sentinel: 1 };
    const before = JSON.stringify(res);
    A.authorize(['training.read'])({ session: { user: VIEWER } }, res, () => {});
    assert.equal(JSON.stringify(res), before, 'response object unchanged');
  });
});

// 20. Middleware stores the authorization result in request-context.
test('A4-20. middleware stores authorization context', () => {
  requestContext.run({ module: 'System' }, () => {
    A.authorize(['training.read', 'training.write'])({ session: { user: VIEWER } }, {}, () => {});
    const ctx = requestContext.get();
    assert.ok(ctx.authorization, 'authorization stored');
    assert.equal(ctx.authorization.authorized, false);
    assert.deepEqual(ctx.authorization.missingPermissions, ['training.write']);
    // WP-14 A6 — initAuthorizationContext now seeds the enriched report. With no
    // method/path on the fake req the route is unknown → matched false, required [].
    A.initAuthorizationContext({ session: { user: VIEWER } }, {}, () => {});
    const seeded = requestContext.get().authorization;
    assert.equal(seeded.authorized, true);
    assert.deepEqual(seeded.requiredPermissions, []);
    assert.equal(seeded.matchedRoutePermission, false);
    assert.equal(seeded.routePermissionMode, 'report');
    assert.equal(seeded.routePermissionRule, null);
  });
});

// Extra: middleware never mutates req.session.user.
test('A4-extra. middleware never mutates the session user', () => {
  requestContext.run({ module: 'System' }, () => {
    const user = { roles: ['VIEWER'] };
    const snap = JSON.parse(JSON.stringify(user));
    A.authorize(['admin.full'])({ session: { user } }, {}, () => {});
    assert.deepEqual(user, snap);
  });
});

// ── WP-14 A6 — buildAuthorizationReport (route registry → report) ───────────
const req = (method, path, user) => ({ method, path, session: user ? { user } : {} });

// A6-1. Unknown route → safe report (matched false, required [], authorized true).
test('A6-1. unknown route report', () => {
  const r = A.buildAuthorizationReport(req('GET', '/api/does-not-exist', ADMIN));
  assert.equal(r.matchedRoutePermission, false);
  assert.deepEqual(r.requiredPermissions, []);
  assert.equal(r.authorized, true);
  assert.equal(r.routePermissionMode, 'report');
  assert.equal(r.routePermissionRule, null);
  assert.ok(Array.isArray(r.evaluatedPermissions) && r.evaluatedPermissions.length > 0, 'user still evaluated');
});

// A6-2. Known route + admin → authorized, required populated, rule is a copy.
test('A6-2. known route with admin authorized', () => {
  const r = A.buildAuthorizationReport(req('GET', '/api/users', ADMIN));
  assert.equal(r.matchedRoutePermission, true);
  assert.deepEqual(r.requiredPermissions, ['users.read']);
  assert.equal(r.authorized, true);
  assert.deepEqual(r.missingPermissions, []);
  assert.equal(r.routePermissionMode, 'report');
  // rule is a fresh copy — mutating it must not affect the registry
  r.routePermissionRule.permissions.push('hack');
  r.routePermissionRule.method = 'X';
  const again = A.buildAuthorizationReport(req('GET', '/api/users', ADMIN));
  assert.deepEqual(again.requiredPermissions, ['users.read']);
  assert.equal(again.routePermissionRule.method, 'GET');
});

// A6-3. Known route + insufficient user → authorized false, missing populated.
test('A6-3. known route with insufficient user', () => {
  const r = A.buildAuthorizationReport(req('DELETE', '/api/users/42', VIEWER));
  assert.equal(r.matchedRoutePermission, true);
  assert.deepEqual(r.requiredPermissions, ['users.delete']);
  assert.equal(r.authorized, false);
  assert.deepEqual(r.missingPermissions, ['users.delete']);
});

// A6-4. Anonymous user → evaluatedPermissions [], required unmet.
test('A6-4. anonymous user evaluated as empty', () => {
  const r = A.buildAuthorizationReport(req('GET', '/api/users', null));
  assert.deepEqual(r.evaluatedPermissions, []);
  assert.deepEqual(r.missingPermissions, ['users.read']);
  assert.equal(r.authorized, false);
});

// A6-5. Query string is stripped from the path.
test('A6-5. query string stripped', () => {
  const r = A.buildAuthorizationReport({ method: 'GET', path: '/api/users?foo=bar&x=1', session: { user: ADMIN } });
  assert.equal(r.matchedRoutePermission, true);
  assert.deepEqual(r.requiredPermissions, ['users.read']);
});

// A6-6. Never mutates req/session; never throws on malformed req.
test('A6-6. no mutation / never throws', () => {
  const user = { roles: ['VIEWER'] };
  const request = { method: 'DELETE', path: '/api/users/1', session: { user } };
  const snap = JSON.parse(JSON.stringify(request));
  A.buildAuthorizationReport(request);
  assert.deepEqual(request, snap, 'request unchanged');
  for (const bad of [undefined, null, {}, 5, 'x', { method: 5, path: {} }]) {
    assert.doesNotThrow(() => A.buildAuthorizationReport(bad));
  }
});

// ── WP-14 A7 — AUTHORIZATION_REPORT advisory audit event ────────────────────
const AUTH_META_KEYS = ['method', 'path', 'matchedRoute', 'authorized', 'requiredPermissionCount', 'evaluatedPermissionCount', 'missingPermissionCount', 'mode', 'roleCount'];
function captureInit(request) {
  const rows = [];
  const restore = logger.__setSink((r) => rows.push(r));
  const prev = logger.__setLevel('info');
  let nexted = false;
  requestContext.run({ requestId: 'req-a7', module: 'System', actor: 'admin' }, () => {
    A.initAuthorizationContext(request, {}, () => { nexted = true; });
  });
  logger.__setSink(restore); logger.__setLevel(prev);
  return { rows, nexted, events: rows.filter((r) => r.event === 'AUTHORIZATION_REPORT') };
}

// A7-1. Matched route emits exactly one AUTHORIZATION_REPORT (schema-valid).
test('A7-1. matched route emits one AUTHORIZATION_REPORT', () => {
  const { events, nexted } = captureInit({ method: 'GET', path: '/api/users', session: { user: ADMIN } });
  assert.equal(events.length, 1);
  assert.equal(nexted, true);
  const rec = events[0];
  assert.equal(validateLogRecord(rec).valid, true);
  assert.equal(rec.module, 'Authentication');
  assert.equal(rec.metadata.matchedRoute, true);
  assert.equal(rec.metadata.authorized, true);
  assert.equal(rec.metadata.requiredPermissionCount, 1);
  assert.equal(rec.metadata.roleCount, 1);
  assert.equal(rec.metadata.mode, 'report');
});

// A7-2. Unknown route emits nothing.
test('A7-2. unknown route emits nothing', () => {
  const { events } = captureInit({ method: 'GET', path: '/api/nope-xyz', session: { user: ADMIN } });
  assert.equal(events.length, 0);
});

// A7-3/4. Authorized and unauthorized both emit a report.
test('A7-3/4. authorized and unauthorized both emit', () => {
  assert.equal(captureInit({ method: 'GET', path: '/api/users', session: { user: ADMIN } }).events[0].metadata.authorized, true);
  const un = captureInit({ method: 'DELETE', path: '/api/users/9', session: { user: VIEWER } }).events[0];
  assert.equal(un.metadata.authorized, false);
  assert.equal(un.metadata.missingPermissionCount, 1);
});

// A7-5/6/7/8. Metadata is exactly the allow-list — only counts, no ids/roles/usernames.
test('A7-5..8. metadata is count-only allow-list; no ids/roles/usernames', () => {
  const rec = captureInit({ method: 'GET', path: '/api/users', session: { user: ADMIN } }).events[0];
  assert.deepEqual(Object.keys(rec.metadata).sort(), [...AUTH_META_KEYS].sort());
  const s = JSON.stringify(rec);
  for (const leak of ['users.read', 'admin.full', 'ADMIN', 'VIEWER', 'roles', 'permissions']) {
    assert.ok(!s.includes(leak), `no ${leak} in the record`);
  }
  // the authenticated actor is excluded (actor defaults to anonymous)
  assert.equal(rec.actor, 'anonymous', 'no username actor on the audit event');
});

// A7-17/18. Logger failure is swallowed; next() still executes.
test('A7-17/18. logger failure swallowed; next() runs', () => {
  const restore = logger.__setSink(() => { throw new Error('sink boom'); });
  const prev = logger.__setLevel('info');
  let nexted = false;
  requestContext.run({ requestId: 'x', module: 'System' }, () => {
    assert.doesNotThrow(() => A.initAuthorizationContext({ method: 'GET', path: '/api/users', session: { user: ADMIN } }, {}, () => { nexted = true; }));
  });
  logger.__setSink(restore); logger.__setLevel(prev);
  assert.equal(nexted, true);
});

// A7-23. Registry not mutated by the audit path.
test('A7-23. registry not mutated', () => {
  captureInit({ method: 'GET', path: '/api/users', session: { user: ADMIN } });
  const RP = require(path.join(ROOT, 'lib', 'auth', 'route-permissions.js'));
  assert.deepEqual(RP.getRoutePermissions('GET', '/api/users').permissions, ['users.read']);
});
