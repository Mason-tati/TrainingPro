// WP-08 · L2.5 — Enterprise log schema validator tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateLogRecord, SCHEMA_VERSION } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

function base(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    timestamp: '2026-01-01T00:00:00.000Z',
    level: 'INFO',
    event: 'test.event',
    message: 'hi',
    module: 'System',
    tenantId: null,
    requestId: null,
    actor: 'anonymous',
    environment: 'test',
    version: '1.0.0',
    build: 'dev',
    host: 'host',
    pid: 1,
    metadata: {},
    ...overrides,
  };
}

// 1
test('1. a valid record passes', () => {
  const r = validateLogRecord(base());
  assert.equal(r.valid, true, r.errors.join(','));
});

// 2
test('2. missing message is normalized to empty string', () => {
  const rec = base(); delete rec.message;
  const r = validateLogRecord(rec);
  assert.equal(r.valid, true);
  assert.equal(r.record.message, '');
});

// 3
test('3. missing metadata is normalized to {}', () => {
  const rec = base(); delete rec.metadata;
  const r = validateLogRecord(rec);
  assert.equal(r.valid, true);
  assert.deepEqual(r.record.metadata, {});
});

// 4
test('4. invalid metadata (null/array/primitive) normalized to {}', () => {
  for (const bad of [null, [], 'x', 5]) {
    const r = validateLogRecord(base({ metadata: bad }));
    assert.deepEqual(r.record.metadata, {}, `metadata ${JSON.stringify(bad)} → {}`);
  }
});

// 5
test('5. invalid level is rejected', () => {
  const r = validateLogRecord(base({ level: 'TRACE' }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('level')));
});

// 6
test('6. unknown module is rejected', () => {
  const r = validateLogRecord(base({ module: 'Nope' }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('module')));
});

// 7
test('7. unsupported schemaVersion is rejected; missing is rejected', () => {
  assert.equal(validateLogRecord(base({ schemaVersion: 2 })).valid, false);
  const rec = base(); delete rec.schemaVersion;
  assert.equal(validateLogRecord(rec).valid, false);
});

// 8
test('8. invalid timestamp is rejected', () => {
  for (const bad of ['not-a-date', '2026-01-01 00:00:00', '2026-13-01T00:00:00Z', 12345]) {
    assert.equal(validateLogRecord(base({ timestamp: bad })).valid, false, `${bad} rejected`);
  }
  assert.equal(validateLogRecord(base({ timestamp: '2026-01-01T00:00:00Z' })).valid, true, 'no-millis ISO ok');
});

// 9
test('9. invalid requestId is rejected (empty string / non-string)', () => {
  assert.equal(validateLogRecord(base({ requestId: '' })).valid, false);
  assert.equal(validateLogRecord(base({ requestId: 123 })).valid, false);
  assert.equal(validateLogRecord(base({ requestId: 'abc' })).valid, true);
  assert.equal(validateLogRecord(base({ requestId: null })).valid, true);
});

// 10
test('10. invalid tenantId is rejected (non-string / non-null)', () => {
  assert.equal(validateLogRecord(base({ tenantId: 5 })).valid, false);
  assert.equal(validateLogRecord(base({ tenantId: {} })).valid, false);
  assert.equal(validateLogRecord(base({ tenantId: 'tenant-1' })).valid, true);
  assert.equal(validateLogRecord(base({ tenantId: null })).valid, true);
});

// 11
test('11. invalid actor is normalized to anonymous', () => {
  const r = validateLogRecord(base({ actor: 42 }));
  assert.equal(r.record.actor, 'anonymous');
});

// 12
test('12. empty message is valid', () => {
  assert.equal(validateLogRecord(base({ message: '' })).valid, true);
});

// fail-safe
test('validator never throws on garbage input', () => {
  for (const bad of [null, undefined, 5, 'str', []]) {
    const r = validateLogRecord(bad);
    assert.equal(r.valid, false);
    assert.equal(typeof r.record, 'object');
    assert.deepEqual(r.record.metadata, {});
  }
});
