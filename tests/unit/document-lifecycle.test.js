// WP-17 · D1 — Document-lifecycle registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const L = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-lifecycle.js'));

const EXPECTED = ['create', 'review', 'approve', 'publish', 'read', 'revise', 'supersede', 'archive', 'restore', 'delete'];
const FLAGS = ['requiresApproval', 'requiresAudit', 'requiresVersion', 'requiresPermission'];

test('DL-1. registry has all lifecycle stages with the full shape', () => {
  assert.deepEqual([...L.DOCUMENT_LIFECYCLE_IDS].sort(), [...EXPECTED].sort());
  for (const id of L.DOCUMENT_LIFECYCLE_IDS) {
    const s = L.DOCUMENT_LIFECYCLE[id];
    assert.equal(s.id, id);
    assert.equal(typeof s.displayName, 'string');
    for (const f of FLAGS) assert.equal(typeof s[f], 'boolean', `${id}.${f} boolean`);
  }
});

test('DL-2. unique ids', () => {
  assert.equal(L.DOCUMENT_LIFECYCLE_IDS.length, new Set(L.DOCUMENT_LIFECYCLE_IDS).size);
  assert.equal(L.DOCUMENT_LIFECYCLE_IDS.length, EXPECTED.length);
});

test('DL-3. deep frozen / immutable', () => {
  assert.ok(Object.isFrozen(L.DOCUMENT_LIFECYCLE) && Object.isFrozen(L.DOCUMENT_LIFECYCLE_IDS));
  for (const id of L.DOCUMENT_LIFECYCLE_IDS) assert.ok(Object.isFrozen(L.DOCUMENT_LIFECYCLE[id]));
  try { L.DOCUMENT_LIFECYCLE.HACK = {}; } catch { /* ok */ }
  try { L.DOCUMENT_LIFECYCLE.create.requiresAudit = false; } catch { /* ok */ }
  assert.equal(L.DOCUMENT_LIFECYCLE.HACK, undefined);
  assert.equal(L.DOCUMENT_LIFECYCLE.create.requiresAudit, true);
});

test('DL-4. known semantics: every action is audited + permissioned; approval/version vary', () => {
  for (const id of L.DOCUMENT_LIFECYCLE_IDS) {
    assert.equal(L.DOCUMENT_LIFECYCLE[id].requiresAudit, true, `${id} audited`);
    assert.equal(L.DOCUMENT_LIFECYCLE[id].requiresPermission, true, `${id} permissioned`);
  }
  assert.equal(L.DOCUMENT_LIFECYCLE.approve.requiresApproval, true);
  assert.equal(L.DOCUMENT_LIFECYCLE.create.requiresApproval, false);
  assert.equal(L.DOCUMENT_LIFECYCLE.create.requiresVersion, true);
  assert.equal(L.DOCUMENT_LIFECYCLE.review.requiresVersion, false);
  // approval + version each vary across the registry
  for (const f of ['requiresApproval', 'requiresVersion']) {
    const vals = L.DOCUMENT_LIFECYCLE_IDS.map((id) => L.DOCUMENT_LIFECYCLE[id][f]);
    assert.ok(vals.includes(true) && vals.includes(false), `${f} varies`);
  }
});

test('DL-5. getLifecycleStage: known + unknown → most-restrictive default; copy-on-read', () => {
  assert.equal(L.getLifecycleStage('approve').id, 'approve');
  const d = L.getLifecycleStage('NOPE');
  assert.equal(d.id, 'unknown');
  for (const f of FLAGS) assert.equal(d[f], true, `unknown → ${f} required (restrictive)`);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(L.getLifecycleStage(bad).id, 'unknown');
  const c = L.getLifecycleStage('create');
  c.requiresAudit = false;
  assert.equal(L.DOCUMENT_LIFECYCLE.create.requiresAudit, true);
  assert.notEqual(c, L.DOCUMENT_LIFECYCLE.create);
});

test('DL-6. listLifecycleStages: fresh array + copies; never throws', () => {
  const a = L.listLifecycleStages();
  const b = L.listLifecycleStages();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated';
  assert.equal(L.listLifecycleStages().length, EXPECTED.length);
  assert.notEqual(L.getLifecycleStage('create').id, 'mutated');
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => L.getLifecycleStage(bad));
});
