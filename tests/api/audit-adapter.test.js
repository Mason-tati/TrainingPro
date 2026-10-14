// WP-16 · M2 — Audit adapter API tests (isolated temp DB).
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
let app;
let adapter;
before(async () => {
  app = await startTestApp();
  adapter = require(path.join(ROOT, 'lib', 'governance', 'audit-adapter.js'));
});
after(async () => { if (app) await app.close(); });

const countAudit = async () => (await app.db.dbGet('SELECT COUNT(*) AS n FROM tblAudit')).n;
const lastRow = () => app.db.dbGet('SELECT * FROM tblAudit ORDER BY AuditID DESC LIMIT 1');

// 1 + 3 + 5. Standard legacy call writes one row; legacy strings preserved; value kept.
test('M2-api-1/3/5. standard call → one row, legacy strings preserved', async () => {
  const before = await countAudit();
  const r = await adapter.recordLegacyAudit('tester', 'tblStaff', 'UPDATE', 42, 'LastName', 'Smith', 'Jones');
  assert.equal(r.written, true);
  assert.equal(r.mapping.entity, 'users');
  assert.equal(r.mapping.action, 'update');
  assert.equal(await countAudit(), before + 1);
  const row = await lastRow();
  assert.equal(row.AuditTable, 'tblStaff', 'legacy table string preserved');
  assert.equal(row.AuditAction, 'UPDATE', 'legacy action string preserved');
  assert.equal(row.AuditUser, 'tester');
  assert.equal(row.AuditRecord, '42');
  assert.equal(row.OldValue, 'Smith', 'non-sensitive value preserved');
  assert.equal(row.NewValue, 'Jones');
  assert.ok(/^\d{4}-\d{2}-\d{2}/.test(row.AuditDate), 'AuditDate DB-handled');
});

// 2 + 3. Req-first legacy call writes one row; legacy strings preserved.
test('M2-api-2/3. req-first call → one row', async () => {
  const before = await countAudit();
  const req = { session: { user: { username: 'requser' } } };
  const r = await adapter.recordLegacyAudit(req, 'Assignment', 'CREATE', 5, null, null, 'Course A');
  assert.equal(r.written, true);
  assert.equal(await countAudit(), before + 1);
  const row = await lastRow();
  assert.equal(row.AuditUser, 'requser', 'actor from req.session');
  assert.equal(row.AuditTable, 'Assignment');
  assert.equal(row.AuditAction, 'CREATE');
  assert.equal(row.NewValue, 'Course A');
});

// 4 + 6. Sensitive values are dropped; secrets masked.
test('M2-api-4/6. sensitive dropped; secrets masked', async () => {
  // disciplinary → content-drop
  await adapter.recordLegacyAudit('hr', 'Disciplinary', 'UPDATE', 9, 'Notes', 'prior warning', 'final written warning: absenteeism');
  let row = await lastRow();
  assert.equal(row.AuditTable, 'Disciplinary');
  assert.equal(row.OldValue, '[REDACTED]', 'disciplinary free-text dropped');
  assert.equal(row.NewValue, '[REDACTED]');
  // users (non-content) with an inline secret → masked, non-secret preserved
  await adapter.recordLegacyAudit('admin', 'tblStaff', 'UPDATE', 1, 'Note', 'key sk-SECRET12345678', 'ok');
  row = await lastRow();
  assert.ok(!row.OldValue.includes('sk-SECRET12345678') && row.OldValue.includes('[REDACTED]'));
  assert.equal(row.NewValue, 'ok', 'non-secret preserved');
});

// 7. Unknown input uses safe fallback and still writes (no throw).
test('M2-api-7. unknown table/action → safe fallback write', async () => {
  const before = await countAudit();
  const r = await adapter.recordLegacyAudit('u', 'MysteryTable', 'MYSTERY_ACTION', 3, null, 'v1', 'v2');
  assert.equal(r.written, true);
  assert.equal(r.mapping.entity, 'audit', 'fallback entity');
  assert.equal(r.mapping.action, 'update', 'fallback action');
  const row = await lastRow();
  assert.equal(row.AuditTable, 'MysteryTable', 'original string still preserved');
  assert.equal(row.AuditAction, 'MYSTERY_ACTION');
  assert.equal(row.NewValue, 'v2', 'non-sensitive value preserved via fallback');
  assert.equal(await countAudit(), before + 1);
});

// 8. Helper fails open on a DB error.
test('M2-api-8. fails open on DB error', async () => {
  const before = await countAudit();
  const orig = app.db.dbRun;
  app.db.dbRun = async () => { throw new Error('db boom'); };
  try {
    let r;
    await assert.doesNotReject(async () => { r = await adapter.recordLegacyAudit('u', 'tblStaff', 'UPDATE', 1); });
    assert.equal(r.ok, true);
    assert.equal(r.written, false);
    assert.equal(r.reason, 'write_failed');
  } finally { app.db.dbRun = orig; }
  assert.equal(await countAudit(), before, 'no row on failure');
});

// 9. Isolated temp DB — production DB path never used.
test('M2-api-9. isolated temp DB', () => {
  assert.ok(app.dbPath.includes('.tmp') && !app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});

// 10. Non-scalar recordId/field map to null (no coercion of objects).
test('M2-api-10. non-scalar recordId/field → null', async () => {
  const r = await adapter.recordLegacyAudit('u', 'tblStaff', 'UPDATE', {}, {}, 'v1', 'v2');
  assert.equal(r.written, true);
  const row = await lastRow();
  assert.equal(row.AuditRecord, null, 'object recordId → null');
  assert.equal(row.AuditField, null, 'object field → null');
});
