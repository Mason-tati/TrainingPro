// WP-14 · A1 — Access-control helper tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AC = require(path.join(__dirname, '..', '..', 'lib', 'auth', 'access-control.js'));

// 1. isKnownRole / isKnownPermission.
test('A1-ac1. known-role / known-permission guards', () => {
  assert.equal(AC.isKnownRole('ADMIN'), true);
  assert.equal(AC.isKnownRole('NOPE'), false);
  for (const bad of [null, undefined, 5, {}, '', 'admin']) assert.equal(AC.isKnownRole(bad), false);
  assert.equal(AC.isKnownPermission('users.read'), true);
  assert.equal(AC.isKnownPermission('users.superuser'), false);
  for (const bad of [null, undefined, 5, {}, '']) assert.equal(AC.isKnownPermission(bad), false);
});

// 2. hasPermission (direct + inherited).
test('A1-ac2. hasPermission honours direct and inherited grants', () => {
  assert.equal(AC.hasPermission('VIEWER', 'training.read'), true, 'direct');
  assert.equal(AC.hasPermission('TRAINER', 'training.read'), true, 'inherited from VIEWER');
  assert.equal(AC.hasPermission('TRAINER', 'training.write'), true, 'direct');
  assert.equal(AC.hasPermission('VIEWER', 'training.write'), false, 'not granted');
  assert.equal(AC.hasPermission('ADMIN', 'admin.full'), true);
});

// 3. Inheritance expansion (transitive, includes self, cycle-safe).
test('A1-ac3. expandInheritedRoles is transitive and includes self', () => {
  assert.deepEqual(AC.expandInheritedRoles('VIEWER').sort(), ['VIEWER']);
  assert.deepEqual(AC.expandInheritedRoles('TRAINER').sort(), ['OPERATOR', 'TRAINER', 'VIEWER']);
  const admin = AC.expandInheritedRoles('ADMIN').sort();
  assert.deepEqual(admin, ['ADMIN', 'HR', 'OPERATOR', 'SAFETY', 'SUPERVISOR', 'TRAINER', 'TRAINING_MANAGER', 'VIEWER']);
  assert.deepEqual(AC.expandInheritedRoles('NOPE'), [], 'unknown role → []');
});

// 4. getEffectivePermissions (union of own + inherited; sorted; fresh copy).
test('A1-ac4. getEffectivePermissions unions inherited permissions', () => {
  const trainer = AC.getEffectivePermissions('TRAINER');
  for (const p of ['training.read', 'documents.read', 'training.write', 'ai.use']) assert.ok(trainer.includes(p), p);
  // ADMIN effectively holds every permission
  const { PERMISSION_IDS } = require(path.join(__dirname, '..', '..', 'lib', 'auth', 'permissions.js'));
  const admin = AC.getEffectivePermissions('ADMIN');
  assert.deepEqual(admin.sort(), [...PERMISSION_IDS].sort(), 'ADMIN has all permissions');
  assert.deepEqual(AC.getEffectivePermissions('NOPE'), [], 'unknown role → []');
});

// 5. hasAnyPermission / hasAllPermissions.
test('A1-ac5. hasAny / hasAll', () => {
  assert.equal(AC.hasAnyPermission('VIEWER', ['training.write', 'training.read']), true);
  assert.equal(AC.hasAnyPermission('VIEWER', ['training.write', 'users.delete']), false);
  assert.equal(AC.hasAllPermissions('SUPERVISOR', ['training.read', 'training.write', 'competency.write']), true);
  assert.equal(AC.hasAllPermissions('SUPERVISOR', ['training.write', 'admin.full']), false);
  // vacuous truth for an empty requirement; unknown perms never satisfy
  assert.equal(AC.hasAllPermissions('ADMIN', []), true);
  assert.equal(AC.hasAnyPermission('ADMIN', []), false);
  assert.equal(AC.hasAnyPermission('ADMIN', ['not.aperm']), false);
});

// 6. Unknown role / permission are always safe (false / empty).
test('A1-ac6. unknown role or permission is safe', () => {
  assert.equal(AC.hasPermission('NOPE', 'training.read'), false);
  assert.equal(AC.hasPermission('ADMIN', 'not.aperm'), false);
  assert.equal(AC.hasAnyPermission('NOPE', ['training.read']), false);
  assert.equal(AC.hasAllPermissions('NOPE', ['training.read']), false);
});

// 7. Never throws on malformed input.
test('A1-ac7. helpers never throw on malformed input', () => {
  const inputs = [undefined, null, NaN, {}, [], true, 5, '', Symbol('x'), () => {}];
  for (const i of inputs) {
    assert.doesNotThrow(() => AC.hasPermission(i, i));
    assert.doesNotThrow(() => AC.hasAnyPermission(i, i));
    assert.doesNotThrow(() => AC.hasAllPermissions(i, i));
    assert.doesNotThrow(() => AC.expandInheritedRoles(i));
    assert.doesNotThrow(() => AC.getEffectivePermissions(i));
    assert.doesNotThrow(() => AC.isKnownRole(i));
    assert.doesNotThrow(() => AC.isKnownPermission(i));
  }
});

// 8. Returned collections are fresh copies (mutating them is harmless).
test('A1-ac8. returned arrays are copies (no mutation of internals)', () => {
  const a = AC.getEffectivePermissions('ADMIN');
  const n = a.length;
  a.push('hack');
  assert.equal(AC.getEffectivePermissions('ADMIN').length, n, 'internal state unaffected');
  const roles = AC.expandInheritedRoles('ADMIN');
  const rn = roles.length;
  roles.pop();
  assert.equal(AC.expandInheritedRoles('ADMIN').length, rn, 'internal state unaffected');
});
