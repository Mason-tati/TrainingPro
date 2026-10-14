// WP-09 · M1 — Health & liveness endpoint tests.
// Endpoints must return truthful, stable, minimal JSON — never index.html —
// without authentication and without emitting any request logs.
require('../helpers/network-guard');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
let logs;

before(async () => {
  app = await startTestApp();
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((rec) => logs.push(rec));
});
after(async () => { if (app) { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); } });
beforeEach(() => { logs = []; });

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const settle = () => new Promise((r) => setTimeout(r, 25));

// 1-7/12. /health: 200 JSON, exact shape, ok status, sane values, no auth needed.
test('1-7/12. GET /health returns the stable health summary unauthenticated', async () => {
  const r = await app.request('GET', '/health', null, null); // no cookie
  assert.equal(r.status, 200);                                                   // 1
  assert.ok(r.headers['content-type'].includes('application/json'), 'JSON');     // 2
  const b = r.json();
  assert.deepEqual(Object.keys(b).sort(), ['startedAt', 'status', 'timestamp', 'uptimeSec'], 'schema stable'); // 3/14
  assert.equal(b.status, 'ok');                                                  // 4
  assert.ok(Number.isFinite(b.uptimeSec) && b.uptimeSec >= 0, 'uptime >= 0');    // 5
  assert.ok(ISO_UTC.test(b.startedAt), 'startedAt ISO UTC');                     // 6
  assert.ok(ISO_UTC.test(b.timestamp), 'timestamp ISO UTC');                     // 7
});

// 8/9/12. /health/live: 200 with ONLY status + timestamp.
test('8/9/12. GET /health/live returns pure liveness unauthenticated', async () => {
  const r = await app.request('GET', '/health/live', null, null);
  assert.equal(r.status, 200);                                                   // 8
  assert.ok(r.headers['content-type'].includes('application/json'));
  const b = r.json();
  assert.deepEqual(Object.keys(b).sort(), ['status', 'timestamp'], 'only status + timestamp'); // 9
  assert.equal(b.status, 'ok');
  assert.ok(ISO_UTC.test(b.timestamp));
});

// 10/11. No HTML; the SPA catch-all no longer masks /health.
test('10/11. /health returns JSON, never index.html', async () => {
  for (const p of ['/health', '/health/live']) {
    const r = await app.request('GET', p, null, null);
    assert.ok(!r.text.toLowerCase().includes('<!doctype'), `${p}: no doctype`);
    assert.ok(!r.text.toLowerCase().includes('<html'), `${p}: no HTML`);
    assert.ok(r.json() !== null, `${p}: parseable JSON`);
  }
});

// 13. No request logs are emitted for any /health* path.
test('13. request logger emits nothing for /health and /health/live', async () => {
  await app.request('GET', '/health', null, null);
  await app.request('GET', '/health/live', null, null);
  await settle();
  const healthLogs = logs.filter((r) => r.metadata && typeof r.metadata.path === 'string' && r.metadata.path.startsWith('/health'));
  assert.equal(healthLogs.length, 0, 'no log events for /health*');
});

// 14. Shape stability across repeated calls (no drifting keys/types).
test('14. schema remains stable across repeated calls', async () => {
  const a = (await app.request('GET', '/health', null, null)).json();
  const b = (await app.request('GET', '/health', null, null)).json();
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(typeof a.uptimeSec, typeof b.uptimeSec);
  assert.ok(b.uptimeSec >= a.uptimeSec, 'uptime is monotonic');
});

// 15. Existing API behaviour unchanged (spot check alongside the full suite run).
test('15. existing API surface unaffected', async () => {
  assert.equal((await app.request('GET', '/api/staff')).status, 200, 'authenticated staff list still works');
  assert.equal((await app.request('GET', '/api/staff', null, null)).status, 401, 'auth guard unchanged');
});

// ── WP-09 · M2 — readiness endpoint ─────────────────────────────────────────
const path = require('node:path');
const monitoring = () => require(path.join(__dirname, '..', '..', 'lib', 'monitoring.js')); // the app's fresh instance

