// WP-13 · S4 — Password policy (advisory) tests.
// Pure evaluation: proves criteria, common-password rejection, safe handling of
// non-string input, and that issue strings never echo the password value.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { evaluatePassword, MIN_LENGTH } = require(path.join(__dirname, '..', '..', 'lib', 'security', 'password-policy.js'));

// 1. A strong password passes with a full score and no issues.
test('S4-1. strong password passes', () => {
  const r = evaluatePassword('Str0ng!Passw0rd#2026');
  assert.equal(r.valid, true);
  assert.equal(r.score, 5);
  assert.deepEqual(r.issues, []);
});

// 2. Too-short password fails on length.
test('S4-2. short password fails', () => {
  const r = evaluatePassword('Aa1!');
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.includes(`${MIN_LENGTH} characters`)), 'length issue reported');
});

// 3-6. Each missing composition class is reported.
test('S4-3. missing lowercase fails', () => {
  const r = evaluatePassword('ABCDEFGH1234!@');
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.toLowerCase().includes('lowercase')));
});
test('S4-4. missing uppercase fails', () => {
  const r = evaluatePassword('abcdefgh1234!@');
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.toLowerCase().includes('uppercase')));
});
test('S4-5. missing number fails', () => {
  const r = evaluatePassword('Abcdefghij!@#');
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.toLowerCase().includes('number')));
});
test('S4-6. missing symbol fails', () => {
  const r = evaluatePassword('Abcdefghij1234');
  assert.equal(r.valid, false);
  assert.ok(r.issues.some((i) => i.toLowerCase().includes('symbol')));
});

// 7. Common/example passwords always fail.
test('S4-7. common passwords fail', () => {
  for (const pw of ['password', 'password123', 'admin', 'admin123', 'qwerty', 'welcome', 'letmein', 'ADMIN123']) {
    const r = evaluatePassword(pw);
    assert.equal(r.valid, false, `${pw} rejected`);
    assert.ok(r.issues.some((i) => i.toLowerCase().includes('common')), `${pw} flagged common`);
  }
});

// 8. Non-string input fails safely (no throw).
test('S4-8. non-string input fails safely', () => {
  for (const bad of [undefined, null, 42, {}, [], true, Symbol('x')]) {
    let r;
    assert.doesNotThrow(() => { r = evaluatePassword(bad); });
    assert.equal(r.valid, false);
    assert.equal(r.score, 0);
    assert.ok(Array.isArray(r.issues) && r.issues.length >= 1);
  }
});

// 9. Issues array is stable and descriptive (strings; deterministic for same input).
test('S4-9. issues array is stable and descriptive', () => {
  const a = evaluatePassword('short');
  const b = evaluatePassword('short');
  assert.deepEqual(a.issues, b.issues, 'deterministic for identical input');
  for (const i of a.issues) { assert.equal(typeof i, 'string'); assert.ok(i.length > 0); }
});

// 10. The password value never appears inside any issue string.
test('S4-10. no password value leaks into issue strings', () => {
  const secret = 'MySup3rSecretValue';
  const r = evaluatePassword(secret); // missing symbol → has issues
  assert.ok(r.issues.length >= 1);
  for (const i of r.issues) assert.ok(!i.includes(secret), 'issue string does not echo the password');
  // also for a common password: the value must not be echoed
  const c = evaluatePassword('admin123');
  for (const i of c.issues) assert.ok(!i.includes('admin123'), 'common-password issue does not echo the value');
});
