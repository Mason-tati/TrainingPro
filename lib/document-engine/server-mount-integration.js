// WP-24 · Phase 8 — Enterprise Document Engine Controlled Single Server Mount Integration.
//
// The FINAL phase of WP-24 and the ONLY module that server.js imports. It performs the single,
// gated, idempotent mount of the Enterprise Document Engine into the running Express app — but only
// when the runtime feature flag is enabled. When DOCUMENT_ENGINE_ENABLED is unset/false (the
// default), mount(app) is a strict no-op: it calls NO app.use, registers NOTHING, and changes NO
// runtime behaviour. The engine is completely invisible by default.
//
// Its only imports are ./runtime-feature-flag and ./gated-server-mount-plan. mount(app) is the only
// function permitted to touch Express, and it uses the `app` passed to it (this module imports no
// Express, no http/https, no server, no database, no filesystem, and reads no environment itself —
// only the runtime feature flag reads the environment). Registration executes NO controller/handler/
// service/repository method and NO SQL. Deterministic, copy-on-read (fresh objects every call),
// never throws.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const gatedServerMountPlan = require('./gated-server-mount-plan');

const MOUNT_PATH = '/api/document-engine';
// Per-app idempotency marker (set on the app, not module state) so repeated mounts never register
// twice. A Symbol avoids polluting enumerable app properties.
const MOUNTED = Symbol('documentEngineServerMounted');

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isServerMountEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh gated server mount plan every call (delegates to the WP-24 Phase 7 plan). `options` (e.g.
// { db }) are forwarded straight through for testing.
function getMountPlan(options) {
  return gatedServerMountPlan.createGatedServerMountPlan(options);
}

// The guarded request handler registered by mount() when enabled. Reading the plan's descriptor
// fields executes NO controller/service/repository method and NO SQL. This phase registers the
// single gated mount; persistence-backed request serving is a future WP.
function createGuardedHandler(plan) {
  return function documentEngineGuardedHandler(req, res) {
    res.status(503).json({
      engine: 'enterprise-document-engine',
      mounted: true,
      serving: false,
      mode: plan.status.mode,
    });
  };
}

// Prepare the server mount descriptor only (no Express, no registration).
function createServerMount() {
  return {
    enabled: isServerMountEnabled(),
    mountPlan: getMountPlan(),
    status: {
      enabled: isServerMountEnabled(),
      handlerReady: true,
      activationReady: true,
      mountReady: true,
      integrationReady: true,
      gated: true,
      planned: true,
      mounted: false,
      registered: false,
      integrated: false,
      executed: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// The ONLY function that touches Express. Performs at most ONE guarded app.use on the given app,
// and only when the feature flag is enabled. Idempotent (a second call never re-registers). Never
// throws; a missing/invalid app is a safe no-op.
function mount(app) {
  if (!isServerMountEnabled()) {
    return { mounted: false };
  }
  if (!app || typeof app.use !== 'function') {
    return { mounted: false };
  }
  if (app[MOUNTED]) {
    return { mounted: true, path: MOUNT_PATH, alreadyMounted: true };
  }
  const plan = getMountPlan();
  app.use(MOUNT_PATH, createGuardedHandler(plan));
  app[MOUNTED] = true;
  return { mounted: true, path: MOUNT_PATH };
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isServerMountEnabled(),
    handlerReady: true,
    activationReady: true,
    mountReady: true,
    integrationReady: true,
    gated: true,
    planned: true,
    mounted: false,
    registered: false,
    integrated: false,
    executed: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isServerMountEnabled(),
    serverMountAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'server-mount-integration', available: true },
    { name: 'gated-server-mount-plan', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isServerMountEnabled,
  getMountPlan,
  createServerMount,
  mount,
  getStatus,
  health,
  capabilities,
};
