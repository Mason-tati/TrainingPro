// WP-14 · A1 — Permission registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const P = require(path.join(__dirname, '..', '..', 'lib', 'auth', 'permissions.js'));

// 1. Registry exists and is well-formed.
test('A1-p1. registry exists with well-formed entries', () => {
  assert.equal(typeof P.PERMISSIONS, 'object');
  assert.ok(P.PERMISSION_IDS.length >= 20, 'a substantial permission set');
  for (const id of P.PERMISSION_IDS) {
    const e = P.PERMISSIONS[id];
    assert.equal(e.id, id, 'id matches key');
    assert.equal(typeof e.description, 'string');
    assert.ok(e.description.length > 0);
    assert.equal(e.module, id.split('.')[0], 'module derives from id');
    assert.ok(P.RISK_LEVELS.includes(e.risk), `${id} has a valid risk`);
  }
});

// 2. Immutable (root + entries).
test('A1-p2. registry is immutable', () => {
  assert.ok(Object.isFrozen(P.PERMISSIONS));
  assert.ok(Object.isFrozen(P.PERMISSION_IDS));
  for (const id of P.PERMISSION_IDS) assert.ok(Object.isFrozen(P.PERMISSIONS[id]), `${id} frozen`);
  try { P.PERMISSIONS['x.y'] = {}; } catch { /* strict throw ok */ }
  try { P.PERMISSIONS['users.read'].risk = 'critical'; } catch { /* strict throw ok */ }
  assert.equal(P.PERMISSIONS['x.y'], undefined, 'cannot add');
  assert.equal(P.PERMISSIONS['users.read'].risk, 'low', 'cannot mutate entry');
});

// 3. Unique IDs.
test('A1-p3. permission ids are unique', () => {
  assert.equal(P.PERMISSION_IDS.length, new Set(P.PERMISSION_IDS).size);
});

// 4. Valid naming convention: module.action (lowercase, single dot).
test('A1-p4. ids follow the module.action naming convention', () => {
  for (const id of P.PERMISSION_IDS) {
    assert.ok(/^[a-z]+\.[a-z_]+$/.test(id), `${id} matches module.action`);
    assert.equal(id.split('.').length, 2, `${id} has exactly one dot`);
  }
});

// 5. Known / expected permissions present.
test('A1-p5. expected permissions exist', () => {
  for (const id of ['users.read', 'training.write', 'documents.translate', 'ai.use', 'ai.admin', 'reports.export', 'settings.write', 'admin.full']) {
    assert.ok(Object.prototype.hasOwnProperty.call(P.PERMISSIONS, id), `${id} present`);
  }
});

// 6. Unknown permissions are absent.
test('A1-p6. unknown permissions are not in the registry', () => {
  for (const id of ['nope.read', 'users.superuser', '', 'usersread', 'USERS.READ']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(P.PERMISSIONS, id), `${id} absent`);
  }
});

// 7. No mutation leaks (PERMISSION_IDS is frozen; entries frozen).
test('A1-p7. registry cannot be mutated via exports', () => {
  try { P.PERMISSION_IDS.push('hack'); } catch { /* strict throw ok */ }
  assert.ok(!P.PERMISSION_IDS.includes('hack'));
  try { P.RISK_LEVELS.push('extreme'); } catch { /* strict throw ok */ }
  assert.ok(!P.RISK_LEVELS.includes('extreme'));
});
