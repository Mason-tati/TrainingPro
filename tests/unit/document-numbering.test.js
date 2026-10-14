// WP-17 · D1 — Document-numbering helper tests (pure, total, never-throw).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const N = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-numbering.js'));

test('DN-1. normalizeDocumentNumber: canonicalises case/separators; drops junk; trims', () => {
  assert.equal(N.normalizeDocumentNumber(' syd_ops sop-000001 '), 'SYD-OPS-SOP-000001');
  assert.equal(N.normalizeDocumentNumber('SYD--OPS___SOP  000001'), 'SYD-OPS-SOP-000001');
  assert.equal(N.normalizeDocumentNumber('a/b*c#1'), 'ABC1');
  assert.equal(N.normalizeDocumentNumber('---trim---'), 'TRIM');
});

test('DN-2. normalizeDocumentNumber: coercion across input types; never throws; unknown → ""', () => {
  assert.equal(N.normalizeDocumentNumber(123456), '123456');   // finite number
  assert.equal(N.normalizeDocumentNumber(true), 'TRUE');       // boolean
  assert.equal(N.normalizeDocumentNumber(NaN), '');            // non-finite number
  assert.equal(N.normalizeDocumentNumber(Infinity), '');       // non-finite number
  for (const bad of [null, undefined, {}, [], Symbol('x'), () => {}, 10n]) {
    assert.doesNotThrow(() => N.normalizeDocumentNumber(bad));
    assert.equal(N.normalizeDocumentNumber(bad), '');
  }
});

test('DN-3. isValidDocumentNumber: strict canonical form; never throws', () => {
  assert.equal(N.isValidDocumentNumber('SYD-OPS-SOP-000001'), true);
  assert.equal(N.isValidDocumentNumber('SYD-OPS-SOP-1234567'), true, '>=6 digits ok');
  assert.equal(N.isValidDocumentNumber('  SYD-OPS-SOP-000001  '), true, 'trimmed');
  assert.equal(N.isValidDocumentNumber('SYD-OPS-SOP-00001'), false, '<6 digits');
  assert.equal(N.isValidDocumentNumber('syd-ops-sop-000001'), false, 'lowercase');
  assert.equal(N.isValidDocumentNumber('SYD-OPS-000001'), false, 'missing segment');
  assert.equal(N.isValidDocumentNumber('SYD-OPS-SOP-ABC123'), false, 'non-numeric sequence');
  for (const bad of [null, undefined, 5, {}, [], Symbol('x'), NaN]) {
    assert.doesNotThrow(() => N.isValidDocumentNumber(bad));
    assert.equal(N.isValidDocumentNumber(bad), false);
  }
});

test('DN-4. buildDocumentNumber: assembles + pads; result always valid', () => {
  assert.equal(N.buildDocumentNumber({ site: 'SYD', dept: 'OPS', type: 'SOP', sequence: 1 }), 'SYD-OPS-SOP-000001');
  assert.equal(N.buildDocumentNumber({ site: 'syd', dept: 'ops', type: 'sop', sequence: 42 }), 'SYD-OPS-SOP-000042');
  assert.equal(N.buildDocumentNumber({ site: 'S Y-D', dept: 'o_p*s', type: 'sop', sequence: '000123' }), 'SYD-OPS-SOP-000123');
  assert.equal(N.buildDocumentNumber({ site: 'A', dept: 'B', type: 'C', sequence: 1234567 }), 'A-B-C-1234567', '>6 digits kept');
  assert.ok(N.isValidDocumentNumber(N.buildDocumentNumber({ site: 'A', dept: 'B', type: 'C', sequence: 9 })));
});

test('DN-5. buildDocumentNumber: unknown/empty segments → "X"; bad sequence → 0; never throws', () => {
  assert.equal(N.buildDocumentNumber({}), 'X-X-X-000000');
  assert.equal(N.buildDocumentNumber({ site: '   ', dept: '@@@', type: '', sequence: -5 }), 'X-X-X-000000', 'empty segs + negative seq');
  assert.equal(N.buildDocumentNumber({ site: 'A', sequence: 'abc' }), 'A-X-X-000000', 'NaN sequence → 0');
  assert.equal(N.buildDocumentNumber({ site: 'A', dept: 'B', type: 'C', sequence: {} }), 'A-B-C-000000', 'object sequence → 0');
  // non-object parts fall back to an empty parts object
  for (const bad of [null, undefined, [1, 2], 5, 'str', Symbol('x'), true]) {
    assert.doesNotThrow(() => N.buildDocumentNumber(bad));
    assert.equal(N.buildDocumentNumber(bad), 'X-X-X-000000', `${String(bad)} → all defaults`);
    assert.ok(N.isValidDocumentNumber(N.buildDocumentNumber(bad)));
  }
});

test('DN-6. purity: inputs are never mutated', () => {
  const parts = Object.freeze({ site: 'SYD', dept: 'OPS', type: 'SOP', sequence: 7 });
  assert.doesNotThrow(() => N.buildDocumentNumber(parts));
  assert.equal(parts.site, 'SYD');
  const arr = [1, 2, 3];
  N.normalizeDocumentNumber(arr);
  assert.deepEqual(arr, [1, 2, 3]);
});
