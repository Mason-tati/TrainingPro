// WP-15 · D1 — Business action registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const A = require(path.join(__dirname, '..', '..', 'lib', 'governance', 'actions.js'));
const EXPECTED = ['create', 'update', 'delete', 'approve', 'publish', 'archive', 'restore', 'export', 'view', 'login', 'logout', 'assign', 'verify', 'generate_ai', 'translate', 'train', 'assess', 'certify', 'complete']; // WP-15 D3 — 'complete' added for training.complete taxonomy event

test('D1-a1. registry has all actions with a category', () => {
  assert.deepEqual([...A.ACTION_IDS].sort(), [...EXPECTED].sort());
  for (const id of A.ACTION_IDS) {
    const e = A.ACTIONS[id];
    assert.equal(e.id, id);
    assert.equal(typeof e.description, 'string');
    assert.equal(typeof e.category, 'string');
    assert.ok(e.category.length > 0);
  }
});

test('D1-a2. unique ids + deep frozen', () => {
  assert.equal(A.ACTION_IDS.length, new Set(A.ACTION_IDS).size);
  assert.ok(Object.isFrozen(A.ACTIONS) && Object.isFrozen(A.ACTION_IDS));
  for (const id of A.ACTION_IDS) assert.ok(Object.isFrozen(A.ACTIONS[id]));
  try { A.ACTIONS.HACK = {}; } catch { /* ok */ }
  try { A.ACTIONS.create.category = 'x'; } catch { /* ok */ }
  assert.equal(A.ACTIONS.HACK, undefined);
  assert.equal(A.ACTIONS.create.category, 'mutation');
});

test('D1-a3. getAction: known + unknown → safe default; copy-on-read', () => {
  assert.equal(A.getAction('approve').id, 'approve');
  for (const bad of ['nope', '', null, undefined, 5, {}]) {
    assert.equal(A.getAction(bad).id, 'unknown', `${String(bad)} → unknown`);
    assert.equal(A.getAction(bad).category, 'unknown');
  }
  const a = A.getAction('view');
  a.category = 'x';
  assert.equal(A.getAction('view').category, 'access', 'registry unaffected');
});

test('D1-a4. listActions fresh copies; never throws', () => {
  const list = A.listActions();
  list.pop(); list[0].id = 'MUT';
  assert.equal(A.listActions().length, EXPECTED.length);
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => A.getAction(bad));
});
