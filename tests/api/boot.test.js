// WP-07 · C3 — Importable app + test bootstrap
// Proves server.js is importable without auto-listening, the app runs on an
// ephemeral port against a temporary DB, admin login works there, the server
// closes cleanly, and normal startup behaviour is preserved.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { startTestApp, TMP_DIR } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const DB_MODULE = path.join(ROOT, 'database', 'db.js');
const DEFAULT_DB = path.join(ROOT, 'database', 'traintrack.db');

// Run a short node script in a child process with isolated temp DB env.
function runNode(code, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['-e', code],
      {
        cwd: ROOT,
        timeout: 15000,
        env: {
          ...process.env,
          DATABASE_PATH: path.join(TMP_DIR, `boot-child-${process.pid}.db`),
          SESSION_DB_DIR: TMP_DIR,
          ...extraEnv,
        },
      },
      (err, stdout, stderr) => resolve({ err, stdout, stderr })
    );
    child.on('error', () => {});
  });
}

let app;
before(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  app = await startTestApp();
});
after(async () => {
  if (app) await app.close();
});

test('1. server.js imports without auto-listening (exits on its own)', async () => {
  // A guarded import leaves no active handles → the process exits 0 naturally.
  // If the auto-start guard were removed, app.listen + non-unref intervals would
  // keep the process alive until the timeout kills it (err set).
  const code = `require(${JSON.stringify(SERVER)}); process.stdout.write('IMPORT_OK');`;
  const { err, stdout } = await runNode(code);
  assert.equal(err, null, 'import process exited on its own (did not hang / listen)');
  assert.ok(stdout.includes('IMPORT_OK'), 'import completed and exports resolved');
  assert.ok(!stdout.includes('TrainTrack running'), 'startup banner did not fire on import');
});

test('2. app starts on an ephemeral port', () => {
  assert.equal(typeof app.port, 'number');
  assert.ok(app.port > 0 && app.port !== 3000, `ephemeral port assigned (${app.port})`);
  assert.match(app.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('3. bootstrap uses a temporary DATABASE_PATH under tests/.tmp', () => {
  assert.equal(process.env.DATABASE_PATH, app.dbPath);
  assert.ok(app.dbPath.startsWith(TMP_DIR), 'temp DB lives under tests/.tmp');
  assert.notEqual(app.dbPath, DEFAULT_DB);
  assert.ok(fs.existsSync(app.dbPath), 'temp DB file was created');
});

test('4. admin login works against the temporary database', async () => {
  assert.ok(app.cookie && app.cookie.length > 0, 'authenticated cookie returned');
  // Authenticated call succeeds
  const staff = await app.request('GET', '/api/staff');
  assert.equal(staff.status, 200, 'authenticated request accepted');
  // Identity is the seeded admin
  const me = await app.request('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json().username, 'admin');
  assert.ok(me.json().admin, 'seeded user is admin');
  // Anonymous request is still blocked (auth behaviour unchanged)
  const anon = await app.request('GET', '/api/staff', null, null);
  assert.equal(anon.status, 401, 'unauthenticated request rejected');
});

test('5. the test server closes cleanly', async () => {
  const local = await startTestApp();
  const before = await local.request('GET', '/api/auth/me');
  assert.equal(before.status, 200);
  await local.close(); // must resolve without throwing
  // After close, connections are refused.
  await assert.rejects(
    () => local.request('GET', '/api/auth/me'),
    /ECONNREFUSED|ECONNRESET|socket hang up/,
    'server no longer accepts connections after close()'
  );
});

test('6. normal startup behaviour preserved (default DB path when DATABASE_PATH unset)', async () => {
  // In a clean child with DATABASE_PATH removed, db.js resolves the default path
  // and never touches production during this assertion.
  const code = `
    delete process.env.DATABASE_PATH;
    const m = require(${JSON.stringify(DB_MODULE)});
    process.stdout.write(String(m.DB_PATH.endsWith('traintrack.db')) + '|' +
      [typeof m.initDb, typeof m.getDb, typeof m.dbAll, typeof m.dbGet, typeof m.dbRun].join(','));
  `;
  const { err, stdout } = await runNode(code, { DATABASE_PATH: '' });
  assert.equal(err, null);
  const [defaultOk, exportsSig] = stdout.trim().split('|');
  assert.equal(defaultOk, 'true', 'default DB path preserved when DATABASE_PATH unset');
  assert.equal(exportsSig, 'function,function,function,function,function', 'db module contract intact');

  // And server.js still exposes app + start + ensureAdminSeed for normal startup.
  const srvCode = `const s=require(${JSON.stringify(SERVER)});
    process.stdout.write([typeof s.app, typeof s.start, typeof s.ensureAdminSeed].join(','));`;
  const r2 = await runNode(srvCode);
  assert.equal(r2.err, null);
  assert.equal(r2.stdout.trim(), 'function,function,function', 'server exports app/start/ensureAdminSeed');
});
