// WP-24 · Phase 3 — Enterprise Document Engine Controlled Persistence Handler Adapter.
//
// The third REAL implementation phase. It resolves the WP-24 Phase 2 persistence-controller binding
// and prepares a request-HANDLER DESCRIPTOR that the future Express mount will eventually use to
// serve requests via the persistence services. This is NOT an Express handler, is NOT mounted,
// performs NO routing, and performs NO HTTP work — it merely prepares the (non-executable) handler.
//
// It REUSES existing modules only (the controller and services come from the Phase 2 binding — no
// duplicated logic, no duplicated composition). It NEVER executes controller methods, NEVER opens a
// database connection, NEVER executes SQL/CRUD during construction, NEVER creates HTTP objects, and
// registers no routes. The engine remains unreachable from production; enabled derives from the
// runtime feature flag, which is OFF while DOCUMENT_ENGINE_ENABLED is unset. It reads NO environment
// itself (only the runtime feature flag reads the environment). Stateless, deterministic,
// copy-on-read (fresh handler/status every call; the controller/service references are intentionally
// shared), never throws, no globals, no singleton, no cache, no mutable state. UNWIRED — nothing in
// production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const persistenceControllerBinding = require('./persistence-controller-binding');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isHandlerEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh persistence-controller binding every call (delegates to the WP-24 Phase 2 binding — the
// source of the reused controller + services). `db` is optional and injected only for testing.
function getPersistenceBinding(db) {
  return db === undefined
    ? persistenceControllerBinding.createPersistenceControllerBinding()
    : persistenceControllerBinding.createPersistenceControllerBinding({ db });
}

// Prepare the persistence-backed handler descriptor only — resolves the binding and describes the
// future handler. `handler.executable` is false: nothing is a live/Express handler yet, and no
// controller method is ever invoked here.
function createPersistenceHandler(options) {
  const opts = isPlainObject(options) ? options : {};
  const binding = 'db' in opts ? getPersistenceBinding(opts.db) : getPersistenceBinding();
  return {
    enabled: isHandlerEnabled(),
    binding,
    handler: {
      type: 'persistence-backed',
      executable: false,
      controller: binding.controller,
      services: binding.services,
    },
    status: {
      handlerReady: true,
      bound: true,
      composed: true,
      wired: false,
      registered: false,
      mounted: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isHandlerEnabled(),
    handlerReady: true,
    bound: true,
    composed: true,
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
    enabled: isHandlerEnabled(),
    handlerAdapterAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'persistence-handler-adapter', available: true },
    { name: 'persistence-controller-binding', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-24 Phase 4',
    description: 'Controlled Guarded Route Mount (staging only)',
    productionImpact: false,
  };
}

module.exports = {
  isHandlerEnabled,
  getPersistenceBinding,
  createPersistenceHandler,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