// M2 1-4. Ready path: 200, stable shape, db ok with latency, storage ok.
test('M2 1-4. /health/ready returns 200 with db + storage ok', async () => {
  monitoring().__clearReadinessCache();
  const r = await app.request('GET', '/health/ready', null, null); // unauthenticated
  assert.equal(r.status, 200);
  const b = r.json();
  assert.deepEqual(Object.keys(b).sort(), ['checks', 'status', 'timestamp'], 'shape stable');
  assert.equal(b.status, 'ready');
  // M4: checks now include the informational aiProvider + smtp placeholders.
  assert.deepEqual(Object.keys(b.checks).sort(), ['aiProvider', 'database', 'smtp', 'storage']);
  assert.equal(b.checks.database.status, 'ok');
  assert.ok(Number.isFinite(b.checks.database.latencyMs) && b.checks.database.latencyMs >= 0, 'latency >= 0');
  assert.equal(b.checks.storage.status, 'ok');
});

// M2 7. Disclosure safety: no paths, filenames, hostnames, config values.
test('M2 7. readiness response contains no sensitive paths or values', async () => {
  const r = await app.request('GET', '/health/ready', null, null);
  const s = r.text.toLowerCase();
  // 'smtp' is a legitimate FIELD NAME since M4 — the sweep targets values.
  for (const marker of ['uploads', 'traintrack', '.db', 'c:\\', 'c:/', 'database/', 'sqlite', 'anthropic', 'smtp_host', 'sk-']) {
    assert.ok(!s.includes(marker), `no "${marker}" in readiness body`);
  }
});

// M2 9. /health/ready is skipped from request logging.
test('M2 9. /health/ready emits no request logs', async () => {
  await app.request('GET', '/health/ready', null, null);
  await settle();
  const healthLogs = logs.filter((r) => r.metadata && typeof r.metadata.path === 'string' && r.metadata.path.startsWith('/health'));
  assert.equal(healthLogs.length, 0);
});

