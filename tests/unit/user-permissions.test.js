// WP-14 · A2 — User permission resolution tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const UP = require(path.join(ROOT, 'lib', 'auth', 'user-permissions.js'));
const { ROLES } = require(path.join(ROOT, 'lib', 'auth', 'roles.js'));
const { PERMISSIONS } = require(path.join(ROOT, 'lib', 'auth', 'permissions.js'));

// 1. role as a string.
test('A2-1. role string', () => {
  assert.deepEqual(UP.resolveUserRoles({ role: 'ADMIN' }), ['ADMIN']);
});

// 2. roles as an array.
test('A2-2. roles array', () => {
  assert.deepEqual(UP.resolveUserRoles({ roles: ['HR', 'SAFETY'] }), ['HR', 'SAFETY']);
});

// 3. roleName.
test('A2-3. roleName', () => {
  assert.deepEqual(UP.resolveUserRoles({ roleName: 'TRAINER' }), ['TRAINER']);
});

// 4. roleNames.
test('A2-4. roleNames', () => {
  assert.deepEqual(UP.resolveUserRoles({ roleNames: ['VIEWER', 'OPERATOR'] }), ['OPERATOR', 'VIEWER']);
});

// 5. priority order — the first source with ≥1 known role wins.
test('A2-5. priority order (roleNames > roles > roleName > role)', () => {
  assert.deepEqual(UP.resolveUserRoles({ roleNames: ['ADMIN'], roles: ['HR'], roleName: 'TRAINER', role: 'VIEWER' }), ['ADMIN']);
  assert.deepEqual(UP.resolveUserRoles({ roles: ['HR'], roleName: 'TRAINER', role: 'VIEWER' }), ['HR']);
  assert.deepEqual(UP.resolveUserRoles({ roleName: 'TRAINER', role: 'VIEWER' }), ['TRAINER']);
  // an unknown-only higher-priority source falls through to the next
  assert.deepEqual(UP.resolveUserRoles({ roleNames: ['NOPE'], role: 'ADMIN' }), ['ADMIN']);
});

// 6. duplicates removed.
test('A2-6. duplicates removed', () => {
  assert.deepEqual(UP.resolveUserRoles({ roles: ['HR', 'HR', 'hr'] }), ['HR']);
});

// 7. whitespace trimmed.
test('A2-7. whitespace trimmed', () => {
  assert.deepEqual(UP.resolveUserRoles({ role: '  ADMIN  ' }), ['ADMIN']);
  assert.deepEqual(UP.resolveUserRoles({ roles: [' HR ', 'SAFETY '] }), ['HR', 'SAFETY']);
});

// 8. case-insensitive matching → canonical names.
test('A2-8. case-insensitive → canonical', () => {
  assert.deepEqual(UP.resolveUserRoles({ role: 'admin' }), ['ADMIN']);
  assert.deepEqual(UP.resolveUserRoles({ roles: ['Trainer', 'sUpErViSoR'] }), ['SUPERVISOR', 'TRAINER']);
});

// 9. inherited permissions are resolved.
test('A2-9. inherited permissions resolved', () => {
  const perms = UP.resolveUserPermissions({ role: 'TRAINER' });
  for (const p of ['training.read', 'documents.read', 'training.write', 'ai.use']) assert.ok(perms.includes(p), p);
  // ADMIN resolves to every permission
  assert.deepEqual(UP.resolveUserPermissions({ role: 'ADMIN' }).sort(), Object.keys(PERMISSIONS).sort());
});

// 10. unknown roles contribute nothing.
test('A2-10. unknown roles ignored', () => {
  assert.deepEqual(UP.resolveUserRoles({ roles: ['NOPE', 'HR', 'ghost'] }), ['HR']);
  assert.deepEqual(UP.resolveUserPermissions({ role: 'NOPE' }), []);
});

// 11. empty user → empty results.
test('A2-11. empty user', () => {
  assert.deepEqual(UP.resolveUserRoles({}), []);
  assert.deepEqual(UP.resolveUserPermissions({}), []);
});

// 12. null / undefined user.
test('A2-12. null / undefined user', () => {
  for (const u of [null, undefined]) {
    assert.deepEqual(UP.resolveUserRoles(u), []);
    assert.deepEqual(UP.resolveUserPermissions(u), []);
  }
});

