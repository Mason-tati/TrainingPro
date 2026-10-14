// WP-22 · Phase 2 — Runtime Feature Flag Adoption verification.
// Confirms the WP-20/WP-21 integration chain now derives its enabled state from
// ./runtime-feature-flag (the single source of truth): every chain module imports
// ./runtime-feature-flag and NONE still imports ./feature-flag; runtime-feature-flag is the only
// process.env reader in the engine; and with DOCUMENT_ENGINE_ENABLED unset the effective runtime
// behaviour across the whole chain remains OFF (identical to before adoption).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');

// The WP-20 / WP-21 integration-chain modules that gate on the feature flag.
const CHAIN = [
  'integration-adapter',
  'wiring',
  'api-bridge',
  'guarded-route-mount',
  'server-mount-preparation',
  'server-integration-plan',
  'production-integration-validation',
  'production-readiness-confirmation',
  'final-production-integration-report',
];

const readSrc = (name) => fs.readFileSync(path.join(EDIR, `${name}.js`), 'utf8');

// ---------------------------------------------------------------------------
// adoption: chain imports runtime-feature-flag, not the legacy flag
// ---------------------------------------------------------------------------

test('W2-1. every integration-chain module imports ./runtime-feature-flag', () => {
  for (const name of CHAIN) {
    assert.ok(/require\(['"]\.\/runtime-feature-flag['"]\)/.test(readSrc(name)), `${name} imports ./runtime-feature-flag`);
  }
});

test('W2-2. NO integration-chain module still imports the legacy ./feature-flag', () => {
  for (const name of CHAIN) {
    assert.ok(!/require\(['"]\.\/feature-flag['"]\)/.test(readSrc(name)), `${name} must not import ./feature-flag`);
  }
});

test('W2-3. no lib/document-engine module imports the legacy ./feature-flag any more (except its own test surface is separate)', () => {
  const files = fs.readdirSync(EDIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    assert.ok(!/require\(['"]\.\/feature-flag['"]\)/.test(fs.readFileSync(path.join(EDIR, f), 'utf8')), `${f} must not import ./feature-flag`);
  }
});

// ---------------------------------------------------------------------------
// single source of truth: only runtime-feature-flag reads process.env
// ---------------------------------------------------------------------------

test('W2-4. runtime-feature-flag is the ONLY process.env reader in lib/document-engine', () => {
  const files = fs.readdirSync(EDIR).filter((f) => f.endsWith('.js'));
  const readers = files.filter((f) => /process\.env/.test(fs.readFileSync(path.join(EDIR, f), 'utf8')));
  assert.deepEqual(readers, ['runtime-feature-flag.js']);
});

// ---------------------------------------------------------------------------
// effective behaviour: OFF across the whole chain when the variable is unset
// ---------------------------------------------------------------------------

test('W2-5. with DOCUMENT_ENGINE_ENABLED unset, the entire chain is effectively OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try {
    delete process.env.DOCUMENT_ENGINE_ENABLED;
    const runtime = require(path.join(EDIR, 'runtime-feature-flag.js'));
    assert.equal(runtime.isEnabled(), false);

    const integrationAdapter = require(path.join(EDIR, 'integration-adapter.js'));
    const wiring = require(path.join(EDIR, 'wiring.js'));
    const apiBridge = require(path.join(EDIR, 'api-bridge.js'));
    const guardedMount = require(path.join(EDIR, 'guarded-route-mount.js'));
    const serverMount = require(path.join(EDIR, 'server-mount-preparation.js'));
    const integrationPlan = require(path.join(EDIR, 'server-integration-plan.js'));
    const validation = require(path.join(EDIR, 'production-integration-validation.js'));
    const confirmation = require(path.join(EDIR, 'production-readiness-confirmation.js'));
    const finalReport = require(path.join(EDIR, 'final-production-integration-report.js'));

    assert.equal(integrationAdapter.isIntegrationEnabled(), false);
    assert.equal(wiring.isWiringEnabled(), false);
    assert.equal(apiBridge.isBridgeEnabled(), false);
    assert.equal(guardedMount.isMountEnabled(), false);
    assert.equal(serverMount.isServerMountEnabled(), false);
    assert.equal(integrationPlan.isIntegrationPlanningEnabled(), false);
    assert.equal(validation.isValidationEnabled(), false);
    assert.equal(confirmation.isReadinessConfirmationEnabled(), false);
    assert.equal(finalReport.isFinalReportEnabled(), false);

    // and the fully-assembled final report is disabled end-to-end
    const report = finalReport.createFinalReport();
    assert.equal(report.enabled, false);
    assert.equal(report.confirmation.validation.integrationPlan.serverMount.mount.enabled, false);
    assert.equal(report.confirmation.validation.integrationPlan.serverMount.mount.bridge.enabled, false);
    assert.equal(report.confirmation.validation.integrationPlan.serverMount.mount.bridge.composition.enabled, false);
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

test('W2-6. the chain derives from runtime-feature-flag: enabling the env var flips the gate (proves single source, then restored)', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try {
    const apiBridge = require(path.join(EDIR, 'api-bridge.js'));
    const finalReport = require(path.join(EDIR, 'final-production-integration-report.js'));
    delete process.env.DOCUMENT_ENGINE_ENABLED;
    assert.equal(apiBridge.isBridgeEnabled(), false);
    assert.equal(finalReport.isFinalReportEnabled(), false);
    // NOTE: this only demonstrates the single-source wiring; it does NOT mount anything.
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    assert.equal(apiBridge.isBridgeEnabled(), true);
    assert.equal(finalReport.isFinalReportEnabled(), true);
    process.env.DOCUMENT_ENGINE_ENABLED = 'false';
    assert.equal(apiBridge.isBridgeEnabled(), false);
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});
