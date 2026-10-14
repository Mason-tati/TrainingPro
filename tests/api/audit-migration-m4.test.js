// WP-16 · M4 — High-risk route audit migration tests (isolated temp DB).
// Exercises the migrated HR/medical/disciplinary/onboarding/leave/staff routes,
// proving unchanged responses, shape-compatible tblAudit rows, and that sensitive
// free-text no longer reaches OldValue/NewValue.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

const lastAudit = () => app.db.dbGet('SELECT * FROM tblAudit ORDER BY AuditID DESC LIMIT 1');

// 11-13. Staff (users) — response unchanged; PII digit-run masked; name preserved.
test('M4-11..13. staff: response ok; PII masked in audit', async () => {
  const r = await app.request('POST', '/api/staff', { LastName: 'PIISENTINEL', FirstName: '9998887776', Status: 'Active', FileNum: 'M4-1' });
  assert.equal(r.status, 200, 'same status');
  assert.ok(r.json().StaffID, 'same body shape (StaffID)');
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'tblStaff', 'AuditTable preserved');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction preserved');
  assert.equal(row.AuditRecord, String(r.json().StaffID));
  assert.ok(!row.NewValue.includes('9998887776'), 'PII digit-run masked');
  assert.ok(row.NewValue.includes('[REDACTED]') && row.NewValue.includes('PIISENTINEL'), 'non-sensitive name preserved');
  return r.json().StaffID;
});

// 1-4. Disciplinary — response unchanged; audit written; sensitive value dropped.
test('M4-1..4. disciplinary: response ok; sensitive value dropped', async () => {
  const staff = await app.request('POST', '/api/staff', { LastName: 'Emp', FirstName: 'One', Status: 'Active', FileNum: 'M4-2' });
  const empId = staff.json().StaffID;
  const r = await app.request('POST', '/api/disciplinary', { EmpID: empId, Reason: 'attendance', Severity: 'DISC-SENTINEL-final-written-warning' });
  assert.equal(r.status, 200, 'same status');
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'Disciplinary', 'AuditTable preserved');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction preserved');
  assert.equal(row.AuditField, 'Severity');
  assert.equal(row.NewValue, '[REDACTED]', 'disciplinary free-text dropped');
  assert.ok(!JSON.stringify(row).includes('DISC-SENTINEL'), 'sentinel absent');
});

// 5-7. Onboarding — response unchanged; audit written; medical sentinel absent.
test('M4-5..7. onboarding: response ok; medical/free-text dropped', async () => {
  const r = await app.request('POST', '/api/onboarding', { FirstName: 'Cand', LastName: 'MED-SENTINEL-asthma-condition' });
  assert.ok(r.status === 200 || r.status === 201, `onboarding create responded (${r.status})`);
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'Onboarding', 'AuditTable preserved');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction preserved');
  assert.equal(row.NewValue, '[REDACTED]', 'onboarding free-text dropped');
  assert.ok(!JSON.stringify(row).includes('MED-SENTINEL'), 'medical sentinel absent');
});

// 8-10. Leave — response unchanged; audit written; medical/PII sentinel absent.
test('M4-8..10. leave: response ok; sensitive value dropped', async () => {
  const r = await app.request('POST', '/api/leave/types', { Name: 'LEAVE-MED-SENTINEL-doctor-note' });
  assert.equal(r.status, 200, 'same status');
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'LeaveType', 'AuditTable preserved');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction preserved');
  assert.equal(row.NewValue, '[REDACTED]', 'leave free-text dropped');
  assert.ok(!JSON.stringify(row).includes('LEAVE-MED-SENTINEL'), 'sentinel absent');
});

// 14. All migrated high-risk files no longer import lib/audit.
test('M4-14. migrated high-risk routes do not import lib/audit', () => {
  for (const f of ['disciplinary', 'onboarding', 'leave', 'staff']) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', `${f}.js`), 'utf8');
    assert.ok(!/require\(['"]\.\.\/lib\/audit['"]\)/.test(src), `${f}.js must not import lib/audit`);
    assert.ok(src.includes('governance/audit-adapter'), `${f}.js imports the adapter`);
    assert.ok(!src.includes('logAudit('), `${f}.js has no logAudit calls`);
  }
});

// 15. The former medium-risk deferral set is now migrated (WP-16 M5) — see M5 tests.
test('M4-15. former medium-risk routes are now migrated to the adapter', () => {
  for (const f of ['competency', 'forms', 'content', 'exams', 'powerpoints', 'files', 'translator', 'knowledgebase']) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', `${f}.js`), 'utf8');
    assert.ok(!/require\(['"]\.\.\/lib\/audit['"]\)/.test(src), `${f}.js no longer imports lib/audit`);
    assert.ok(!src.includes('logAudit('), `${f}.js no longer calls logAudit`);
    assert.ok(src.includes('governance/audit-adapter'), `${f}.js imports the adapter`);
  }
});

// 16. Isolated temp DB — production DB path never used.
test('M4-16. isolated temp DB', () => {
  assert.ok(app.dbPath.includes('.tmp') && !app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});
