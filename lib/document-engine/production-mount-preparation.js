// WP-22 · Phase 3 — Enterprise Document Engine Controlled Production Mount Integration.
//
// Introduces the production mount integration layer. It PREPARES the real Express integration but
// DOES NOT activate it: it mounts nothing, registers no routes, touches no server.js, registers no
// middleware, and changes no runtime behaviour. The engine remains disabled — its enabled state
// derives from ./runtime-feature-flag.isEnabled(), which is OFF while DOCUMENT_ENGINE_ENABLED is
// unset.
//
// Its only imports are ./runtime-feature-flag and ./server-integration-plan. It reads NO
// environment itself (only the runtime feature flag reads the environment), and uses NO Express,
// NO HTTP/HTTPS, NO server creation, NO route mounting or registration, NO database, NO
// filesystem. Branch-free, stateless, deterministic, copy-on-read (fresh objects and arrays every
// call), never throws, no globals, no caching. UNWIRED — nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const serverIntegrationPlan = require('./server-integration-plan');

// Prepared-and-enabled iff the runtime feature flag is enabled — OFF by default.
function isMountPrepared() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh integration plan every call (delegates to the Phase 5 planning module).
function getIntegrationPlan() {
  return serverIntegrationPlan.createIntegrationPlan();
}

// Prepare the production mount descriptor only — never mounts anything.
function createProductionMount() {
  return {
    enabled: isMountPrepared(),
    integrationPlan: getIntegrationPlan(),
    status: { prepared: true, mounted: false, production: false, mode: 'FOUNDATION' },
  };
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isMountPrepared(),
    prepared: true,
    mounted: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isMountPrepared(),
    preparationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'production-mount-preparation', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'integration-plan', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-22 Phase 4',
    description: 'Controlled Server Registration',
    productionImpact: false,
  };
}

module.exports = {
  isMountPrepared,
  getIntegrationPlan,
  createProductionMount,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
