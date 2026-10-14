// WP-24 · Phase 2 — Enterprise Document Engine Controlled Persistence-Backed Controller Binding.
//
// The second REAL implementation phase. It BINDS the existing WP-19 controller to the existing
// WP-18/21 persistence services by resolving the services from the WP-24 Phase 1 production
// composition bridge and pairing them with the controller in a single binding descriptor. It does
// NOT mount routes, does NOT modify server.js, and does NOT change the controller's behaviour: the
// existing controller module is REUSED by reference (never re-implemented, never duplicated,
// never mutated), and the persistence services are RESOLVED from the bridge (never re-composed).
// Actually re-routing the controller's internal delegation to those services would require
// modifying the approved controller/adapter chain and would change behaviour — both forbidden by
// this phase — so that swap is deferred to the mount phase; here we establish the binding only.
//
// The engine remains unreachable from production; enabled derives from the runtime feature flag,
// which is OFF while DOCUMENT_ENGINE_ENABLED is unset. It never opens a database connection, never
// executes SQL or CRUD during construction, registers no routes, imports no Express/server, and
// reads NO environment itself (only the runtime feature flag reads the environment). Stateless,
// deterministic, copy-on-read (fresh binding/status every call; the controller reference is
// intentionally shared), never throws, no globals, no singleton, no cache, no mutable state.
// UNWIRED — nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const productionCompositionBridge = require('./production-composition-bridge');
const controller = require('./controller');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isBindingEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh production composition bridge every call (delegates to the WP-24 Phase 1 bridge — the
// source of the persistence services being bound). `db` is optional and injected only for testing.
function getBinding(db) {
  return db === undefined
    ? productionCompositionBridge.createProductionCompositionBridge()
    : productionCompositionBridge.createProductionCompositionBridge({ db });
}

// Assemble the persistence-controller binding: the existing controller (reused) joined with the
// persistence services resolved from the bridge (same repository/service instances — no duplicate
// composition). Never opens a connection, never runs SQL/CRUD, never mounts.
function createPersistenceControllerBinding(options) {
  const opts = isPlainObject(options) ? options : {};
  const bridge = 'db' in opts ? getBinding(opts.db) : getBinding();
  return {
    enabled: isBindingEnabled(),
    controller,
    services: bridge.composition.services,
    status: {
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
    enabled: isBindingEnabled(),
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
    enabled: isBindingEnabled(),
    controllerBindingAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'persistence-controller-binding', available: true },
    { name: 'production-composition-bridge', available: true },
    { name: 'controller', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-24 Phase 3',
    description: 'Controlled Guarded Route Mount (staging only)',
    productionImpact: false,
  };
}

module.exports = {
  isBindingEnabled,
  getBinding,
  createPersistenceControllerBinding,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
