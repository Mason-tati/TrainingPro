// WP-14 · A1 — Role registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const R = require(path.join(__dirname, '..', '..', 'lib', 'auth', 'roles.js'));
const { PERMISSIONS } = require(path.join(__dirname, '..', '..', 'lib', 'auth', 'permissions.js'));

const EXPECTED_ROLES = ['ADMIN', 'TRAINING_MANAGER', 'TRAINER', 'SUPERVISOR', 'OPERATOR', 'HR', 'SAFETY', 'VIEWER'];

// 1. All built-in roles exist with the required shape.
test('A1-r1. all built-in roles exist and are well-formed', () => {
  for (const name of EXPECTED_ROLES) {
    const role = R.ROLES[name];
    assert.ok(role, `${name} exists`);
    assert.equal(role.name, name);
    assert.equal(typeof role.description, 'string');
    assert.ok(Array.isArray(role.inherits));
    assert.ok(Array.isArray(role.permissions));
  }
  assert.deepEqual([...R.ROLE_NAMES].sort(), [...EXPECTED_ROLES].sort());
});

// 2. Inheritance references are valid role names.
test('A1-r2. inheritance references resolve to known roles', () => {
  for (const name of R.ROLE_NAMES) {
    for (const parent of R.ROLES[name].inherits) {
      assert.ok(Object.prototype.hasOwnProperty.call(R.ROLES, parent), `${name} inherits known role ${parent}`);
    }
  }
  assert.deepEqual(R.ROLES.ADMIN.inherits, ['TRAINING_MANAGER', 'HR', 'SAFETY']);
  assert.deepEqual(R.ROLES.VIEWER.inherits, []);
});

// 3. Every referenced permission is a known permission.
test('A1-r3. role permissions reference known permissions', () => {
  for (const name of R.ROLE_NAMES) {
    for (const p of R.ROLES[name].permissions) {
      assert.ok(Object.prototype.hasOwnProperty.call(PERMISSIONS, p), `${name}.${p} is a known permission`);
    }
  }
});

// 4. Immutable (root, roles, and their arrays).
test('A1-r4. role registry is immutable', () => {
  assert.ok(Object.isFrozen(R.ROLES));
  assert.ok(Object.isFrozen(R.ROLE_NAMES));
  for (const name of R.ROLE_NAMES) {
    assert.ok(Object.isFrozen(R.ROLES[name]), `${name} frozen`);
    assert.ok(Object.isFrozen(R.ROLES[name].inherits), `${name}.inherits frozen`);
    assert.ok(Object.isFrozen(R.ROLES[name].permissions), `${name}.permissions frozen`);
  }
  try { R.ROLES.HACK = {}; } catch { /* strict throw ok */ }
  try { R.ROLES.ADMIN.permissions.push('hack'); } catch { /* strict throw ok */ }
  assert.equal(R.ROLES.HACK, undefined);
  assert.ok(!R.ROLES.ADMIN.permissions.includes('hack'));
});

// 5. No duplicate permissions within a single role's own list.
test('A1-r5. no duplicate own-permissions in any role', () => {
  for (const name of R.ROLE_NAMES) {
    const own = R.ROLES[name].permissions;
    assert.equal(own.length, new Set(own).size, `${name} has no duplicate own-permissions`);
  }
});

// 6. Unknown roles are absent.
test('A1-r6. unknown roles are not present', () => {
  for (const name of ['SUPERADMIN', 'guest', '', 'admin', 'Viewer']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(R.ROLES, name), `${name} absent`);
  }
});
