// WP-15 · D1 — Sensitive-data registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', '..', 'lib', 'governance', 'sensitive-data.js'));
const EXPECTED = ['credentials', 'pii', 'medical', 'disciplinary_freetext', 'financial', 'ai_content'];
const REDACTIONS = ['drop', 'mask', 'hash_reference'];

test('D1-s1. registry has all categories with valid redaction', () => {
  assert.deepEqual([...S.SENSITIVE_DATA_IDS].sort(), [...EXPECTED].sort());
  for (const id of S.SENSITIVE_DATA_IDS) {
    const e = S.SENSITIVE_DATA[id];
    assert.equal(e.id, id);
    assert.equal(typeof e.description, 'string');
    assert.ok(REDACTIONS.includes(e.redaction), `${id} redaction valid`);
  }
});

test('D1-s2. credentials / medical / disciplinary / ai_content are drop', () => {
  for (const id of ['credentials', 'medical', 'disciplinary_freetext', 'ai_content']) {
    assert.equal(S.SENSITIVE_DATA[id].redaction, 'drop', `${id} → drop`);
  }
});

test('D1-s3. unique ids + deep frozen', () => {
  assert.equal(S.SENSITIVE_DATA_IDS.length, new Set(S.SENSITIVE_DATA_IDS).size);
  assert.ok(Object.isFrozen(S.SENSITIVE_DATA) && Object.isFrozen(S.SENSITIVE_DATA_IDS));
  for (const id of S.SENSITIVE_DATA_IDS) assert.ok(Object.isFrozen(S.SENSITIVE_DATA[id]));
  try { S.SENSITIVE_DATA.HACK = {}; } catch { /* ok */ }
  try { S.SENSITIVE_DATA.pii.redaction = 'drop'; } catch { /* ok */ }
  assert.equal(S.SENSITIVE_DATA.HACK, undefined);
  assert.equal(S.SENSITIVE_DATA.pii.redaction, 'mask');
});

test('D1-s4. getSensitiveCategory: known + unknown → fail-safe drop; copy-on-read', () => {
  assert.equal(S.getSensitiveCategory('credentials').redaction, 'drop');
  for (const bad of ['nope', '', null, undefined, 5, {}]) {
    const d = S.getSensitiveCategory(bad);
    assert.equal(d.redaction, 'drop', `${String(bad)} → drop (fail-safe)`);
  }
  const a = S.getSensitiveCategory('pii');
  a.redaction = 'drop';
  assert.equal(S.getSensitiveCategory('pii').redaction, 'mask', 'registry unaffected');
});

test('D1-s5. listSensitiveCategories fresh copies; never throws', () => {
  const list = S.listSensitiveCategories();
  list.pop();
  assert.equal(S.listSensitiveCategories().length, EXPECTED.length);
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => S.getSensitiveCategory(bad));
});
