// WP-07 · C1 — Test harness smoke test
// Proves the Node built-in test runner and assertion library work.
// This test intentionally exercises NO application code — it only verifies
// that the enterprise testing framework itself is wired up correctly.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('node:test runner executes', () => {
  assert.ok(true, 'the test body ran');
});

test('assertions evaluate truthy and falsy correctly', () => {
  assert.equal(1 + 1, 2);
  assert.notEqual(1, 2);
  assert.deepEqual({ a: 1 }, { a: 1 });
});

test('async tests are awaited', async () => {
  const value = await Promise.resolve('ready');
  assert.equal(value, 'ready');
});