// M2 10. /health and /health/live still work alongside /ready.
test('M2 10. /health and /health/live unaffected by readiness', async () => {
  assert.equal((await app.request('GET', '/health', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/live', null, null)).status, 200);
});

// ── WP-09 · M3 — runtime metrics endpoint (admin-only) ─────────────────────
const bcrypt = require(path.join(__dirname, '..', '..', 'node_modules', 'bcryptjs'));

async function loginAs(username, password) {
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/login', { username, password });
  return (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
}

// M3 1/2. Unauthenticated and non-admin access is denied.
test('M3 1/2. /health/metrics denies unauthenticated and non-admin users', async () => {
  const anon = await app.request('GET', '/health/metrics', null, null);
  assert.equal(anon.status, 401, 'unauthenticated denied');
  assert.ok(!anon.text.includes('rssMB'), 'no metrics leak on 401');

  const hash = bcrypt.hashSync('m3-pass-1', 10);
  await app.db.dbRun(
    "INSERT INTO tblPswd (UserName,Password,HashPass,Admin,UserStatus,DateChanged) VALUES ('m3user','m3-pass-1',?,0,'Active',date('now'))",
    [hash]
  );
  const userCookie = await loginAs('m3user', 'm3-pass-1');
  const nonAdmin = await app.rawRequest(app.baseUrl, 'GET', '/health/metrics', null, userCookie);
  assert.equal(nonAdmin.status, 403, 'non-admin denied');
  assert.ok(!nonAdmin.text.includes('rssMB'), 'no metrics leak on 403');
});

// M3 3/4/5. Admin gets 200 with the stable, finite, non-negative shape.
test('M3 3/4/5. admin /health/metrics returns stable finite metrics', async () => {
  const r = await app.request('GET', '/health/metrics'); // admin cookie
  assert.equal(r.status, 200);
  const b = r.json();
  assert.deepEqual(Object.keys(b).sort(),
    ['cpu', 'eventLoopDelayMs', 'memory', 'node', 'pid', 'requestsServed', 'timestamp', 'uptimeSec'],
    'shape stable');
  assert.ok(ISO_UTC.test(b.timestamp));
  assert.equal(typeof b.node, 'string');
  const nums = [b.uptimeSec, b.pid, b.memory.rssMB, b.memory.heapUsedMB, b.memory.heapTotalMB,
    b.cpu.userMs, b.cpu.systemMs, b.eventLoopDelayMs.mean, b.eventLoopDelayMs.max, b.requestsServed];
  for (const n of nums) assert.ok(Number.isFinite(n) && n >= 0, `metric finite >= 0 (got ${n})`);
});

// M3 6. requestsServed increments with business API traffic (probes not counted).
test('M3 6. requestsServed increments after API requests', async () => {
  const before = (await app.request('GET', '/health/metrics')).json().requestsServed;
  await app.request('GET', '/api/staff');
  await app.request('GET', '/api/certs');
  const after = (await app.request('GET', '/health/metrics')).json().requestsServed;
  assert.ok(after >= before + 2, `counter advanced by API traffic (${before} → ${after})`);
});

// M3 7. Disclosure safety: no env values, paths, hostnames, secrets, keys, PII.
test('M3 7. metrics output contains no sensitive values', async () => {
  const r = await app.request('GET', '/health/metrics');
  const s = r.text.toLowerCase();
  const os = require('node:os');
  for (const marker of ['c:\\', 'c:/', 'uploads', 'traintrack', '.db', 'sqlite', 'anthropic', 'smtp',
    'password', 'secret', 'apikey', 'sk-', os.hostname().toLowerCase()]) {
    assert.ok(!s.includes(marker), `no "${marker}" in metrics body`);
  }
});

// M3 8. /health/metrics emits no request-log events (security events allowed).
test('M3 8. /health/metrics is skipped from request logging', async () => {
  await app.request('GET', '/health/metrics');
  await app.request('GET', '/health/metrics', null, null); // 401 path
  await settle();
  const reqLogs = logs.filter((r) => r.event.startsWith('HTTP_REQUEST') &&
    r.metadata && typeof r.metadata.path === 'string' && r.metadata.path.startsWith('/health'));
  assert.equal(reqLogs.length, 0, 'no HTTP_REQUEST_* events for /health/metrics');
});

// M3 9. Existing monitoring endpoints unaffected.
test('M3 9. /health, /health/live and /health/ready still work', async () => {
  monitoring().__clearReadinessCache();
  assert.equal((await app.request('GET', '/health', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/live', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/ready', null, null)).status, 200);
});

// ── WP-09 · M4 — dependency status placeholders ────────────────────────────
// Env hygiene: the developer machine may carry a real ANTHROPIC_API_KEY —
// save/remove it around these tests so results are deterministic everywhere.
const SAVED_AI_KEY = process.env.ANTHROPIC_API_KEY;
async function readyChecks() {
  monitoring().__clearReadinessCache();
  const r = await app.request('GET', '/health/ready', null, null);
  return { status: r.status, body: r.json(), text: r.text };
}

// M4 1/2/5. Placeholders present; both not-configured on a clean instance.
test('M4 1/2/5. readiness includes aiProvider + smtp, not-configured by default', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { status, body } = await readyChecks();
  assert.equal(status, 200, 'still ready');
  assert.equal(body.checks.aiProvider.status, 'not-configured');   // 2
  assert.equal(body.checks.smtp.status, 'not-configured');         // 5
  assert.deepEqual(Object.keys(body.checks.aiProvider), ['status'], 'status word only');
  assert.deepEqual(Object.keys(body.checks.smtp), ['status'], 'status word only');
});

// M4 3. Env key → configured.
test('M4 3. ANTHROPIC_API_KEY env → aiProvider configured', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-m4-env-key';
  const { body } = await readyChecks();
  assert.equal(body.checks.aiProvider.status, 'configured');
  delete process.env.ANTHROPIC_API_KEY;
});

// M4 4. tblConfig api-key row → configured.
test('M4 4. tblConfig anthropic_api_key → aiProvider configured', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await app.db.dbRun("INSERT INTO tblConfig (ckey, cvalue) VALUES ('anthropic_api_key', 'sk-m4-db-key-value')");
  const { body, text } = await readyChecks();
  assert.equal(body.checks.aiProvider.status, 'configured');
  assert.ok(!text.includes('sk-m4-db-key-value'), 'key VALUE never in response'); // 8
  await app.db.dbRun("DELETE FROM tblConfig WHERE ckey='anthropic_api_key'");
});

// M4 6/8. tblConfig smtp_host → configured; hostname value never disclosed.
test('M4 6/8. tblConfig smtp_host → smtp configured, hostname never disclosed', async () => {
  await app.db.dbRun("INSERT INTO tblConfig (ckey, cvalue) VALUES ('smtp_host', 'mail.m4-secret-host.example')");
  const { body, text } = await readyChecks();
  assert.equal(body.checks.smtp.status, 'configured');
  assert.ok(!text.includes('m4-secret-host'), 'smtp hostname never in response'); // 8
  await app.db.dbRun("DELETE FROM tblConfig WHERE ckey='smtp_host'");
});

// M4 7/9. Placeholders never gate readiness; network guard proves no outbound call.
test('M4 7/9. AI/SMTP status is non-gating and makes no outbound call', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const a = await readyChecks(); // both not-configured
  assert.equal(a.status, 200, 'not-configured placeholders do not cause 503');
  assert.equal(a.body.status, 'ready');
  // Network guard is active in this process — any real AI/SMTP attempt would
  // throw and fail the request. Configured state also stays outbound-free:
  process.env.ANTHROPIC_API_KEY = 'sk-test-m4';
  const b = await readyChecks();
  assert.equal(b.status, 200);
  assert.equal(b.body.checks.aiProvider.status, 'configured');
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true, 'guard active throughout');
  delete process.env.ANTHROPIC_API_KEY;
  if (SAVED_AI_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_AI_KEY; // restore env
});

