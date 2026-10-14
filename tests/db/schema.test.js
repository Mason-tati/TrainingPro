// WP-07 · C6 — Database layer + migration/bootstrap tests
// All tests run against an isolated temporary DATABASE_PATH under tests/.tmp/.
// The production/development database (database/traintrack.db) is never touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { freshDb, cleanupAll, initReady, DEFAULT_DB } = require('../helpers/db');

// Baseline production DB fingerprint to prove it is never modified by this suite.
let prodBefore = null;
before(() => {
  prodBefore = fs.existsSync(DEFAULT_DB) ? fs.statSync(DEFAULT_DB) : null;
});
after(async () => {
  await cleanupAll();
});

// 1. initDb creates the schema in a temporary database.
test('1. initDb creates schema in a temporary database', async () => {
  const { mod, dbPath } = freshDb();
  await initReady(mod);
  assert.ok(fs.existsSync(dbPath), 'temp DB file created');
  assert.equal(mod.DB_PATH, dbPath, 'db bound to the temp path, not production');
  const tables = await mod.dbAll("SELECT name FROM sqlite_master WHERE type='table'");
  assert.ok(tables.length > 0, 'schema objects created');
});

// 8. Required baseline + migration tables exist.
test('8. required baseline and migration tables exist', async () => {
  const { mod } = freshDb();
  await initReady(mod);
  const rows = await mod.dbAll("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set(rows.map((r) => r.name));
  const required = [
    // schema.sql baseline
    'tblStaff', 'tblPswd', 'tblCerts', 'tblClass', 'tblRegister', 'tblDept', 'tblJobs', 'tblConfig',
    'tblFormTemplate', 'tblAudit',
    // migration-created
    'tblCompetency', 'tblEquipmentType', 'tblEquipment', 'tblLeaveType', 'tblShiftType',
    'tblOnboarding', 'tblOnboardingDoc', 'tblAttendance', 'tblDisciplinary',
  ];
  for (const t of required) assert.ok(names.has(t), `table ${t} exists`);
});

// 6. PRAGMA foreign_keys is enabled on the connection.
test('6. PRAGMA foreign_keys is ON', async () => {
  const { mod } = freshDb();
  await initReady(mod);
  const row = await mod.dbGet('PRAGMA foreign_keys');
  assert.equal(row.foreign_keys, 1);
});

// 3/4/5. dbRun inserts; dbGet reads one row; dbAll reads many.
test('3/4/5. dbRun / dbGet / dbAll behave correctly', async () => {
  const { mod } = freshDb();
  await initReady(mod);

  const ins = await mod.dbRun(
    "INSERT INTO tblLeaveType (Name, Color, Paid, DefaultDays, Description) VALUES (?,?,?,?,?)",
    ['C6 Custom Leave', '#123456', 1, 4, 'unit-test row']
  );
  assert.ok(ins.lastID > 0, 'dbRun returns lastID');
  assert.equal(ins.changes, 1, 'dbRun returns changes count');

  const one = await mod.dbGet('SELECT * FROM tblLeaveType WHERE LeaveTypeID=?', [ins.lastID]);
  assert.equal(one.Name, 'C6 Custom Leave');
  assert.equal(one.DefaultDays, 4);

  const upd = await mod.dbRun('UPDATE tblLeaveType SET DefaultDays=? WHERE LeaveTypeID=?', [9, ins.lastID]);
  assert.equal(upd.changes, 1, 'update affects one row');
  const after = await mod.dbGet('SELECT DefaultDays FROM tblLeaveType WHERE LeaveTypeID=?', [ins.lastID]);
  assert.equal(after.DefaultDays, 9);

  const many = await mod.dbAll('SELECT LeaveTypeID FROM tblLeaveType');
  assert.ok(Array.isArray(many) && many.length >= 1, 'dbAll returns rows');
});

// 7. A representative foreign-key constraint is enforced.
test('7. foreign-key constraint is enforced (tblOnboardingDoc → tblOnboarding)', async () => {
  const { mod } = freshDb();
  await initReady(mod);
  await assert.rejects(
    () => mod.dbRun(
      'INSERT INTO tblOnboardingDoc (CandidateID, DocType, FileName, StoredName) VALUES (?,?,?,?)',
      [999999, 'cv', 'x.pdf', 'stored-x.pdf']
    ),
    /FOREIGN KEY constraint failed/,
    'inserting a child with no parent is rejected'
  );
  // Positive path: a valid parent allows the child insert.
  const cand = await mod.dbRun(
    'INSERT INTO tblOnboarding (FirstName, LastName) VALUES (?,?)', ['Test', 'Candidate']
  );
  const okChild = await mod.dbRun(
    'INSERT INTO tblOnboardingDoc (CandidateID, DocType, FileName, StoredName) VALUES (?,?,?,?)',
    [cand.lastID, 'cv', 'x.pdf', 'stored-x.pdf']
  );
  assert.ok(okChild.lastID > 0, 'valid FK child insert succeeds');
});

// 9. Seed/reference data exists and is correct on a fresh temp DB.
test('9. seed/reference data is present on a fresh database', async () => {
  const { mod } = freshDb();
  await initReady(mod);

  const eqTypes = await mod.dbAll('SELECT Name FROM tblEquipmentType');
  assert.equal(eqTypes.length, 8, '8 equipment types seeded');
  assert.ok(eqTypes.some((r) => r.Name === 'Caterpillar 745C'));

  const leave = await mod.dbAll('SELECT Name FROM tblLeaveType');
  assert.equal(leave.length, 7, '7 leave types seeded');
  assert.ok(leave.some((r) => r.Name === 'Annual Leave'));

  const shifts = await mod.dbAll('SELECT Label, IsOff FROM tblShiftType');
  assert.equal(shifts.length, 5, '5 shift types seeded');
  const off = shifts.find((s) => s.Label === 'Off');
  assert.ok(off && off.IsOff === 1, 'Off shift flagged IsOff=1');

  const cats = await mod.dbAll('SELECT COUNT(*) AS c FROM tblTrainMatCat');
  assert.equal(cats[0].c, 3, '3 training-material categories seeded');
});

// 2. initDb is idempotent — running it again must not duplicate seed data.
test('2. initDb is idempotent (no duplicate seed data on re-run)', async () => {
  const { mod } = freshDb();
  await initReady(mod);
  const before = {
    eq: (await mod.dbGet('SELECT COUNT(*) c FROM tblEquipmentType')).c,
    leave: (await mod.dbGet('SELECT COUNT(*) c FROM tblLeaveType')).c,
    shift: (await mod.dbGet('SELECT COUNT(*) c FROM tblShiftType')).c,
    cats: (await mod.dbGet('SELECT COUNT(*) c FROM tblTrainMatCat')).c,
  };
  await initReady(mod); // run migrations/bootstrap again on the same file
  const after = {
    eq: (await mod.dbGet('SELECT COUNT(*) c FROM tblEquipmentType')).c,
    leave: (await mod.dbGet('SELECT COUNT(*) c FROM tblLeaveType')).c,
    shift: (await mod.dbGet('SELECT COUNT(*) c FROM tblShiftType')).c,
    cats: (await mod.dbGet('SELECT COUNT(*) c FROM tblTrainMatCat')).c,
  };
  assert.deepEqual(after, before, 'seed counts unchanged after a second initDb');
});

// 10. Helpers surface errors clearly on invalid SQL (reject, never crash).
test('10. db helpers reject on invalid SQL', async () => {
  const { mod } = freshDb();
  await initReady(mod);
  await assert.rejects(() => mod.dbRun('THIS IS NOT SQL'), /syntax error|SQLITE/i);
  await assert.rejects(() => mod.dbAll('SELECT * FROM table_that_does_not_exist_xyz'), /no such table/i);
  await assert.rejects(() => mod.dbGet('SELECT * FROM another_missing_table_xyz'), /no such table/i);
});

// Safety: getDb throws before initialisation (contract preserved).
test('getDb throws before initialisation', () => {
  const { mod } = freshDb();
  assert.throws(() => mod.getDb(), /not initialized/i);
});

// Production DB must be untouched by the entire suite.
test('production database is never modified by this suite', () => {
  if (!prodBefore) return; // nothing to compare on a machine without the dev DB
  const now = fs.statSync(DEFAULT_DB);
  assert.equal(now.size, prodBefore.size, 'production DB size unchanged');
  assert.equal(now.mtimeMs, prodBefore.mtimeMs, 'production DB mtime unchanged');
});
