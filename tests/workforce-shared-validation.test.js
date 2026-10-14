// EWP-01a — Workforce Foundation Framework — shared-validation tests.
// Pure predicate/helper vocabulary: every branch of every export exercised.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const V = require(path.join(__dirname, '..', 'lib', 'workforce', 'shared-validation.js'));

test('EWP-SV-1. type predicates cover true and false branches', () => {
  assert.equal(V.isPlainObject({}), true);
  assert.equal(V.isPlainObject(null), false);
  assert.equal(V.isPlainObject([]), false);
  assert.equal(V.isPlainObject('x'), false);
  assert.equal(V.isPositiveInteger(1), true);
  assert.equal(V.isPositiveInteger(0), false);
  assert.equal(V.isPositiveInteger(1.5), false);
  assert.equal(V.isNonNegativeInteger(0), true);
  assert.equal(V.isNonNegativeInteger(-1), false);
  assert.equal(V.isNonNegativeNumber(2.5), true);
  assert.equal(V.isNonNegativeNumber(0), true);
  assert.equal(V.isNonNegativeNumber(-1), false);
  assert.equal(V.isNonNegativeNumber(Infinity), false);
  assert.equal(V.isNonNegativeNumber('2'), false);
  assert.equal(V.isNonEmptyString('a'), true);
  assert.equal(V.isNonEmptyString('   '), false);
  assert.equal(V.isNonEmptyString(5), false);
  assert.equal(V.isBinaryFlag(0), true);
  assert.equal(V.isBinaryFlag(1), true);
  assert.equal(V.isBinaryFlag(2), false);
  assert.equal(V.isBoolean(true), true);
  assert.equal(V.isBoolean(0), false);
  assert.equal(V.isInSet('A', ['A', 'B']), true);
  assert.equal(V.isInSet('C', ['A', 'B']), false);
  assert.equal(V.isInSet('A', 'notarray'), false);
  assert.equal(V.isComparableDate('2026'), true);
  assert.equal(V.isComparableDate(''), false);
  assert.equal(V.isComparableDate(5), false);
});

test('EWP-SV-2. dateOrderOk: both/one/none/equal/violation', () => {
  assert.equal(V.dateOrderOk('2026-01-01', '2026-02-01'), true);
  assert.equal(V.dateOrderOk('2026-01-01', '2026-01-01'), true);
  assert.equal(V.dateOrderOk('2026-06-01', '2026-01-01'), false);
  assert.equal(V.dateOrderOk(null, '2026-01-01'), true);
  assert.equal(V.dateOrderOk('2026-01-01', null), true);
  assert.equal(V.dateOrderOk(null, null), true);
});

test('EWP-SV-3. invalid / ok result helpers', () => {
  assert.deepEqual(V.invalid('bad'), { ok: false, error: 'bad', code: 'VALIDATION' });
  assert.deepEqual(V.invalid('nope', 'CONFLICT'), { ok: false, error: 'nope', code: 'CONFLICT' });
  assert.deepEqual(V.ok({ record: { id: 1 } }), { ok: true, record: { id: 1 } });
  assert.deepEqual(V.ok(), { ok: true });
  assert.deepEqual(V.ok('not-object'), { ok: true });
});

test('EWP-SV-4. pick: present / absent-fallback / explicit-null / non-object src', () => {
  assert.equal(V.pick({ a: 5 }, 'a', 9), 5);
  assert.equal(V.pick({ a: 5 }, 'b', 9), 9);
  assert.equal(V.pick({ a: null }, 'a', 9), null);
  assert.equal(V.pick('nope', 'a', 9), 9);
});

test('EWP-SV-5. parseMetadata: valid / corrupt / empty / non-string', () => {
  assert.deepEqual(V.parseMetadata('{"a":1}'), { a: 1 });
  assert.equal(V.parseMetadata('{bad'), null);
  assert.equal(V.parseMetadata(''), null);
  assert.equal(V.parseMetadata(undefined), null);
  assert.equal(V.parseMetadata(5), null);
});

test('EWP-SV-6. withMetadata: parsed / null / non-object row (copy-on-read)', () => {
  const row = { id: 1, metadataJson: '{"x":2}' };
  const out = V.withMetadata(row);
  assert.deepEqual(out.metadata, { x: 2 });
  assert.notEqual(out, row, 'fresh copy');
  assert.equal(V.withMetadata({ id: 2 }).metadata, null);
  assert.deepEqual(V.withMetadata('nope'), { metadata: null });
});

test('EWP-SV-7. toMetadataJson: undefined / object / non-object / unserializable', () => {
  assert.equal(V.toMetadataJson(undefined), undefined);
  assert.equal(V.toMetadataJson({ a: 1 }), '{"a":1}');
  assert.equal(V.toMetadataJson(5), null);
  const circular = {}; circular.self = circular;
  assert.equal(V.toMetadataJson(circular), null, 'JSON.stringify throw is caught → null');
});