// M4 10. Other monitoring endpoints unaffected.
test('M4 10. /health, /health/live and /health/metrics still work', async () => {
  assert.equal((await app.request('GET', '/health', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/live', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/metrics')).status, 200);
});

// ── WP-09 · M5 — lifecycle monitoring events ───────────────────────────────
const { spawn } = require('node:child_process');
const fsM5 = require('node:fs');
const ROOT = path.join(__dirname, '..', '..');
const { validateLogRecord } = require(path.join(ROOT, 'lib', 'log-schema.js'));

// M5 1/2/3/8/9. Real boot on an ephemeral port emits APP_STARTED then APP_READY,
// both schema-valid Infrastructure INFO events with no sensitive values; the
// process starts normally (startup behaviour unchanged) and terminates cleanly.
test('M5 1/2/3/8/9. real boot emits APP_STARTED and APP_READY', async () => {
  const dbPath = path.join(ROOT, 'tests', '.tmp', `m5-boot-${process.pid}.db`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATABASE_PATH: dbPath, SESSION_DB_DIR: path.join(ROOT, 'tests', '.tmp'), LOG_LEVEL: 'info' },
  });
  let out = '';
  const reachedReady = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20000);
    child.stdout.on('data', (c) => {
      out += c.toString();
      if (out.includes('APP_READY')) { clearTimeout(timer); resolve(true); }
    });
    child.on('exit', () => { clearTimeout(timer); resolve(out.includes('APP_READY')); });
  });
  child.kill();
  for (const suffix of ['', '-wal', '-shm']) { try { fsM5.rmSync(dbPath + suffix, { force: true }); } catch {} }

  assert.ok(reachedReady, 'boot reached APP_READY (startup behaviour intact)');
  const startedLine = out.split('\n').find((l) => l.includes('APP_STARTED'));
  const readyLine = out.split('\n').find((l) => l.includes('APP_READY'));
  assert.ok(startedLine, 'APP_STARTED emitted');
  assert.ok(readyLine, 'APP_READY emitted');
  assert.ok(out.indexOf('APP_STARTED') < out.indexOf('APP_READY'), 'started precedes ready');
  for (const line of [startedLine, readyLine]) {
    const rec = JSON.parse(line.trim());
    assert.equal(validateLogRecord(rec).valid, true, rec.event + ' schema-valid');
    assert.equal(rec.level, 'INFO');
    assert.equal(rec.module, 'Infrastructure');
    const s = line.toLowerCase();
    for (const marker of ['c:\\', 'c:/', 'uploads', '.db', 'sqlite', 'anthropic', 'smtp', 'sk-', 'password']) {
      assert.ok(!s.includes(marker), `no "${marker}" in ${rec.event}`);
    }
  }
});

