// WP-24 · Phase 1 — Enterprise Document Engine Controlled Persistence Bridge.
//
// The first REAL implementation phase. It connects the existing WP-19 API layer (controller +
// adapters) to the existing WP-21 persistence composition root (wiring.js) by assembling them into
// a single production composition object — the integration SEAM. It does NOT mount routes, does NOT
// modify server.js, does NOT re-route any call, and does NOT change runtime behaviour. The engine
// remains unreachable from production; its enabled state derives from the runtime feature flag,
// which is OFF while DOCUMENT_ENGINE_ENABLED is unset.
//
// It REUSES existing modules only (no duplicated logic, no duplicated composition): the persistence
// graph comes from wiring.createComposition() (repositories + services built over the SHARED
// database/db.js handle), and the API layer is the existing controller / api-adapter /
// repository-adapter references. It never opens a database connection directly, never executes SQL
// or CRUD during construction, imports no Express/server, and reads NO environment itself (only the
// runtime feature flag reads the environment). Stateless, deterministic, copy-on-read (fresh
// composition/status every call; the API-layer module references are intentionally shared), never
// throws, no globals, no singleton, no cache, no mutable state. UNWIRED — nothing in production
// imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const wiring = require('./wiring');
const controller = require('./controller');
const apiAdapter = require('./api-adapter');
const repositoryAdapter = require('./repository-adapter');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isBridgeEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh persistence composition every call (delegates to the WP-21 composition root — no
// duplicated composition). `db` is optional and injected only for testing; when omitted the shared
// database/db.js handle is used (via wiring), and no new connection is opened.
function getComposition(db) {
  return db === undefined ? wiring.createComposition() : wiring.createComposition({ db });
}

// Assemble the full production composition bridge: the persistence composition (repositories +
// services over the shared handle) joined with the existing API layer. Never registers routes,
// never opens a connection, never runs SQL/CRUD.
function createProductionCompositionBridge(options) {
  const opts = isPlainObject(options) ? options : {};
  const composition = 'db' in opts ? getComposition(opts.db) : getComposition();
  return {
    enabled: isBridgeEnabled(),
    composition,
    api: {
      controller,
      apiAdapter,
      repositoryAdapter,
    },
    status: {
      bridged: true,
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
    enabled: isBridgeEnabled(),
    bridged: true,
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
    enabled: isBridgeEnabled(),
    compositionBridgeAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'production-composition-bridge', available: true },
    { name: 'wiring', available: true },
    { name: 'controller', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-24 Phase 2',
    description: 'Controlled Persistence-Backed Controller Binding',
    productionImpact: false,
  };
}

module.exports = {
  isBridgeEnabled,
  getComposition,
  createProductionCompositionBridge,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
