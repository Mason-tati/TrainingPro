// WP-15 · D1 — Retention registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const R = require(path.join(__dirname, '..', '..', 'lib', 'governance', 'retention.js'));
const EXPECTED = ['transient', 'standard', 'extended', 'legal_hold', 'permanent'];
const FLAGS = ['legalHoldSupported', 'archiveRequired', 'autoDeleteEligible', 'approvalRequired', 'exportReviewRequired'];

test('D1-r1. registry has all categories; durations are NULL placeholders', () => {
  assert.deepEqual([...R.RETENTION_IDS].sort(), [...EXPECTED].sort());
  for (const id of R.RETENTION_IDS) {
    const e = R.RETENTION[id];
    assert.equal(e.id, id);
    assert.equal(e.defaultYears, null, `${id}.defaultYears remains null`);
    for (const f of FLAGS) assert.equal(typeof e[f], 'boolean', `${id}.${f} boolean`);
  }
});

test('D1-r2. unique ids', () => {
  assert.equal(R.RETENTION_IDS.length, new Set(R.RETENTION_IDS).size);
});

test('D1-r3. deep frozen / immutable', () => {
  assert.ok(Object.isFrozen(R.RETENTION) && Object.isFrozen(R.RETENTION_IDS));
  for (const id of R.RETENTION_IDS) assert.ok(Object.isFrozen(R.RETENTION[id]));
  try { R.RETENTION.HACK = {}; } catch { /* ok */ }
  try { R.RETENTION.transient.autoDeleteEligible = false; } catch { /* ok */ }
  assert.equal(R.RETENTION.HACK, undefined);
  assert.equal(R.RETENTION.transient.autoDeleteEligible, true);
});

test('D1-r4. getRetention: known + unknown → safe standard (not auto-delete); copy-on-read', () => {
  assert.equal(R.getRetention('legal_hold').id, 'legal_hold');
  for (const bad of ['nope', '', null, undefined, 5, {}]) {
    const d = R.getRetention(bad);
    assert.equal(d.id, 'standard', `${String(bad)} → standard`);
    assert.equal(d.autoDeleteEligible, false, 'safe default is not auto-delete-eligible');
  }
  const a = R.getRetention('standard');
  a.defaultYears = 7;
  assert.equal(R.getRetention('standard').defaultYears, null, 'registry unaffected');
});

test('D1-r5. no category is auto-delete-eligible except transient (no enforcement)', () => {
  for (const id of R.RETENTION_IDS) {
    if (id !== 'transient') assert.equal(R.RETENTION[id].autoDeleteEligible, false, `${id} not auto-delete`);
  }
});

test('D1-r6. listRetention fresh copies; never throws', () => {
  const list = R.listRetention();
  list.pop();
  assert.equal(R.listRetention().length, EXPECTED.length);
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => R.getRetention(bad));
});
