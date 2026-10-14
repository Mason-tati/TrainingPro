// WP-07 · C2 — Database path environment override
// Proves DATABASE_PATH selects the DB file, defaults are preserved when unset,
// temp databases are independent, and the production DB is never touched.
//
// IMPORTANT: cases that must NOT touch the production database assert on the
// RESOLVED PATH ONLY (the additive DB_PATH export) and never call initDb()
// against the default location.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DB_MODULE = path.join(PROJECT_ROOT, 'database', 'db.js');
const DEFAULT_DB = path.join(PROJECT_ROOT, 'database', 'traintrack.db');
const TMP_DIR = path.join(PROJECT_ROOT, 'tests', '.tmp');

// Load a fresh copy of database/db.js with a given DATABASE_PATH value.
// Clearing the require cache re-evaluates the module so the top-level
// DB_PATH constant is recomputed from the current environment.
function loadDbModule(databasePath) {
  if (databasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = databasePath;
  delete require.cache[require.resolve(DB_MODULE)];
  return require(DB_MODULE);
}

let openHandles = [];
let tmpFiles = [];
function tmpPath(name) {
  const p = path.join(TMP_DIR, `c2-${process.pid}-${name}.db`);
  tmpFiles.push(p);
  return p;
}

before(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

after(() => {
  // Best-effort cleanup — restore env, close handles, remove temp files.
  delete process.env.DATABASE_PATH;
  delete require.cache[require.resolve(DB_MODULE)];
  for (const db of openHandles) { try { db.close(); } catch { /* ignore */ } }
  for (const f of tmpFiles) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(f + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
});

test('1. DATABASE_PATH undefined → existing default path is used', () => {
  const mod = loadDbModule(undefined);
  assert.equal(mod.DB_PATH, DEFAULT_DB);
});

test('2. DATABASE_PATH defined → override path is used', () => {
  const override = tmpPath('override');
  const mod = loadDbModule(override);
  assert.equal(mod.DB_PATH, override);
});

test('3. multiple temporary databases can be created independently', async () => {
  const pathA = tmpPath('multiA');
  const pathB = tmpPath('multiB');

  const modA = loadDbModule(pathA);
  const dbA = await modA.initDb();
  openHandles.push(dbA);
  await modA.dbRun('CREATE TABLE IF NOT EXISTS _c2_probe (id INTEGER PRIMARY KEY, tag TEXT)');
  await modA.dbRun('INSERT INTO _c2_probe (tag) VALUES (?)', ['A']);

  const modB = loadDbModule(pathB);
  const dbB = await modB.initDb();
  openHandles.push(dbB);
  await modB.dbRun('CREATE TABLE IF NOT EXISTS _c2_probe (id INTEGER PRIMARY KEY, tag TEXT)');
  await modB.dbRun('INSERT INTO _c2_probe (tag) VALUES (?)', ['B']);

  // Both files exist and are distinct
  assert.ok(fs.existsSync(pathA), 'temp DB A created');
  assert.ok(fs.existsSync(pathB), 'temp DB B created');
  assert.notEqual(pathA, pathB);

  // Data is isolated: B has exactly one row tagged 'B', not 'A'
  const rowsB = await modB.dbAll('SELECT tag FROM _c2_probe');
  assert.equal(rowsB.length, 1);
  assert.equal(rowsB[0].tag, 'B');
});

test('4. production database is never modified during tests', async () => {
  // Baseline the production DB (if present) then run an isolated temp init,
  // and confirm the production file is byte-for-byte untouched.
  const existed = fs.existsSync(DEFAULT_DB);
  const before = existed ? fs.statSync(DEFAULT_DB) : null;

  const isolated = tmpPath('isolation');
  const mod = loadDbModule(isolated);
  const db = await mod.initDb();
  openHandles.push(db);
  await mod.dbRun('CREATE TABLE IF NOT EXISTS _c2_probe (id INTEGER PRIMARY KEY)');

  if (existed) {
    const after = fs.statSync(DEFAULT_DB);
    assert.equal(after.size, before.size, 'production DB size unchanged');
    assert.equal(after.mtimeMs, before.mtimeMs, 'production DB mtime unchanged');
  }
  // The isolated DB, not the default, received the write.
  assert.notEqual(mod.DB_PATH, DEFAULT_DB);
  assert.ok(fs.existsSync(isolated), 'isolated DB file created instead');
});

test('5. no regression: module contract and default behaviour preserved', () => {
  const mod = loadDbModule(undefined);
  // Public API unchanged
  for (const fn of ['initDb', 'getDb', 'dbAll', 'dbGet', 'dbRun']) {
    assert.equal(typeof mod[fn], 'function', `${fn} is exported as a function`);
  }
  // Default path restored exactly when override absent
  assert.equal(mod.DB_PATH, DEFAULT_DB);
});