// M5 4/5/6/7/8/9. Dependency transitions emit exactly once each; probes never spam.
test('M5 4-9. degraded/restored/readiness-failed emit once per transition only', async () => {
  const byEv = (ev) => logs.filter((r) => r.event === ev);

  // Baseline: healthy probe (prior tests established _lastStatuses = ready).
  monitoring().__clearReadinessCache();
  await app.request('GET', '/health/ready', null, null);
  logs = [];

  // Transition 1: break the database → DEGRADED + READINESS_FAILED, once each.
  app.db.getDb().close();
  monitoring().__clearReadinessCache();
  await app.request('GET', '/health/ready', null, null);
  await settle();
  assert.equal(byEv('MONITOR_DEPENDENCY_DEGRADED').length, 1, 'one degraded event');       // 4
  assert.equal(byEv('MONITOR_DEPENDENCY_DEGRADED')[0].metadata.check, 'database');
  assert.equal(byEv('MONITOR_DEPENDENCY_DEGRADED')[0].level, 'WARN');
  assert.equal(byEv('MONITOR_READINESS_FAILED').length, 1, 'one readiness-failed event');  // 6

  // Repeated failing probes: no additional events (no spam).                              // 7
  monitoring().__clearReadinessCache();
  await app.request('GET', '/health/ready', null, null);
  monitoring().__clearReadinessCache();
  await app.request('GET', '/health/ready', null, null);
  await settle();
  assert.equal(byEv('MONITOR_DEPENDENCY_DEGRADED').length, 1, 'still exactly one degraded');
  assert.equal(byEv('MONITOR_READINESS_FAILED').length, 1, 'still exactly one readiness-failed');

  // Transition 2: restore the database (idempotent initDb re-opens the file).
  await app.db.initDb();
  monitoring().__clearReadinessCache();
  const restored = await app.request('GET', '/health/ready', null, null);
  await settle();
  assert.equal(restored.status, 200, 'ready again after restore');
  assert.equal(byEv('MONITOR_DEPENDENCY_RESTORED').length, 1, 'one restored event');       // 5
  assert.equal(byEv('MONITOR_DEPENDENCY_RESTORED')[0].metadata.check, 'database');
  assert.equal(byEv('MONITOR_DEPENDENCY_RESTORED')[0].level, 'INFO');

  // 8/9: every lifecycle event schema-valid, Infrastructure module, no secrets.
  const lifecycle = logs.filter((r) => r.event.startsWith('MONITOR_'));
  assert.ok(lifecycle.length >= 3);
  for (const rec of lifecycle) {
    assert.equal(validateLogRecord(rec).valid, true, rec.event);
    assert.equal(rec.module, 'Infrastructure');
    const s = JSON.stringify(rec).toLowerCase();
    for (const marker of ['c:\\', 'c:/', 'uploads', '.db', 'sqlite', 'select ', 'sk-', 'password']) {
      assert.ok(!s.includes(marker), `no "${marker}" in ${rec.event}`);
    }
  }
});

