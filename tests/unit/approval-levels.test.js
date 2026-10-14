// WP-17 · D1 — Approval-level registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const A = require(path.join(__dirname, '..', '..', 'lib', 'document', 'approval-levels.js'));

const EXPECTED_LEVEL = { NONE: 0, SUPERVISOR: 1, SUPERINTENDENT: 2, MANAGER: 3, SITE_MANAGER: 4, GENERAL_MANAGER: 5, EXECUTIVE: 6, MULTI_LEVEL: 99 };
const EXPECTED = Object.keys(EXPECTED_LEVEL);

test('AL-1. registry has all approval levels with the full shape + correct level', () => {
  assert.deepEqual([...A.APPROVAL_LEVEL_IDS].sort(), [...EXPECTED].sort());
  for (const id of A.APPROVAL_LEVEL_IDS) {
    const a = A.APPROVAL_LEVELS[id];
    assert.equal(a.id, id);
    assert.equal(typeof a.displayName, 'string');
    assert.equal(typeof a.description, 'string');
    assert.equal(typeof a.level, 'number');
    assert.equal(a.level, EXPECTED_LEVEL[id], `${id} level`);
  }
});

test('AL-2. unique ids + unique, ascending levels for the linear chain', () => {
  assert.equal(A.APPROVAL_LEVEL_IDS.length, new Set(A.APPROVAL_LEVEL_IDS).size);
  const levels = A.APPROVAL_LEVEL_IDS.map((id) => A.APPROVAL_LEVELS[id].level);
  assert.equal(levels.length, new Set(levels).size, 'levels unique');
  const chain = ['NONE', 'SUPERVISOR', 'SUPERINTENDENT', 'MANAGER', 'SITE_MANAGER', 'GENERAL_MANAGER', 'EXECUTIVE'];
  for (let i = 1; i < chain.length; i += 1) {
    assert.ok(A.APPROVAL_LEVELS[chain[i]].level > A.APPROVAL_LEVELS[chain[i - 1]].level, `${chain[i]} > ${chain[i - 1]}`);
  }
  assert.ok(A.APPROVAL_LEVELS.MULTI_LEVEL.level > A.APPROVAL_LEVELS.EXECUTIVE.level, 'MULTI_LEVEL is the highest sentinel');
});

test('AL-3. deep frozen / immutable', () => {
  assert.ok(Object.isFrozen(A.APPROVAL_LEVELS) && Object.isFrozen(A.APPROVAL_LEVEL_IDS));
  for (const id of A.APPROVAL_LEVEL_IDS) assert.ok(Object.isFrozen(A.APPROVAL_LEVELS[id]));
  try { A.APPROVAL_LEVELS.HACK = {}; } catch { /* ok */ }
  try { A.APPROVAL_LEVELS.MANAGER.level = -1; } catch { /* ok */ }
  assert.equal(A.APPROVAL_LEVELS.HACK, undefined);
  assert.equal(A.APPROVAL_LEVELS.MANAGER.level, 3);
});

test('AL-4. getApprovalLevel: known + unknown → safe NONE-like default; copy-on-read', () => {
  assert.equal(A.getApprovalLevel('MANAGER').level, 3);
  const d = A.getApprovalLevel('NOPE');
  assert.equal(d.id, 'unknown');
  assert.equal(d.level, 0, 'unknown → level 0');
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(A.getApprovalLevel(bad).id, 'unknown');
  const c = A.getApprovalLevel('MANAGER');
  c.level = 99;
  assert.equal(A.APPROVAL_LEVELS.MANAGER.level, 3);
  assert.notEqual(c, A.APPROVAL_LEVELS.MANAGER);
});

test('AL-5. listApprovalLevels: fresh array + copies; never throws', () => {
  const a = A.listApprovalLevels();
  const b = A.listApprovalLevels();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].level = -5;
  assert.equal(A.listApprovalLevels().length, EXPECTED.length);
  assert.equal(A.getApprovalLevel('NONE').level, 0);
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => A.getApprovalLevel(bad));
});
