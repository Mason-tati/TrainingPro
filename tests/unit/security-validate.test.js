// WP-13 · S6 — Input validation helper tests.
// Pure functions: proves each helper's contract, traversal/null-byte rejection,
// non-string safety, and that malformed input never throws.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const V = require(path.join(__dirname, '..', '..', 'lib', 'security', 'validate.js'));

const NUL = '\x00';

// 1. isNonEmptyString
test('S6-v1. isNonEmptyString', () => {
  assert.equal(V.isNonEmptyString('x'), true);
  for (const bad of ['', '   ', undefined, null, 0, 5, {}, [], true]) assert.equal(V.isNonEmptyString(bad), false);
});

// 2. isSafeId
test('S6-v2. isSafeId', () => {
  for (const ok of ['abc', 'A1_b-2', 'STAFF_001']) assert.equal(V.isSafeId(ok), true);
  for (const bad of ['../etc', 'a/b', 'a\\b', 'a.b', `a${NUL}b`, '', 'x '.repeat(200), 5, null]) assert.equal(V.isSafeId(bad), false, String(bad));
});

// 3. isPositiveInteger
test('S6-v3. isPositiveInteger', () => {
  for (const ok of [1, 42, 1000000]) assert.equal(V.isPositiveInteger(ok), true);
  for (const bad of [0, -1, 1.5, NaN, Infinity, '5', null, undefined, {}]) assert.equal(V.isPositiveInteger(bad), false);
});

// 4. isFiniteNumber
test('S6-v4. isFiniteNumber', () => {
  for (const ok of [0, -3, 3.14, 1e9]) assert.equal(V.isFiniteNumber(ok), true);
  for (const bad of [NaN, Infinity, -Infinity, '3', null, undefined]) assert.equal(V.isFiniteNumber(bad), false);
});

// 5. isAllowedEnum
test('S6-v5. isAllowedEnum', () => {
  assert.equal(V.isAllowedEnum('a', ['a', 'b']), true);
  assert.equal(V.isAllowedEnum('c', ['a', 'b']), false);
  assert.equal(V.isAllowedEnum('a', new Set(['a'])), true);
  assert.equal(V.isAllowedEnum('a', 'not-a-list'), false);
  assert.equal(V.isAllowedEnum('a', null), false);
});

// 6 + 7 + 8. sanitizeFilename — sanitizes, rejects traversal, strips null bytes.
test('S6-v6/7/8. sanitizeFilename strips paths/traversal/null bytes', () => {
  assert.equal(V.sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(V.sanitizeFilename('..\\..\\win.ini'), 'win.ini');
  assert.equal(V.sanitizeFilename(`bad${NUL}name.txt`), 'badname.txt');
  assert.ok(!V.sanitizeFilename('a/b/c').includes('/'), 'no separators remain');
  assert.equal(V.sanitizeFilename('my file!.PDF'), 'my_file_.PDF');
  assert.equal(V.sanitizeFilename('....'), '');
  for (const bad of [null, undefined, 5, {}]) assert.equal(V.sanitizeFilename(bad), '');
});

// 9. safeString length cap + control-char strip
test('S6-v9. safeString caps length and strips control chars', () => {
  assert.equal(V.safeString('hello', 3), 'hel');
  assert.equal(V.safeString(`a${NUL}b`), 'ab');
  assert.equal(V.safeString('  trim  ', 100), 'trim');
  assert.equal(V.safeString(null), '');
  assert.equal(V.safeString(12345, 3), '123'); // non-string coerced safely
  assert.ok(V.safeString('x'.repeat(5000)).length <= 1000, 'default cap applied');
});

// 10. validateEmail
test('S6-v10. validateEmail', () => {
  for (const ok of ['a@b.co', 'first.last@example.com']) assert.equal(V.validateEmail(ok), true);
  for (const bad of ['nope', 'a@b', 'a b@c.com', `a@b.co${NUL}`, 'x'.repeat(260) + '@a.co', 5, null]) assert.equal(V.validateEmail(bad), false, String(bad));
});

// 11. validateDate
test('S6-v11. validateDate', () => {
  for (const ok of ['2026-07-04', '2000-02-29']) assert.equal(V.validateDate(ok), true);
  for (const bad of ['2026-13-01', '2026-02-30', '2026-7-4', '07/04/2026', '2001-02-29', '', 5, null]) assert.equal(V.validateDate(bad), false, String(bad));
});

// 12. malformed input never throws (fuzz every export)
test('S6-v12. no helper throws on malformed input', () => {
  const inputs = [undefined, null, NaN, Infinity, {}, [], true, Symbol('x'), 0, '', `${NUL}`, () => {}];
  for (const fn of ['isNonEmptyString', 'isSafeId', 'isPositiveInteger', 'isFiniteNumber', 'sanitizeFilename', 'safeString', 'validateEmail', 'validateDate']) {
    for (const i of inputs) assert.doesNotThrow(() => V[fn](i), `${fn}(${String(i)})`);
  }
  for (const i of inputs) assert.doesNotThrow(() => V.isAllowedEnum(i, i));
});
