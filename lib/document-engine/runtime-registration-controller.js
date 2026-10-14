// WP-23 · Phase 5 — Enterprise Document Engine Controlled Runtime Registration.
//
// Prepares the runtime registration controller that will EVENTUALLY drive registration of the
// Enterprise Document Engine at runtime. THIS PHASE PERFORMS NO ACTUAL REGISTRATION — it prepares
// the runtime-registration descriptor only. Nothing becomes active, registered, mounted, wired,
// executed, or reachable, and runtime behaviour is identical. The engine remains disabled — its
// enabled state derives from the runtime feature flag, which is OFF while DOCUMENT_ENGINE_ENABLED
// is unset.
//
// Its only imports are ./runtime-feature-flag and ./express-registration-adapter. It does NOT
// import Express, the server, or an app; it reads NO environment itself (only the runtime feature
// flag reads the environment); and it performs NO HTTP/HTTPS, NO server creation, NO route/
// middleware registration, NO router mounting, NO controller/service/repository execution, NO
// database, NO CRUD, NO SQL, NO filesystem, NO path/sqlite/dotenv. Branch-free, stateless,
// deterministic, copy-on-read (fresh objects and arrays every call), never throws, no globals, no
// singleton, no cache, no mutable state, no side effects. UNWIRED — nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const expressRegistrationAdapter = require('./express-registration-adapter');

// Runtime-registration-enabled iff the runtime feature flag is enabled — OFF by default.
function isRuntimeRegistrationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh Express registration adapter every call (delegates to the WP-23 Phase 4 adapter).
function getExpressRegistrationAdapter() {
  return expressRegistrationAdapter.createExpressRegistrationAdapter();
}

// Prepare the runtime registration descriptor only — registers nothing.
function createRuntimeRegistration() {
  return {
    enabled: isRuntimeRegistrationEnabled(),
    expressRegistrationAdapter: getExpressRegistrationAdapter(),
    status: {
      runtimeReady: true,
      adapted: true,
      planned: true,
      coordinated: true,
      prepared: true,
      validated: true,
      implementationReady: true,
      registrationReady: true,
      implemented: false,
      wired: false,
      registered: false,
      mounted: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call (same status shape as the descriptor, plus enabled).
function getStatus() {
  return {
    enabled: isRuntimeRegistrationEnabled(),
    runtimeReady: true,
    adapted: true,
    planned: true,
    coordinated: true,
    prepared: true,
    validated: true,
    implementationReady: true,
    registrationReady: true,
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
    enabled: isRuntimeRegistrationEnabled(),
    runtimeRegistrationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-registration-controller', available: true },
    { name: 'express-registration-adapter', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-23 Phase 6',
    description: 'Controlled Runtime Registration Validation',
    productionImpact: false,
  };
}

module.exports = {
  isRuntimeRegistrationEnabled,
  getExpressRegistrationAdapter,
  createRuntimeRegistration,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
