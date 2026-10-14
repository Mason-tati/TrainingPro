// WP-15 · D2 — Business audit helper unit tests (pure paths; no DB writes).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'lib', 'governance', 'audit.js'));
const requestContext = require(path.join(ROOT, 'lib', 'request-context.js'));

// 1-6. sanitizeAuditMetadata removes forbidden keys + masks secrets.
test('D2-u1..6. sanitize removes forbidden fields / secrets', () => {
  const out = A.sanitizeAuditMetadata({
    keep: 'ok', count: 5, flag: true,
    password: 'PW-SENT', HashPass: '$2a$10$H', hash: 'H', cookie: 'connect.sid=SESS',
    authorization: 'Bearer TOK', jwt: 'eyJa.eyJb.c', token: 'T', sql: 'SELECT 1', body: 'BODY',
    apiKeyInline: 'key sk-abcdEFGH12345 here', bearerInline: 'Bearer abc.def',
  });
  assert.deepEqual(Object.keys(out).sort(), ['apiKeyInline', 'bearerInline', 'count', 'flag', 'keep'].sort());
  assert.equal(out.keep, 'ok'); assert.equal(out.count, 5); assert.equal(out.flag, true);
  for (const k of ['password', 'HashPass', 'hash', 'cookie', 'authorization', 'jwt', 'token', 'sql', 'body']) {
    assert.ok(!(k in out), `${k} dropped`);
  }
  assert.ok(out.apiKeyInline.includes('[REDACTED]') && !out.apiKeyInline.includes('sk-abcdEFGH12345'), 'inline key masked');
  assert.ok(out.bearerInline.includes('[REDACTED]'), 'inline bearer masked');
});

// 7. sanitize caps long strings; drops objects/arrays.
test('D2-u7. caps long strings; drops non-scalars', () => {
  const out = A.sanitizeAuditMetadata({ big: 'x'.repeat(5000), obj: { a: 1 }, arr: [1, 2], fn: () => {} });
  assert.ok(out.big.length <= 256, 'string capped');
  for (const k of ['obj', 'arr', 'fn']) assert.ok(!(k in out), `${k} dropped`);
});

// 8. buildAuditRecord maps to tblAudit fields with sanitized values.
test('D2-u8. buildAuditRecord maps correctly', () => {
  const rec = A.buildAuditRecord({ entity: 'users', action: 'update', recordId: 42, field: 'Status', oldValue: 'A', newValue: 'B', actor: 'alice' });
  assert.deepEqual(Object.keys(rec).sort(), ['AuditAction', 'AuditField', 'AuditRecord', 'AuditTable', 'AuditUser', 'NewValue', 'OldValue'].sort());
  assert.equal(rec.AuditUser, 'alice');
  assert.equal(rec.AuditTable, 'users');
  assert.equal(rec.AuditAction, 'update');
  assert.equal(rec.AuditRecord, '42');
  assert.equal(rec.AuditField, 'Status');
  assert.equal(rec.OldValue, 'A');
  assert.equal(rec.NewValue, 'B');
});

// 9-11. Actor priority: input → request-context → "system".
test('D2-u9..11. actor priority (input > context > system)', () => {
  assert.equal(A.buildAuditRecord({ actor: 'input-user' }).AuditUser, 'input-user');
  requestContext.run({ actor: 'ctx-user', module: 'System' }, () => {
    assert.equal(A.buildAuditRecord({}).AuditUser, 'ctx-user', 'context fallback');
    assert.equal(A.buildAuditRecord({ actor: 'input-user' }).AuditUser, 'input-user', 'input still wins');
  });
  assert.equal(A.buildAuditRecord({}).AuditUser, 'system', 'system fallback outside context');
});

