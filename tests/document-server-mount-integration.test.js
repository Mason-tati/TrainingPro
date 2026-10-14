// WP-24 · Phase 8 — Enterprise Document Engine Controlled Single Server Mount Integration tests.
// Verifies the ONLY module server.js imports: default OFF; mount(app) is a strict no-op (no app.use)
// when disabled; exactly ONE app.use at /api/document-engine when enabled; idempotent (repeated mount
// safe, no duplicate registration); the guarded handler executes no controller/service/repository/SQL;
// the descriptor is reused; existing route/middleware/startup ordering is unaffected; import whitelist;
// and server.js contains exactly the one authorized reference.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'server-mount-integration.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const controller = require(path.join(EDIR, 'controller.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try {
    if (value === undefined) delete process.env.DOCUMENT_ENGINE_ENABLED; else process.env.DOCUMENT_ENGINE_ENABLED = value;
    return fn();
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
}
const withUnset = (fn) => withEnv(undefined, fn);
const withEnabled = (fn) => withEnv('true', fn);

// Minimal fake Express app that records app.use(...) calls.
function fakeApp() {
  const uses = [];
  return { uses, use(...args) { uses.push(args); return this; } };
}

const MOUNT_PATH = '/api/document-engine';

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P8-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'capabilities', 'createServerMount', 'getMountPlan', 'getStatus', 'health', 'isServerMountEnabled', 'mount',
  ]);
});

