// WP-23 · Phase 3 — Enterprise Document Engine Controlled Express Mount Adapter.
//
// Introduces the adapter that will EVENTUALLY connect the Enterprise Document Engine to the Express
// application. THIS PHASE DOES NOT MOUNT ANYTHING — it prepares the adapter only. Nothing becomes
// active, nothing registers, nothing becomes reachable, and runtime behaviour is identical. The
// engine remains disabled — its enabled state derives from the runtime feature flag, which is OFF
// while DOCUMENT_ENGINE_ENABLED is unset.
//
// Its only imports are ./runtime-feature-flag and ./server-mount-implementation-plan. It does NOT
// import Express, the server, or an app; it reads NO environment itself (only the runtime feature
// flag reads the environment); and it performs NO HTTP/HTTPS, NO server creation, NO route/
// middleware registration, NO router mounting, NO database, NO CRUD, NO SQL, NO filesystem, NO
// path/sqlite/dotenv. Branch-free, stateless, deterministic, copy-on-read (fresh objects and arrays
// every call), never throws, no globals, no singleton, no cache, no mutable state. UNWIRED —
// nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const serverMountImplementationPlan = require('./server-mount-implementation-plan');

// Adapter-enabled iff the runtime feature flag is enabled — OFF by default.
function isAdapterEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh mount implementation plan every call (delegates to the WP-23 Phase 2 plan).
function getMountImplementationPlan() {
  return serverMountImplementationPlan.createMountImplementationPlan();
}

// Prepare the Express mount adapter descriptor only — adapts; mounts/registers nothing.
function createExpressMountAdapter() {
  return {
    enabled: isAdapterEnabled(),
    mountImplementationPlan: getMountImplementationPlan(),
    status: {
      adapted: true,
      planned: true,
      coordinated: true,
      prepared: true,
      validated: true,
      implemented: false,
      wired: false,
      registered: false,
      mounted: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call (same status shape as the adapter, plus enabled).
function getStatus() {
  return {
    enabled: isAdapterEnabled(),
    adapted: true,
    planned: true,
    coordinated: true,
    prepared: true,
    validated: true,
    implemented: false,
    wired: false,
    registered: false,
    mounted: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isAdapterEnabled(),
    adapterAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'express-mount-adapter', available: true },
    { name: 'server-mount-implementation-plan', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-23 Phase 4',
    description: 'Controlled Express Registration Adapter',
    productionImpact: false,
  };
}

module.exports = {
  isAdapterEnabled,
  getMountImplementationPlan,
  createExpressMountAdapter,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