// 12-13. Unknown entity/action → not written (no DB touched).
test('D2-u12/13. unknown entity/action rejected', async () => {
  assert.deepEqual(await A.recordAuditEvent({ entity: 'nope', action: 'update' }), { ok: true, written: false, reason: 'unknown_entity_or_action', record: null });
  assert.deepEqual(await A.recordAuditEvent({ entity: 'users', action: 'nope' }), { ok: true, written: false, reason: 'unknown_entity_or_action', record: null });
  assert.equal((await A.recordAuditEvent({ entity: 'users' })).written, false, 'missing action');
});

// 14. Malformed input never throws (build + record).
test('D2-u14. malformed input never throws', async () => {
  for (const bad of [undefined, null, 5, 'x', [], { entity: {}, action: 5, oldValue: { a: 1 } }, Symbol('x')]) {
    assert.doesNotThrow(() => A.buildAuditRecord(bad));
    assert.doesNotThrow(() => A.sanitizeAuditMetadata(bad));
    const r = await A.recordAuditEvent(bad);
    assert.equal(r.ok, true);
    assert.equal(r.written, false);
  }
});

// 14b. Non-scalar / non-string fields map to null (no coercion of objects/arrays).
test('D2-u14b. non-scalar fields map to null', () => {
  const rec = A.buildAuditRecord({ entity: 5, action: {}, recordId: {}, field: 42, oldValue: [1], newValue: () => {} });
  assert.equal(rec.AuditTable, null, 'non-string entity → null');
  assert.equal(rec.AuditAction, null, 'non-string action → null');
  assert.equal(rec.AuditRecord, null, 'object recordId → null');
  assert.equal(rec.AuditField, null, 'non-string field → null');
  assert.equal(rec.OldValue, null, 'array → null');
  assert.equal(rec.NewValue, null, 'function → null');
});

// 15-16. No mutation of input; fresh objects returned.
test('D2-u15/16. no mutation; fresh objects', () => {
  const input = { entity: 'users', action: 'update', oldValue: 'A', metadata: { keep: 'x' } };
  const snap = JSON.parse(JSON.stringify(input));
  const r1 = A.buildAuditRecord(input);
  const r2 = A.buildAuditRecord(input);
  const m1 = A.sanitizeAuditMetadata(input.metadata);
  assert.deepEqual(input, snap, 'input unchanged');
  assert.notEqual(r1, r2, 'fresh record objects');
  assert.notEqual(m1, input.metadata, 'fresh metadata object');
});

// 17. No sensitive content survives into a built record.
test('D2-u17. no sensitive content preserved', () => {
  const rec = A.buildAuditRecord({
    entity: 'users', action: 'update',
    oldValue: 'key sk-abcdEFGH12345 acct 123456789',
    newValue: 'Bearer abc.def.ghi', field: 'connect.sid=SESSION',
  });
  const s = JSON.stringify(rec);
  for (const leak of ['sk-abcdEFGH12345', '123456789', 'SESSION']) assert.ok(!s.includes(leak), `masked: ${leak}`);
  assert.ok(rec.OldValue.includes('[REDACTED]'));
});

// 18. Exports only the expected functions.
test('D2-u18. exports only expected functions', () => {
  assert.deepEqual(Object.keys(A).sort(), ['buildAuditRecord', 'recordAuditEvent', 'sanitizeAuditMetadata'].sort());
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function');
});

// 19. Registry integration — known entities/actions accepted, unknown rejected.
test('D2-u19. registry integration', async () => {
  const { ENTITY_IDS } = require(path.join(ROOT, 'lib', 'governance', 'entities.js'));
  const { ACTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'actions.js'));
  // a known pair is accepted for building (write path is covered by the API test)
  assert.equal(A.buildAuditRecord({ entity: ENTITY_IDS[0], action: ACTION_IDS[0] }).AuditTable, ENTITY_IDS[0]);
  // an id NOT in the registries is rejected by recordAuditEvent
  assert.equal((await A.recordAuditEvent({ entity: 'definitely_not_an_entity', action: ACTION_IDS[0] })).reason, 'unknown_entity_or_action');
});
