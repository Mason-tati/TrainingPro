// WP-24 · Phase 4 — Enterprise Document Engine Controlled Live Handler Activation Adapter.
//
// The fourth REAL implementation phase. It resolves the WP-24 Phase 3 persistence-backed handler
// descriptor and prepares a LIVE-HANDLER ACTIVATION DESCRIPTOR that a future mount phase will
// consume. IMPORTANT: this phase DOES NOT activate the handler, DOES NOT mount anything, DOES NOT
// register routes, and DOES NOT modify server.js — runtime behaviour is 100% identical.
//
// The activation descriptor is inert: `ready:true`, `active:false`, `executed:false`. It REUSES the
// existing handler descriptor, controller, and services (no duplicated logic/composition). It NEVER
// executes the controller or the handler, NEVER opens a database connection, NEVER executes
// SQL/CRUD during construction, NEVER creates Express/HTTP objects, and registers no routes. The
// engine remains unreachable from production; enabled derives from the runtime feature flag, which
// is OFF while DOCUMENT_ENGINE_ENABLED is unset. It reads NO environment itself (only the runtime
// feature flag reads the environment). Stateless, deterministic, copy-on-read (fresh activation/
// status every call; the controller/service/handler references are intentionally shared), never
// throws, no globals, no singleton, no cache, no mutable state. UNWIRED — nothing in production
// imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const persistenceHandlerAdapter = require('./persistence-handler-adapter');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isActivationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh persistence handler every call (delegates to the WP-24 Phase 3 adapter — the source of
// the reused handler descriptor + controller + services). `db` is optional, injected for testing.
function getPersistenceHandler(db) {
  return db === undefined
    ? persistenceHandlerAdapter.createPersistenceHandler()
    : persistenceHandlerAdapter.createPersistenceHandler({ db });
}

// Prepare the live-handler activation descriptor only — describes the future activation without
// activating, executing, or mounting anything.
function createLiveHandlerActivation(options) {
  const opts = isPlainObject(options) ? options : {};
  const persistenceHandler = 'db' in opts ? getPersistenceHandler(opts.db) : getPersistenceHandler();
  return {
    enabled: isActivationEnabled(),
    persistenceHandler,
    activation: {
      ready: true,
      active: false,
      executed: false,
      handler: persistenceHandler.handler,
      controller: persistenceHandler.handler.controller,
      services: persistenceHandler.handler.services,
    },
    status: {
      enabled: isActivationEnabled(),
      handlerReady: true,
      activationReady: true,
      bound: true,
      composed: true,
      wired: false,
      registered: false,
      mounted: false,
      active: false,
      executed: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isActivationEnabled(),
    handlerReady: true,
    activationReady: true,
    bound: true,
    composed: true,
    wired: false,
    registered: false,
    mounted: false,
    active: false,
    executed: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isActivationEnabled(),
    activationAdapterAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'live-handler-activation-adapter', available: true },
    { name: 'persistence-handler-adapter', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-24 Phase 5',
    description: 'Controlled Guarded Route Mount (staging only)',
    productionImpact: false,
  };
}

module.exports = {
  isActivationEnabled,
  getPersistenceHandler,
  createLiveHandlerActivation,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
