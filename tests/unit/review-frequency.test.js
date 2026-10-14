// WP-17 · D1 — Review-frequency registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const R = require(path.join(__dirname, '..', '..', 'lib', 'document', 'review-frequency.js'));

const EXPECTED_MONTHS = { NONE: 0, MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12, TWO_YEAR: 24, THREE_YEAR: 36, FIVE_YEAR: 60, CUSTOM: null };
const EXPECTED = Object.keys(EXPECTED_MONTHS);

test('RF-1. registry has all frequencies with the full shape + correct defaultMonths', () => {
  assert.deepEqual([...R.REVIEW_FREQUENCY_IDS].sort(), [...EXPECTED].sort());
  for (const id of R.REVIEW_FREQUENCY_IDS) {
    const f = R.REVIEW_FREQUENCIES[id];
    assert.equal(f.id, id);
    assert.equal(typeof f.displayName, 'string');
    assert.equal(typeof f.description, 'string');
    assert.equal(f.defaultMonths, EXPECTED_MONTHS[id], `${id} defaultMonths`);
    assert.ok(f.defaultMonths === null || typeof f.defaultMonths === 'number');
  }
});

test('RF-2. unique ids + monotonic month intervals (excluding NONE/CUSTOM)', () => {
  assert.equal(R.REVIEW_FREQUENCY_IDS.length, new Set(R.REVIEW_FREQUENCY_IDS).size);
  const ordered = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'TWO_YEAR', 'THREE_YEAR', 'FIVE_YEAR'];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(R.REVIEW_FREQUENCIES[ordered[i]].defaultMonths > R.REVIEW_FREQUENCIES[ordered[i - 1]].defaultMonths, `${ordered[i]} > ${ordered[i - 1]}`);
  }
});

test('RF-3. deep frozen / immutable', () => {
  assert.ok(Object.isFrozen(R.REVIEW_FREQUENCIES) && Object.isFrozen(R.REVIEW_FREQUENCY_IDS));
  for (const id of R.REVIEW_FREQUENCY_IDS) assert.ok(Object.isFrozen(R.REVIEW_FREQUENCIES[id]));
  try { R.REVIEW_FREQUENCIES.HACK = {}; } catch { /* ok */ }
  try { R.REVIEW_FREQUENCIES.YEARLY.defaultMonths = 999; } catch { /* ok */ }
  assert.equal(R.REVIEW_FREQUENCIES.HACK, undefined);
  assert.equal(R.REVIEW_FREQUENCIES.YEARLY.defaultMonths, 12);
});

test('RF-4. getReviewFrequency: known + unknown → safe default; copy-on-read', () => {
  assert.equal(R.getReviewFrequency('YEARLY').defaultMonths, 12);
  const d = R.getReviewFrequency('NOPE');
  assert.equal(d.id, 'unknown');
  assert.equal(d.defaultMonths, 0, 'unknown → no scheduled review');
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(R.getReviewFrequency(bad).id, 'unknown');
  const c = R.getReviewFrequency('YEARLY');
  c.defaultMonths = 1;
  assert.equal(R.REVIEW_FREQUENCIES.YEARLY.defaultMonths, 12);
  assert.notEqual(c, R.REVIEW_FREQUENCIES.YEARLY);
});

test('RF-5. listReviewFrequencies: fresh array + copies; never throws', () => {
  const a = R.listReviewFrequencies();
  const b = R.listReviewFrequencies();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].defaultMonths = -1;
  assert.equal(R.listReviewFrequencies().length, EXPECTED.length);
  assert.equal(R.getReviewFrequency('NONE').defaultMonths, 0);
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => R.getReviewFrequency(bad));
});
