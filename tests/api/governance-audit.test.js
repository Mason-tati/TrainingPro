// WP-15 · D2 — Business audit helper API tests (isolated temp DB).
// Exercises the real write path against a temporary tblAudit; proves sanitized
// writes, unknown/malformed rejections, fail-open behaviour, and that no
// production code imports the helper.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
let app;
let audit;
before(async () => {
  app = await startTestApp();
  audit = require(path.join(ROOT, 'lib', 'governance', 'audit.js')); // app instance → app's temp DB
});
after(async () => { if (app) await app.close(); });

const countAudit = async () => (await app.db.dbGet('SELECT COUNT(*) AS n FROM tblAudit')).n;

// 1 + 2. Valid audit writes exactly one row matching the tblAudit schema.
test('D2-api-1/2. valid audit writes one schema-correct row', async () => {
  const before = await countAudit();
  const r = await audit.recordAuditEvent({ entity: 'users', action: 'update', recordId: 7, field: 'Status', oldValue: 'Active', newValue: 'Inactive', actor: 'tester' });
  assert.deepEqual({ ok: r.ok, written: r.written, reason: r.reason }, { ok: true, written: true, reason: 'written' });
  assert.equal(await countAudit(), before + 1, 'exactly one row added');
  const row = await app.db.dbGet('SELECT * FROM tblAudit ORDER BY AuditID DESC LIMIT 1');
  for (const col of ['AuditID', 'AuditDate', 'AuditUser', 'AuditTable', 'AuditAction', 'AuditRecord', 'AuditField', 'OldValue', 'NewValue']) {
    assert.ok(col in row, `column ${col} present`);
  }
  assert.equal(row.AuditUser, 'tester');
  assert.equal(row.AuditTable, 'users');
  assert.equal(row.AuditAction, 'update');
  assert.equal(row.AuditRecord, '7');
  assert.equal(row.AuditField, 'Status');
  assert.equal(row.OldValue, 'Active');
  assert.equal(row.NewValue, 'Inactive');
  assert.ok(row.AuditDate && /^\d{4}-\d{2}-\d{2}/.test(row.AuditDate), 'AuditDate set by DB');
});

// 3 + 4. Sanitized values are stored; forbidden sentinels are absent.
test('D2-api-3/4. sanitized write; no forbidden sentinels stored', async () => {
  await audit.recordAuditEvent({
    entity: 'documents', action: 'update', recordId: 'D-1',
    oldValue: 'key sk-SENT12345678 acct 987654321',
    newValue: 'Bearer TOKENSENT connect.sid=SESSIONSENT',
    actor: 'auditor',
  });
  const row = await app.db.dbGet('SELECT * FROM tblAudit ORDER BY AuditID DESC LIMIT 1');
  const s = JSON.stringify(row);
  for (const leak of ['sk-SENT12345678', '987654321', 'TOKENSENT', 'SESSIONSENT']) {
    assert.ok(!s.includes(leak), `forbidden sentinel absent: ${leak}`);
  }
  assert.ok(row.OldValue.includes('[REDACTED]'), 'value masked');
});

// 5 + 6 + 7. Unknown entity/action and malformed input write nothing.
test('D2-api-5/6/7. unknown/malformed writes nothing', async () => {
  const before = await countAudit();
  assert.equal((await audit.recordAuditEvent({ entity: 'nope', action: 'update' })).written, false);
  assert.equal((await audit.recordAuditEvent({ entity: 'users', action: 'nope' })).written, false);
  assert.equal((await audit.recordAuditEvent(null)).written, false);
  assert.equal((await audit.recordAuditEvent({})).written, false);
  assert.equal(await countAudit(), before, 'no rows written');
});

// 8. Helper fails open when the DB write throws (write_failed, no throw, no row).
test('D2-api-8. helper fails open on a DB error', async () => {
  const before = await countAudit();
  const orig = app.db.dbRun;
  app.db.dbRun = async () => { throw new Error('db boom'); };
  try {
    let r;
    await assert.doesNotReject(async () => { r = await audit.recordAuditEvent({ entity: 'users', action: 'update', recordId: 1 }); });
    assert.equal(r.ok, true);
    assert.equal(r.written, false);
    assert.equal(r.reason, 'write_failed');
  } finally { app.db.dbRun = orig; }
  assert.equal(await countAudit(), before, 'no row written on failure');
});

// 9. Isolated temp DB — production DB path is never used.
test('D2-api-9. runs against an isolated temp DB', () => {
  assert.ok(app.dbPath.includes('.tmp'));
  assert.ok(!app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});

// No runtime adoption: server.js, routes/**, and lib/audit.js must not import it.
test('D2-api-noimport. no production importer of governance/audit', () => {
  const files = [path.join(ROOT, 'server.js'), path.join(ROOT, 'lib', 'audit.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) files.push(path.join(routesDir, f));
  for (const f of files) {
    // the D2 helper (governance/audit) — NOT the M3 adapter (governance/audit-adapter)
    assert.ok(!/governance\/audit['"]/.test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)} must not import governance/audit`);
  }
});