// M5 10. Health surface unchanged after lifecycle work.
test('M5 10. health/live/ready/metrics behaviour unchanged', async () => {
  monitoring().__clearReadinessCache();
  assert.equal((await app.request('GET', '/health', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/live', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/ready', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/metrics')).status, 200);
  assert.equal((await app.request('GET', '/health/metrics', null, null)).status, 401);
});

// ── WP-09 · M6 — final monitoring safety sweep & endpoint verification ──────

// M6 sweep: plant sentinel secrets in config, drive every monitoring endpoint
// plus fresh transition events, then prove no forbidden material appears in ANY
// endpoint response or ANY captured monitoring log record.
test('M6 sweep: no forbidden material in any monitoring output or log', async () => {
  const os = require('node:os');
  // Plant sentinel values that must never surface.
  await app.db.dbRun("INSERT INTO tblConfig (ckey, cvalue) VALUES ('anthropic_api_key', 'sk-m6-sentinel-key-9876')");
  await app.db.dbRun("INSERT INTO tblConfig (ckey, cvalue) VALUES ('smtp_host', 'smtp.m6-sentinel-host.example')");
  logs = [];

  monitoring().__clearReadinessCache();
  const bodies = [];
  bodies.push((await app.request('GET', '/health', null, null)).text);
  bodies.push((await app.request('GET', '/health/live', null, null)).text);
  bodies.push((await app.request('GET', '/health/ready', null, null)).text);
  bodies.push((await app.request('GET', '/health/metrics')).text);          // admin
  bodies.push((await app.request('GET', '/health/metrics', null, null)).text); // 401 body
  await settle();

  const monitorLogs = logs.filter((r) => r.event.startsWith('MONITOR_') || r.event.startsWith('APP_'));
  // NOTE: the log records' envelope legitimately carries `host` (mandated by the
  // approved WP-08 L2.5 schema). The hostname ban therefore applies to ENDPOINT
  // RESPONSES; the rest of the forbidden list applies to both surfaces.
  const endpointSurface = bodies.join('\n').toLowerCase();
  // Strip the schema-mandated envelope host before sweeping the log surface.
  const logSurface = JSON.stringify(monitorLogs.map(({ host, ...rest }) => rest)).toLowerCase();
  const surfaces = endpointSurface + '\n' + logSurface;

  assert.ok(!endpointSurface.includes(os.hostname().toLowerCase()), 'hostname absent from endpoint responses');
  const FORBIDDEN = [
    'sk-m6-sentinel-key-9876', 'm6-sentinel-host',            // planted key + smtp host
    'c:\\', 'c:/', 'database/', 'uploads', '.db', 'sqlite',   // db/storage paths
    'connectionstring', 'postgres://', 'sqlite://',           // connection strings
    'select ', 'insert into', 'update tbl',                   // SQL statements/params
    'password', 'hashpass', 'connect.sid', '"cookie"', 'authorization', 'bearer ', // credentials
    'prompt', 'completion',                                   // AI prompt/output
    'medical', 'disciplinary', 'dob', 'ssn',                  // PII / sensitive records
  ];
  for (const marker of FORBIDDEN) {
    assert.ok(!surfaces.includes(marker), `forbidden "${marker}" absent from monitoring surfaces`);
  }
  // Session id value from the admin cookie must never surface either.
  const sid = (app.cookie.split('=')[1] || '');
  assert.ok(sid.length < 8 || !surfaces.includes(sid.slice(0, 12).toLowerCase()), 'session id never surfaces');

  // Clean up sentinels.
  await app.db.dbRun("DELETE FROM tblConfig WHERE ckey IN ('anthropic_api_key','smtp_host')");
  monitoring().__clearReadinessCache();
});

// M6 verification: all endpoints answer correctly; probe traffic stays unlogged;
// transition events validate. (Lifecycle APP_* events validated in the M5 boot test.)
test('M6: endpoints work, probes unlogged, transition events schema-valid', async () => {
  monitoring().__clearReadinessCache();
  logs = [];
  assert.equal((await app.request('GET', '/health', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/live', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/ready', null, null)).status, 200);
  assert.equal((await app.request('GET', '/health/metrics')).status, 200);
  await settle();
  const reqLogs = logs.filter((r) => r.event.startsWith('HTTP_REQUEST') &&
    r.metadata && typeof r.metadata.path === 'string' && r.metadata.path.startsWith('/health'));
  assert.equal(reqLogs.length, 0, 'all four monitoring paths skipped from request logging');

  // Force one fresh transition pair and validate the records.
  app.db.getDb().close();
  monitoring().__clearReadinessCache();
  await app.request('GET', '/health/ready', null, null);
  await app.db.initDb();
  monitoring().__clearReadinessCache();
  await app.request('GET', '/health/ready', null, null);
  await settle();
  const transitions = logs.filter((r) => r.event.startsWith('MONITOR_'));
  assert.ok(transitions.length >= 2, 'degraded + restored captured');
  for (const rec of transitions) {
    assert.equal(validateLogRecord(rec).valid, true, rec.event);
    assert.equal(rec.module, 'Infrastructure');
  }
});

// M2 5/6/8. LAST TEST (breaks this app's DB handle deliberately):
// cache returns the previous 'ready' verdict, then after a cache clear the
// broken database yields 503 not-ready — without any crash, twice in a row.
test('M2 5/6/8. TTL cache honoured; broken DB → 503 not-ready without crashing', async () => {
  monitoring().__clearReadinessCache();
  const warm = await app.request('GET', '/health/ready', null, null);
  assert.equal(warm.status, 200, 'ready before break');

  app.db.getDb().close(); // break the database underneath the app

  const cached = await app.request('GET', '/health/ready', null, null);
  assert.equal(cached.status, 200, 'TTL cache still serves the recent verdict'); // 8

  monitoring().__clearReadinessCache();
  const broken = await app.request('GET', '/health/ready', null, null);
  assert.equal(broken.status, 503, 'broken DB → 503');                            // 5
  const b = broken.json();
  assert.equal(b.status, 'not-ready');
  assert.equal(b.checks.database.status, 'down');
  assert.equal(b.checks.storage.status, 'ok', 'storage unaffected');

  monitoring().__clearReadinessCache();
  const again = await app.request('GET', '/health/ready', null, null);
  assert.equal(again.status, 503, 'repeated failing checks do not crash');        // 6
  // liveness must still answer even when readiness is down
  assert.equal((await app.request('GET', '/health/live', null, null)).status, 200);
});
