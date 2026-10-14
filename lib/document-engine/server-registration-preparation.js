// WP-22 · Phase 4 — Enterprise Document Engine Controlled Server Registration.
//
// Prepares the Enterprise Document Engine for eventual registration with the TrainingPro server.
// THIS IS NOT the real server integration: nothing becomes active, nothing is registered, nothing
// is mounted, nothing becomes reachable over HTTP, and no runtime behaviour changes. It prepares
// the final server-registration descriptor only. The engine remains disabled — its enabled state
// derives from the runtime feature flag, which is OFF while DOCUMENT_ENGINE_ENABLED is unset.
//
// Its only imports are ./runtime-feature-flag and ./production-mount-preparation. It reads NO
// environment itself (only the runtime feature flag reads the environment), and uses NO Express,
// NO HTTP/HTTPS, NO server creation, NO route/middleware registration, NO database, NO filesystem,
// NO path/sqlite/dotenv. Branch-free, stateless, deterministic, copy-on-read (fresh objects and
// arrays every call), never throws, no globals, no caching. UNWIRED — nothing in production
// imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const productionMountPreparation = require('./production-mount-preparation');

// Prepared-and-enabled iff the runtime feature flag is enabled — OFF by default.
function isServerRegistrationPrepared() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh production mount descriptor every call (delegates to the Phase 3 preparation).
function getProductionMount() {
  return productionMountPreparation.createProductionMount();
}

// Prepare the server-registration descriptor only — never registers anything.
function createServerRegistration() {
  return {
    enabled: isServerRegistrationPrepared(),
    productionMount: getProductionMount(),
    status: { prepared: true, registered: false, mounted: false, production: false, mode: 'FOUNDATION' },
  };
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isServerRegistrationPrepared(),
    prepared: true,
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
    enabled: isServerRegistrationPrepared(),
    registrationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'server-registration-preparation', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-mount-preparation', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-22 Phase 5',
    description: 'Controlled Production Registration Validation',
    productionImpact: false,
  };
}

module.exports = {
  isServerRegistrationPrepared,
  getProductionMount,
  createServerRegistration,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