test('W24P8-2. every export is a function', () => {
  for (const k of Object.keys(M)) assert.equal(typeof M[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P8-3. isServerMountEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(M.isServerMountEnabled(), false);
    assert.equal(M.isServerMountEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P8-4. isServerMountEnabled is true only when DOCUMENT_ENGINE_ENABLED enables it', () => {
  withEnabled(() => assert.equal(M.isServerMountEnabled(), true));
  withEnv('false', () => assert.equal(M.isServerMountEnabled(), false));
});

// ---------------------------------------------------------------------------
// mount(app) — disabled = strict no-op
// ---------------------------------------------------------------------------

test('W24P8-5. mount(app) returns { mounted:false } and calls NO app.use when disabled', () => {
  withUnset(() => {
    const app = fakeApp();
    const r = M.mount(app);
    assert.deepEqual(r, { mounted: false });
    assert.equal(app.uses.length, 0, 'no app.use when disabled');
  });
});

test('W24P8-6. mount() never throws and mounts nothing under hostile/invalid apps (disabled or enabled)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 })];
  withUnset(() => { for (const a of hostile) noThrow(() => M.mount(a), 'mount disabled'); });
  withEnabled(() => {
    for (const a of hostile) {
      let r; noThrow(() => { r = M.mount(a); }, 'mount enabled');
      assert.equal(r.mounted, false, 'invalid app → not mounted'); // no .use function
    }
  });
});

// ---------------------------------------------------------------------------
// mount(app) — enabled = exactly one guarded app.use
// ---------------------------------------------------------------------------

test('W24P8-7. mount(app) performs EXACTLY ONE app.use at /api/document-engine when enabled', () => {
  withEnabled(() => {
    const app = fakeApp();
    const r = M.mount(app);
    assert.equal(r.mounted, true);
    assert.equal(r.path, MOUNT_PATH);
    assert.equal(app.uses.length, 1, 'exactly one app.use');
    assert.equal(app.uses[0][0], MOUNT_PATH, 'mounted at the document-engine path');
    assert.equal(typeof app.uses[0][1], 'function', 'a middleware handler was registered');
  });
});

test('W24P8-8. repeated mount is safe: no duplicate registration (idempotent per app)', () => {
  withEnabled(() => {
    const app = fakeApp();
    const r1 = M.mount(app);
    const r2 = M.mount(app);
    const r3 = M.mount(app);
    assert.equal(app.uses.length, 1, 'still exactly one app.use after repeated mounts');
    assert.equal(r1.mounted, true);
    assert.equal(r2.alreadyMounted, true);
    assert.equal(r3.alreadyMounted, true);
  });
});

test('W24P8-9. each app is mounted independently (per-app marker, no module state)', () => {
  withEnabled(() => {
    const a = fakeApp();
    const b = fakeApp();
    M.mount(a);
    M.mount(b);
    assert.equal(a.uses.length, 1);
    assert.equal(b.uses.length, 1);
  });
});

// ---------------------------------------------------------------------------
// the guarded handler — executes NO controller/SQL
// ---------------------------------------------------------------------------

test('W24P8-10. registering the mount executes NO controller method and NO SQL', () => {
  withEnabled(() => {
    let controllerCalls = 0;
    const origCreate = controller.create;
    controller.create = (...a) => { controllerCalls += 1; return origCreate(...a); };
    try {
      const app = fakeApp();
      M.mount(app);
      assert.equal(controllerCalls, 0, 'no controller method executed during registration');
    } finally {
      controller.create = origCreate;
    }
  });
});

test('W24P8-11. the registered handler responds without executing the controller (guarded, non-serving)', () => {
  withEnabled(() => {
    let controllerCalls = 0;
    const origCreate = controller.create;
    controller.create = (...a) => { controllerCalls += 1; return origCreate(...a); };
    try {
      const app = fakeApp();
      M.mount(app);
      const handler = app.uses[0][1];
      let captured = null;
      const res = { status(code) { captured = { code }; return this; }, json(body) { captured.body = body; return this; } };
      handler({ method: 'GET', url: '/x' }, res);
      assert.equal(captured.code, 503, 'guarded handler is non-serving in this phase');
      assert.equal(captured.body.serving, false);
      assert.equal(controllerCalls, 0, 'handler executes no controller method');
    } finally {
      controller.create = origCreate;
    }
  });
});

// ---------------------------------------------------------------------------
// getMountPlan / createServerMount — descriptor reuse
// ---------------------------------------------------------------------------

test('W24P8-12. getMountPlan delegates to gated-server-mount-plan.createGatedServerMountPlan()', () => {
  const plan = M.getMountPlan();
  assert.deepEqual(Object.keys(plan).sort(), ['enabled', 'mountPlan', 'serverIntegrationDescriptor', 'status']);
  assert.equal(plan.mountPlan.gated, true);
  assert.equal(plan.mountPlan.mounted, false);
});

test('W24P8-13. getMountPlan reuses the descriptor chain down to the WP-19 controller (no duplication)', () => {
  const plan = M.getMountPlan();
  assert.equal(plan.mountPlan.controller, controller);
  const db = { run() {}, get() {}, all() {} };
  const withDb = M.getMountPlan({ db });
  assert.equal(withDb.mountPlan.services.documentService.repository.db, db, 'DB handle reused end-to-end');
});

test('W24P8-14. createServerMount returns { enabled, mountPlan, status } with runtime flags false', () => {
  withUnset(() => {
    const sm = M.createServerMount();
    assert.deepEqual(Object.keys(sm).sort(), ['enabled', 'mountPlan', 'status']);
    assert.equal(sm.enabled, false);
    for (const f of ['mounted', 'registered', 'integrated', 'executed', 'production']) assert.equal(sm.status[f], false, `${f} false`);
    for (const t of ['handlerReady', 'activationReady', 'mountReady', 'integrationReady', 'gated', 'planned']) assert.equal(sm.status[t], true, `${t} true`);
  });
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities
// ---------------------------------------------------------------------------

test('W24P8-15. getStatus is a fresh copy; copy-on-read', () => {
  const a = M.getStatus();
  const b = M.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(M.getStatus().mode, 'FOUNDATION');
});

test('W24P8-16. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(M.health(), { ready: true, enabled: false, serverMountAvailable: true });
  });
  const a = M.health();
  const b = M.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(M.health().ready, true);
});

test('W24P8-17. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = M.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'server-mount-integration', 'gated-server-mount-plan', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = M.capabilities();
  const b = M.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(M.capabilities()[0].available, true);
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan (app.use is ALLOWED here — it is the point)
// ---------------------------------------------------------------------------

test('W24P8-18. imports ONLY ./runtime-feature-flag + ./gated-server-mount-plan; no Express/http/db/env', () => {
  const src = fs.readFileSync(path.join(EDIR, 'server-mount-integration.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./gated-server-mount-plan', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  // it MAY call app.use (that is the whole point), but must not create servers/routers/listen
  assert.ok(!/\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no server/router creation or listen');
});

// ---------------------------------------------------------------------------
// server.js authorized-integration invariant
// ---------------------------------------------------------------------------

test('W24P8-19. server.js references EXACTLY the authorized server-mount-integration and NO other document-engine module', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // exactly one require of the authorized module
  const engineRequires = (server.match(/require\((['"])[^'"]*document-engine[^'"]*\1\)/g) || []);
  assert.equal(engineRequires.length, 1, 'exactly one document-engine require in server.js');
  assert.ok(/document-engine\/server-mount-integration/.test(engineRequires[0]), 'the authorized module');
  // after removing the authorized line, no other document-engine reference remains
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
  // and it is a guarded mount call
  assert.ok(/server-mount-integration['"]\)\.mount\(app\)/.test(server), 'server.js performs the single guarded mount(app)');
});

test('W24P8-20. routes/, middleware/, controllers/, and top-level lib/ still do NOT import lib/document-engine', () => {
  const files = [];
  for (const dir of ['routes', 'middleware', 'controllers']) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) for (const f of fs.readdirSync(p)) if (f.endsWith('.js')) files.push(path.join(p, f));
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
