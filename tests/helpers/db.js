// WP-07 · C6 — DB test helper
// Provides an isolated, freshly-loaded database/db.js bound to a unique
// temporary DATABASE_PATH under tests/.tmp/. Never touches the production DB.
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const DB_MODULE = path.join(ROOT, 'database', 'db.js');
const TMP_DIR = path.join(ROOT, 'tests', '.tmp');
const DEFAULT_DB = path.join(ROOT, 'database', 'traintrack.db');

let seq = 0;
const tracked = []; // { dbPath, handles: [] }

// Return a fresh db module instance bound to a unique temp path. Set DATABASE_PATH
// BEFORE requiring so the module's top-level DB_PATH picks up the temp location.
function freshDb() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const dbPath = path.join(TMP_DIR, `dbtest-${process.pid}-${++seq}.db`);
  process.env.DATABASE_PATH = dbPath;
  delete require.cache[require.resolve(DB_MODULE)];
  const mod = require(DB_MODULE);
  const entry = { dbPath, handles: [] };
  tracked.push(entry);
  // Wrap initDb so we can close every opened connection during cleanup.
  const origInit = mod.initDb;
  mod.initDb = async () => { const h = await origInit(); entry.handles.push(h); return h; };
  return { mod, dbPath };
}

async function cleanupAll() {
  for (const { dbPath, handles } of tracked) {
    for (const h of handles) { try { await new Promise((r) => h.close(() => r())); } catch { /* ignore */ } }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.DATABASE_PATH;
}

// initDb() resolves as soon as its migration/seed statements are QUEUED, not
// after they finish. The app never notices (it doesn't query immediately), but
// tests do. initReady awaits initDb then polls until the migrations + seeds have
// settled (shift types are the last seed block). This changes no production code.
async function initReady(mod, { minShiftTypes = 5, timeoutMs = 8000 } = {}) {
  await mod.initDb();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await mod.dbGet('SELECT COUNT(*) c FROM tblShiftType');
      if (r && r.c >= minShiftTypes) return;
    } catch { /* migration table not created yet — keep waiting */ }
    if (Date.now() > deadline) throw new Error('DB migrations/seeds did not settle within timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

module.exports = { freshDb, cleanupAll, initReady, TMP_DIR, DEFAULT_DB };
