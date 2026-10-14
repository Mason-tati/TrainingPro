// WP-07 · C3 — Test bootstrap helper
// Starts the real Express app in-process on an ephemeral port against a
// throwaway database, seeds the admin user in that temp DB only, and returns an
// authenticated cookie plus a request helper and a clean shutdown function.
//
// Guarantees:
//   • Sets DATABASE_PATH + SESSION_DB_DIR to isolated temp locations BEFORE the
//     app / db modules are required, so the production databases are untouched.
//   • Never binds port 3000 (uses listen(0)).
//   • close() shuts the HTTP listener and closes the main DB handle, then
//     removes the temp DB files (best effort).
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');

const ROOT = path.join(__dirname, '..', '..');
const TMP_DIR = path.join(ROOT, 'tests', '.tmp');
const DB_MODULE = path.join(ROOT, 'database', 'db.js');
const SERVER_MODULE = path.join(ROOT, 'server.js');
const ROUTES_DIR = path.join(ROOT, 'routes');
const LIB_DIR = path.join(ROOT, 'lib');

let seq = 0;

// Drop server.js, database/db.js and everything under routes/ and lib/ from the
// module cache so the next require() rebuilds a FRESH, fully-isolated app instance
// (its own db module + its own session store). Already-loaded instances keep
// working; this only affects subsequent requires. Enables true per-instance
// isolation for API tests (unique DB + unique session store per app).
function purgeAppModules() {
  for (const key of Object.keys(require.cache)) {
    if (
      key === DB_MODULE || key === SERVER_MODULE ||
      key.startsWith(ROUTES_DIR + path.sep) || key.startsWith(LIB_DIR + path.sep)
    ) {
      delete require.cache[key];
    }
  }
}

// Minimal promise-based HTTP client (dependency-free).
function httpRequest(baseUrl, method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const payload = body != null ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: data,
            json: () => { try { return JSON.parse(data); } catch { return null; } },
          }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(baseUrl, username, password) {
  const r = await httpRequest(baseUrl, 'POST', '/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`test admin login failed: ${r.status} ${r.text}`);
  const setCookie = r.headers['set-cookie'] || [];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

// Start the app on an ephemeral port with an isolated temp DB + session store.
// Call once per test file (each test file runs in its own process).
async function startTestApp() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const id = `${process.pid}-${++seq}`;
  const dbPath = path.join(TMP_DIR, `app-${id}.db`);
  const sessDir = path.join(TMP_DIR, `sess-${id}`);
  fs.mkdirSync(sessDir, { recursive: true });

  // Isolation MUST be set before the db/server modules are evaluated, and the
  // module cache purged so this call builds a fresh, isolated app instance
  // (its own temp DB + its own session store).
  process.env.DATABASE_PATH = dbPath;
  process.env.SESSION_DB_DIR = sessDir;
  // WP-08: keep app logging silent in tests so structured logs never pollute the
  // TAP stream. Logging tests re-enable via the returned appLogger instance.
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
  purgeAppModules();

  const db = require(DB_MODULE);
  await db.initDb();

  const server = require(SERVER_MODULE); // require.main !== module → does not listen
  // The logger instance THIS app uses (fresh after purge) — exposed so logging
  // tests can attach a sink / raise the level for assertions.
  const appLogger = require(path.join(ROOT, 'lib', 'logger.js'));
  await server.ensureAdminSeed();

  const listener = server.app.listen(0);
  await once(listener, 'listening');
  const { port } = listener.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookie = await login(baseUrl, 'admin', 'admin123');

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((res) => listener.close(() => res()));
    try { db.getDb().close(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return {
    baseUrl,
    cookie,
    dbPath,
    sessDir,
    db, // the fresh db module instance bound to THIS app's temp DB
    appLogger, // the fresh logger instance bound to THIS app (silent by default)

    port,
    close,
    // authenticated request by default; pass cookie=null for anonymous
    request: (method, urlPath, bodyArg, cookieArg = cookie) =>
      httpRequest(baseUrl, method, urlPath, bodyArg, cookieArg),
    rawRequest: httpRequest,
  };
}

module.exports = { startTestApp, httpRequest, TMP_DIR };
