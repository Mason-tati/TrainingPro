// WP-24 · Phase 6 — Enterprise Document Engine Controlled Server Integration Descriptor tests.
// Verifies the module resolves the WP-24 Phase 5 mount descriptor and prepares an inert server
// integration descriptor (ready:true, integrated/registered/mounted/executed/production:false)
// reusing the existing mount/activation/handler/controller/services (same repository instances),
// while: enabled derives from ./runtime-feature-flag (OFF by default); NO writes/SQL, NO
// controller/handler execution during construction; no route registration/Express/HTTP; only
// runtime-feature-flag reads env; copy-on-read; determinism; never throws; and it is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const S = require(path.join(EDIR, 'server-integration-descriptor.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const expressMountDescriptor = require(path.join(EDIR, 'express-mount-descriptor.js'));
const controller = require(path.join(EDIR, 'controller.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

function fakeDb() {
  const calls = { run: 0, get: 0, all: 0 };
  return {
    calls,
    run(...a) { calls.run += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb.call({ lastID: 0, changes: 0 }, null); },
    get(...a) { calls.get += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, null); },
    all(...a) { calls.all += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, []); },
  };
}

const STATUS = {
  handlerReady: true, activationReady: true, mountReady: true, integrationReady: true, bound: true, composed: true,
  wired: false, registered: false, mounted: false, integrated: false, active: false, executed: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P6-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(S).sort(), [
    'capabilities', 'createServerIntegrationDescriptor', 'getMountDescriptor', 'getNextPhase', 'getStatus', 'health', 'isIntegrationDescriptorEnabled',
  ]);
});

test('W24P6-2. every export is a function', () => {
  for (const k of Object.keys(S)) assert.equal(typeof S[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P6-3. isIntegrationDescriptorEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(S.isIntegrationDescriptorEnabled(), false);
    assert.equal(S.isIntegrationDescriptorEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P6-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    S.createServerIntegrationDescriptor();
    S.getMountDescriptor();
    S.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(S.isIntegrationDescriptorEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getMountDescriptor — delegates to the Phase 5 module
// ---------------------------------------------------------------------------

test('W24P6-5. getMountDescriptor delegates to express-mount-descriptor.createExpressMountDescriptor()', () => {
  const md = S.getMountDescriptor();
  assert.deepEqual(Object.keys(md).sort(), ['activation', 'enabled', 'mount', 'status']);
  assert.deepEqual(Object.keys(md).sort(), Object.keys(expressMountDescriptor.createExpressMountDescriptor()).sort());
  assert.equal(md.mount.mounted, false);
});

test('W24P6-6. getMountDescriptor returns a FRESH mount descriptor every call', () => {
  const a = S.getMountDescriptor();
  const b = S.getMountDescriptor();
  assert.notEqual(a, b);
  assert.notEqual(a.mount, b.mount);
});

test('W24P6-7. getMountDescriptor(db) injects the handle through to the services (DB handle reuse)', () => {
  const db = fakeDb();
  const md = S.getMountDescriptor(db);
  assert.equal(md.mount.services.documentService.repository.db, db);
});

// ---------------------------------------------------------------------------
// createServerIntegrationDescriptor — the inert integration descriptor
// ---------------------------------------------------------------------------

test('W24P6-8. createServerIntegrationDescriptor returns the expected shape', () => {
  withUnset(() => {
    const d = S.createServerIntegrationDescriptor();
    assert.deepEqual(Object.keys(d).sort(), ['enabled', 'integration', 'mountDescriptor', 'status']);
    assert.equal(d.enabled, false);
    assert.deepEqual(d.status, { enabled: false, ...STATUS });
    assert.deepEqual(Object.keys(d.integration).sort(), ['controller', 'executed', 'handler', 'integrated', 'mount', 'mounted', 'production', 'ready', 'registered', 'services']);
  });
});

test('W24P6-9. integration descriptor: ready true, integrated/registered/mounted/executed/production false', () => {
  const d = S.createServerIntegrationDescriptor();
  assert.equal(d.integration.ready, true);
  assert.equal(d.integration.integrated, false);
  assert.equal(d.integration.registered, false);
  assert.equal(d.integration.mounted, false);
  assert.equal(d.integration.executed, false);
  assert.equal(d.integration.production, false);
});

test('W24P6-10. status: all readiness flags true, all runtime flags false', () => {
  withUnset(() => {
    const s = S.createServerIntegrationDescriptor().status;
    for (const t of ['handlerReady', 'activationReady', 'mountReady', 'integrationReady', 'bound', 'composed']) assert.equal(s[t], true, `${t} true`);
    for (const f of ['enabled', 'wired', 'registered', 'mounted', 'integrated', 'active', 'executed', 'production']) assert.equal(s[f], false, `${f} false`);
    assert.equal(s.mode, 'FOUNDATION');
  });
});

test('W24P6-11. reuses the mount descriptor + handler + controller + services (not duplicated)', () => {
  const d = S.createServerIntegrationDescriptor();
  assert.equal(d.integration.mount, d.mountDescriptor.mount, 'reuses the mount descriptor');
  assert.equal(d.integration.handler, d.mountDescriptor.mount.handler, 'reuses the handler');
  assert.equal(d.integration.controller, controller, 'reuses the existing controller');
  assert.equal(d.integration.services, d.mountDescriptor.mount.services, 'reuses the bound services (same instances)');
});

test('W24P6-12. repository instances reused end-to-end (service → repository → injected handle)', () => {
  const db = fakeDb();
  const d = S.createServerIntegrationDescriptor({ db });
  assert.equal(d.integration.services.documentService.repository.db, db);
});

test('W24P6-13. NO writes / NO SQL / NO controller/handler execution during construction', () => {
  const db = fakeDb();
  let controllerCalls = 0;
  const origCreate = controller.create;
  controller.create = (...a) => { controllerCalls += 1; return origCreate(...a); };
  try {
    S.createServerIntegrationDescriptor({ db });
    S.getMountDescriptor(db);
    assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all during construction');
    assert.equal(controllerCalls, 0, 'no controller method executed');
  } finally {
    controller.create = origCreate;
  }
});

test('W24P6-14. createServerIntegrationDescriptor returns a FRESH object with fresh integration/status; controller ref shared', () => {
  const a = S.createServerIntegrationDescriptor();
  const b = S.createServerIntegrationDescriptor();
  assert.notEqual(a, b);
  assert.notEqual(a.integration, b.integration);
  assert.notEqual(a.status, b.status);
  assert.equal(a.integration.controller, b.integration.controller); // shared existing module reference
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W24P6-15. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(S.getStatus(), { enabled: false, ...STATUS });
  });
  const a = S.getStatus();
  const b = S.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(S.getStatus().mode, 'FOUNDATION');
});

test('W24P6-16. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(S.health(), { ready: true, enabled: false, integrationDescriptorAvailable: true });
  });
  const a = S.health();
  const b = S.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(S.health().ready, true);
});

test('W24P6-17. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = S.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'server-integration-descriptor', 'express-mount-descriptor', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = S.capabilities();
  const b = S.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(S.capabilities()[0].available, true);
});

