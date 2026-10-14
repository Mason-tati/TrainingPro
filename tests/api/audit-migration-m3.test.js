// WP-16 · M3 — Low-risk route audit migration tests (isolated temp DB).
// Exercises migrated routes end-to-end, proving unchanged responses and that the
// governance adapter writes shape-compatible, sanitized tblAudit rows. Also
// asserts migrated files no longer import lib/audit and high-risk routes still do.
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

// 1-7. Migrated create route: same response; audit row shape preserved; value kept.
test('M3-1..7. equipment type create: response + audit row preserved', async () => {
  const r = await app.request('POST', '/api/equipment/types', { Name: 'M3-EquipType' });
  assert.equal(r.status, 200, 'same status');
  assert.equal(r.json().success, true, 'same body shape');
  assert.ok(r.json().EquipTypeID, 'id returned');
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'EquipmentType', 'AuditTable unchanged (3)');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction unchanged (4)');
  assert.equal(row.AuditRecord, String(r.json().EquipTypeID), 'AuditRecord unchanged (5)');
  assert.equal(row.AuditField, null, 'AuditField unchanged (6)');
  assert.equal(row.NewValue, 'M3-EquipType', 'non-sensitive NewValue preserved (7)');
  assert.equal(row.AuditUser, 'admin', 'actor from session');
});

// 6 + 7 + 8. Update route: AuditField + old/new preserved; secret masked.
test('M3-update/8. update audit: field + values; secret masked', async () => {
  const created = await app.request('POST', '/api/equipment/types', { Name: 'M3-Base' });
  const id = created.json().EquipTypeID;
  // normal update — AuditField='Name', old/new preserved
  const up = await app.request('PUT', `/api/equipment/types/${id}`, { Name: 'M3-Renamed' });
  assert.equal(up.status, 200);
  let row = await lastAudit();
  assert.equal(row.AuditField, 'Name', 'AuditField preserved');
  assert.equal(row.OldValue, 'M3-Base', 'OldValue preserved');
  assert.equal(row.NewValue, 'M3-Renamed', 'NewValue preserved');
  // secret-bearing value is masked in the audit row
  const created2 = await app.request('POST', '/api/equipment/types', { Name: 'M3-Sec' });
  const id2 = created2.json().EquipTypeID;
  await app.request('PUT', `/api/equipment/types/${id2}`, { Name: 'key sk-SECRET12345678' });
  row = await lastAudit();
  assert.ok(!row.NewValue.includes('sk-SECRET12345678') && row.NewValue.includes('[REDACTED]'), 'secret masked in audit');
});

// 2. A second migrated route (classes) still writes its audit row.
test('M3-classes. class create writes tblClass audit row', async () => {
  const r = await app.request('POST', '/api/classes', { ClassName: 'M3-Class', ClassDate: '2026-08-01' });
  assert.ok(r.status === 200 || r.status === 201, `class create responded (${r.status})`);
  if (r.status < 300) {
    const row = await lastAudit();
    assert.equal(row.AuditTable, 'tblClass');
    assert.equal(row.AuditAction, 'CREATE');
    assert.equal(row.NewValue, 'M3-Class');
  }
});

// 9. Migrated files no longer import lib/audit.
test('M3-9. migrated routes do not import lib/audit', () => {
  for (const f of ['classes', 'trainers', 'roster', 'register', 'assignment', 'attendance', 'equipment']) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', `${f}.js`), 'utf8');
    assert.ok(!/require\(['"]\.\.\/lib\/audit['"]\)/.test(src), `${f}.js must not import lib/audit`);
    assert.ok(src.includes('governance/audit-adapter'), `${f}.js imports the adapter`);
    assert.ok(!src.includes('logAudit('), `${f}.js has no logAudit calls`);
  }
});

// 10. The former medium-risk deferral set is now migrated (WP-16 M5) — see M5 tests.
test('M3-10. former medium-risk routes are now migrated to the adapter', () => {
  for (const f of ['competency', 'forms', 'content', 'exams', 'powerpoints', 'files', 'translator', 'knowledgebase']) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', `${f}.js`), 'utf8');
    assert.ok(!/require\(['"]\.\.\/lib\/audit['"]\)/.test(src), `${f}.js no longer imports lib/audit`);
    assert.ok(!src.includes('logAudit('), `${f}.js no longer calls logAudit`);
    assert.ok(src.includes('governance/audit-adapter'), `${f}.js imports the adapter`);
  }
});

// 11. Isolated temp DB — production DB path never used.
test('M3-11. isolated temp DB', () => {
  assert.ok(app.dbPath.includes('.tmp') && !app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});