// 13. malformed values are ignored safely.
test('A2-13. malformed values ignored', () => {
  assert.deepEqual(UP.resolveUserRoles({ role: 5 }), []);
  assert.deepEqual(UP.resolveUserRoles({ roles: [5, null, {}, 'HR'] }), ['HR']);
  assert.deepEqual(UP.resolveUserRoles({ roleNames: 'ADMIN' }), ['ADMIN'], 'string in a *Names field still works');
  assert.deepEqual(UP.resolveUserRoles([1, 2, 3]), [], 'array user → []');
  assert.deepEqual(UP.resolveUserRoles('ADMIN'), [], 'string user → []');
});

// 14. never mutates the input.
test('A2-14. no mutation of the user', () => {
  const user = { roles: ['HR', 'hr'], role: 'ADMIN' };
  const snap = JSON.parse(JSON.stringify(user));
  UP.resolveUserRoles(user);
  UP.resolveUserPermissions(user);
  UP.hasUserPermission(user, 'hr.read');
  assert.deepEqual(user, snap, 'input unchanged');
});

// 15. returns fresh arrays.
test('A2-15. fresh arrays returned', () => {
  const a = UP.resolveUserPermissions({ role: 'ADMIN' });
  const n = a.length;
  a.push('hack');
  assert.equal(UP.resolveUserPermissions({ role: 'ADMIN' }).length, n, 'internal state unaffected');
  const r = UP.resolveUserRoles({ roles: ['HR', 'SAFETY'] });
  r.pop();
  assert.deepEqual(UP.resolveUserRoles({ roles: ['HR', 'SAFETY'] }), ['HR', 'SAFETY']);
});

// 16. permission helpers behave consistently with A1 semantics.
test('A2-16. helper functions', () => {
  const trainer = { role: 'TRAINER' };
  assert.equal(UP.hasUserPermission(trainer, 'training.read'), true, 'inherited');
  assert.equal(UP.hasUserPermission(trainer, 'admin.full'), false);
  assert.equal(UP.hasUserPermission(trainer, 'not.aperm'), false, 'unknown permission');
  assert.equal(UP.hasUserAnyPermission(trainer, ['admin.full', 'training.write']), true);
  assert.equal(UP.hasUserAnyPermission(trainer, ['admin.full', 'users.delete']), false);
  assert.equal(UP.hasUserAllPermissions(trainer, ['training.read', 'training.write']), true);
  assert.equal(UP.hasUserAllPermissions(trainer, ['training.write', 'admin.full']), false);
  // empty-array semantics
  assert.equal(UP.hasUserAllPermissions(trainer, []), true);
  assert.equal(UP.hasUserAnyPermission(trainer, []), false);
  // unknown user → false
  assert.equal(UP.hasUserPermission(null, 'training.read'), false);
  assert.equal(UP.hasUserAnyPermission({}, ['training.read']), false);
  assert.equal(UP.hasUserAllPermissions({}, ['training.read']), false);
  // non-array permission args → false
  assert.equal(UP.hasUserAnyPermission(trainer, 'training.read'), false);
  assert.equal(UP.hasUserAllPermissions(trainer, 'training.read'), false);
});

// 17. never throws on malformed input.
test('A2-17. never throws', () => {
  const inputs = [undefined, null, NaN, {}, [], true, 5, '', Symbol('x'), () => {}, { role: {} }, { roles: 5 }];
  for (const i of inputs) {
    assert.doesNotThrow(() => UP.resolveUserRoles(i));
    assert.doesNotThrow(() => UP.resolveUserPermissions(i));
    assert.doesNotThrow(() => UP.normalizeUserRoles(i));
    assert.doesNotThrow(() => UP.hasUserPermission(i, i));
    assert.doesNotThrow(() => UP.hasUserAnyPermission(i, i));
    assert.doesNotThrow(() => UP.hasUserAllPermissions(i, i));
  }
});

// 18. underlying registries remain immutable.
test('A2-18. registries remain immutable', () => {
  assert.ok(Object.isFrozen(ROLES) && Object.isFrozen(PERMISSIONS));
  UP.resolveUserPermissions({ role: 'ADMIN' });
  assert.ok(Object.isFrozen(ROLES.ADMIN.permissions), 'role permissions still frozen after use');
});

// 19. Only the sanctioned WP-14 A3 integration point (routes/auth.js) may import
// the module; server.js and every OTHER route must not.
test('A2-19. only the sanctioned auth route imports the module', () => {
  const files = [path.join(ROOT, 'server.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) {
    if (f.endsWith('.js') && f !== 'auth.js') files.push(path.join(routesDir, f)); // auth.js is the A3 consumer
  }
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('auth/user-permissions'), `${path.basename(f)} must not import auth/user-permissions`);
  }
});
