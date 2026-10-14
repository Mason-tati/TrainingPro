// WP-25 · Phase 8 — Enterprise Document Engine Runtime Certification tests (FINAL phase of WP-25).
// Certifies the complete runtime by composing the Phase 7 production validator — no new validation
// logic. Certification proves the entire lifecycle (Application Startup -> ... -> Production Runtime
// Complete) was validated end to end: every stage exactly once, correctly ordered, duplicate-free.
// Disabled is a strict no-op; certification NEVER activates production (production=false,
// mode=FOUNDATION). The engine stays gated and invisible by default.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'runtime-certification.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeProductionValidator = require(path.join(EDIR, 'runtime-production-validator.js'));

const CERT_FLAGS = [
  'startupValidated', 'runtimeValidated', 'authenticationValidated', 'rbacValidated', 'middlewareValidated',
  'routeValidated', 'requestValidated', 'executionValidated', 'productionValidated',
  'exactlyOnceValidated', 'orderingValidated', 'duplicateSafe',
];

async function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try {
    if (value === undefined) delete process.env.DOCUMENT_ENGINE_ENABLED; else process.env.DOCUMENT_ENGINE_ENABLED = value;
    return await fn();
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
}
const withEnabled = (fn) => withEnv('true', fn);
const withUnset = (fn) => withEnv(undefined, fn);

// ---------------------------------------------------------------------------

test('W25P8-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'capabilities', 'certifyRuntime', 'createRuntimeCertification', 'getRuntimeProductionValidator',
    'getStatus', 'health', 'isCertificationEnabled',
  ]);
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

test('W25P8-2. default OFF — disabled certifies nothing, engine gated', async () => {
  await withUnset(async () => {
    assert.equal(C.isCertificationEnabled(), false);
    assert.equal(C.createRuntimeCertification().enabled, false);
    assert.equal(C.getStatus().enabled, false);
    const r = await C.certifyRuntime();
    assert.equal(r.enabled, false);
    assert.equal(r.certified, false);
    for (const f of CERT_FLAGS) assert.equal(r[f], false, `${f} false when disabled`);
    assert.equal(r.production, false);
    assert.equal(r.mode, 'FOUNDATION');
  });
});

test('W25P8-3. runtime-feature-flag delegation', async () => {
  await withUnset(() => assert.equal(C.isCertificationEnabled(), runtimeFeatureFlag.isEnabled()));
  await withEnabled(() => assert.equal(C.isCertificationEnabled(), true));
  await withEnv('false', () => assert.equal(C.isCertificationEnabled(), false));
});

test('W25P8-4. Phase-7 reuse — composes the runtime production validator', async () => {
  assert.equal(C.getRuntimeProductionValidator(), runtimeProductionValidator);
  assert.equal(C.createRuntimeCertification().productionValidator, runtimeProductionValidator);
});

test('W25P8-5. runtime certification — enabled run certifies and stays gated', async () => {
  await withEnabled(async () => {
    const r = await C.certifyRuntime();
    assert.equal(r.enabled, true);
    assert.equal(r.certified, true);
    assert.equal(r.production, false, 'certification never activates production');
    assert.equal(r.mode, 'FOUNDATION');
  });
});

test('W25P8-6. startup certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).startupValidated, true); });
});

test('W25P8-7. runtime certification chain', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).runtimeValidated, true); });
});

test('W25P8-8. authentication certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).authenticationValidated, true); });
});

test('W25P8-9. RBAC certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).rbacValidated, true); });
});

test('W25P8-10. middleware certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).middlewareValidated, true); });
});

test('W25P8-11. route certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).routeValidated, true); });
});

test('W25P8-12. request certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).requestValidated, true); });
});

test('W25P8-13. execution certification (controller/service/repository/database)', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).executionValidated, true); });
});

test('W25P8-14. production certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).productionValidated, true); });
});

test('W25P8-15. exactly-once certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).exactlyOnceValidated, true); });
});

test('W25P8-16. ordering certification (startup + middleware/route + production)', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).orderingValidated, true); });
});

test('W25P8-17. duplicate prevention certification', async () => {
  await withEnabled(async () => { assert.equal((await C.certifyRuntime()).duplicateSafe, true); });
});

test('W25P8-18. deterministic + copy-on-read', async () => {
  await withEnabled(async () => {
    const a = await C.certifyRuntime();
    const b = await C.certifyRuntime();
    assert.deepEqual(a, b, 'identical runs are byte-for-byte deterministic');
  });
  const s1 = C.getStatus(); const s2 = C.getStatus();
  assert.notEqual(s1, s2); s1.mode = 'HACKED'; assert.equal(C.getStatus().mode, 'FOUNDATION');
  const h1 = C.health(); const h2 = C.health();
  assert.notEqual(h1, h2); h1.healthy = false; assert.equal(C.health().healthy, true);
  assert.deepEqual(C.health(), { healthy: true, certified: false, production: false, mode: 'FOUNDATION' });
  const caps = C.capabilities();
  assert.deepEqual(caps.map((c) => c.name), ['Runtime Certification', 'End-to-End Validation', 'Production Readiness Certification', 'Runtime Safety Verification']);
  const cA = C.capabilities();
  assert.notEqual(caps, cA); assert.notEqual(caps[0], cA[0]); caps[0].available = false; assert.equal(C.capabilities()[0].available, true);
});

test('W25P8-19. import whitelist + forbidden API scan', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-certification.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './runtime-production-validator']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only the runtime flag reads env)');
  assert.ok(!/createServer\(|\.listen\(|express\.Router\(|express\(\)|app\.use\(/.test(src), 'no server/router/listen/app.use');
});

test('W25P8-20. no regression — the certifier is UNWIRED (server.js does not reference it)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!server.includes('runtime-certification'), 'server.js must not import the certifier');
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
});
