// WP-15 · D1 — Classification registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', '..', 'lib', 'governance', 'classifications.js'));
const EXPECTED = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_CONFIDENTIAL', 'SAFETY_CRITICAL', 'HR_CONFIDENTIAL', 'MEDICAL', 'FINANCIAL', 'LEGAL', 'AI_GENERATED', 'AI_VERIFIED', 'EXPORT_CONTROLLED'];

test('D1-c1. registry has all labels with valid shape', () => {
  assert.deepEqual([...C.CLASSIFICATION_IDS].sort(), [...EXPECTED].sort());
  for (const id of C.CLASSIFICATION_IDS) {
    const e = C.CLASSIFICATIONS[id];
    assert.equal(e.id, id);
    assert.equal(typeof e.description, 'string');
    assert.equal(typeof e.sensitivityRank, 'number');
    assert.equal(e.extensible, true);
  }
});

test('D1-c2. unique ids + unique sensitivity ranks', () => {
  assert.equal(C.CLASSIFICATION_IDS.length, new Set(C.CLASSIFICATION_IDS).size);
  const ranks = C.CLASSIFICATION_IDS.map((k) => C.CLASSIFICATIONS[k].sensitivityRank);
  assert.equal(ranks.length, new Set(ranks).size, 'ranks unique');
});

test('D1-c3. deep frozen / immutable', () => {
  assert.ok(Object.isFrozen(C.CLASSIFICATIONS) && Object.isFrozen(C.CLASSIFICATION_IDS));
  for (const id of C.CLASSIFICATION_IDS) assert.ok(Object.isFrozen(C.CLASSIFICATIONS[id]));
  try { C.CLASSIFICATIONS.HACK = {}; } catch { /* strict ok */ }
  try { C.CLASSIFICATIONS.PUBLIC.sensitivityRank = 99; } catch { /* strict ok */ }
  assert.equal(C.CLASSIFICATIONS.HACK, undefined);
  assert.equal(C.CLASSIFICATIONS.PUBLIC.sensitivityRank, 0);
});

test('D1-c4. getClassification: known + unknown → safe PUBLIC; copy-on-read', () => {
  assert.equal(C.getClassification('MEDICAL').id, 'MEDICAL');
  for (const bad of ['nope', '', 'medical', null, undefined, 5, {}]) {
    assert.equal(C.getClassification(bad).id, 'PUBLIC', `${String(bad)} → PUBLIC`);
  }
  const a = C.getClassification('LEGAL');
  a.description = 'x'; a.sensitivityRank = -1;
  assert.equal(C.getClassification('LEGAL').description !== 'x', true, 'registry unaffected');
  assert.notEqual(a, C.CLASSIFICATIONS.LEGAL, 'fresh copy');
});

test('D1-c5. listClassifications returns fresh copies', () => {
  const list = C.listClassifications();
  assert.equal(list.length, EXPECTED.length);
  list.pop(); list[0].id = 'MUT';
  assert.equal(C.listClassifications().length, EXPECTED.length);
  assert.equal(C.CLASSIFICATIONS.PUBLIC.id, 'PUBLIC');
});

test('D1-c6. never throws on malformed input', () => {
  for (const bad of [undefined, null, NaN, {}, [], true, 5, Symbol('x'), () => {}]) {
    assert.doesNotThrow(() => C.getClassification(bad));
  }
  assert.doesNotThrow(() => C.listClassifications());
});