test('W24P6-18. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(S.getNextPhase(), {
    phase: 'WP-24 Phase 7', description: 'Controlled Gated Server Mount (single app.use, staging only)', productionImpact: false,
  });
  const a = S.getNextPhase();
  const b = S.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(S.getNextPhase().phase, 'WP-24 Phase 7');
});

// ---------------------------------------------------------------------------
// determinism + robustness + flag-enabled safety
// ---------------------------------------------------------------------------

test('W24P6-19. deterministic (fixed env); never throws; flag-enabled keeps integrated/mounted/executed false and route stack unchanged', () => {
  withUnset(() => {
    assert.deepEqual(S.getStatus(), S.getStatus());
    assert.deepEqual(S.createServerIntegrationDescriptor(), S.createServerIntegrationDescriptor());
    assert.deepEqual(S.capabilities(), S.capabilities());
    assert.deepEqual(S.getNextPhase(), S.getNextPhase());
    const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
    for (const h of hostile) {
      for (const k of Object.keys(S)) noThrow(() => S[k](h, h, h), `S.${k}`);
    }
  });
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const d = S.createServerIntegrationDescriptor();
    assert.equal(d.enabled, true);
    assert.equal(d.integration.integrated, false); // still not integrated
    assert.equal(d.integration.mounted, false); // still not mounted
    assert.equal(d.integration.executed, false); // still not executed
    assert.equal(d.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W24P6-20. imports ONLY the allowed pair (no Express/HTTP/server), reads no env, and is UNWIRED', () => {
  const src = fs.readFileSync(path.join(EDIR, 'server-integration-descriptor.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./express-mount-descriptor', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/route registration/app.use');
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
