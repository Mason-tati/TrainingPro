// WP-23 · Phase 4 — Enterprise Document Engine Controlled Express Registration Adapter.
//
// Prepares the adapter that will EVENTUALLY register the Enterprise Document Engine's router with
// the Express application. THIS PHASE REGISTERS NOTHING — it prepares the adapter descriptor only.
// Nothing becomes active, registered, mounted, wired, or reachable, and runtime behaviour is
// identical. The engine remains disabled — its enabled state derives from the runtime feature flag,
// which is OFF while DOCUMENT_ENGINE_ENABLED is unset.
//
// Its only imports are ./runtime-feature-flag and ./express-mount-adapter. It does NOT import
// Express, the server, or an app; it reads NO environment itself (only the runtime feature flag
// reads the environment); and it performs NO HTTP/HTTPS, NO server creation, NO route/middleware
// registration, NO router mounting, NO controller/service/repository execution, NO database, NO
// CRUD, NO SQL, NO filesystem, NO path/sqlite/dotenv. Branch-free, stateless, deterministic,
// copy-on-read (fresh objects and arrays every call), never throws, no globals, no singleton, no
// cache, no mutable state, no side effects. UNWIRED — nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const expressMountAdapter = require('./express-mount-adapter');

// Registration-adapter-enabled iff the runtime feature flag is enabled — OFF by default.
function isRegistrationAdapterEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh Express mount adapter every call (delegates to the WP-23 Phase 3 adapter).
function getExpressMountAdapter() {
  return expressMountAdapter.createExpressMountAdapter();
}

// Prepare the Express registration adapter descriptor only — registers nothing.
function createExpressRegistrationAdapter() {
  return {
    enabled: isRegistrationAdapterEnabled(),
    expressMountAdapter: getExpressMountAdapter(),
    status: {
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

// A fresh deterministic status object every call (same status shape as the adapter, plus enabled).
function getStatus() {
  return {
    enabled: isRegistrationAdapterEnabled(),
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
    enabled: isRegistrationAdapterEnabled(),
    registrationAdapterAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'express-registration-adapter', available: true },
    { name: 'express-mount-adapter', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-23 Phase 5',
    description: 'Controlled Runtime Registration',
    productionImpact: false,
  };
}

module.exports = {
  isRegistrationAdapterEnabled,
  getExpressMountAdapter,
  createExpressRegistrationAdapter,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
