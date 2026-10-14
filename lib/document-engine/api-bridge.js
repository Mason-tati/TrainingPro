// WP-21 · Phase 2 — Enterprise Document Engine API ↔ Persistence Bridge.
//
// Connects the WP-19 API layer (controller) to the WP-21 Phase 1 persistence composition root
// (wiring). Chain: controller → services → wiring composition root. This is NOT production wiring:
// it mounts no routes, touches no Express, performs no CRUD, writes no database, and changes no
// runtime behaviour. The engine stays disabled behind the OFF feature flag.
//
// Its only imports are ./runtime-feature-flag, ./wiring, and ./controller. Pure, stateless, deterministic,
// copy-on-read (fresh objects and arrays every call — the controller reference is intentionally
// shared as the API surface), never throws, no mutable globals, no singleton, no cache. UNWIRED —
// nothing in production imports it.
'use strict';

const featureFlag = require('./runtime-feature-flag');
const wiring = require('./wiring');
const controller = require('./controller');

// Enabled iff the (permanently OFF) feature flag says so — currently false.
function isBridgeEnabled() {
  return featureFlag.isEnabled();
}

// The existing WP-19 controller instance — returned as-is (no wrapper, no mutation).
function getController() {
  return controller;
}

// A fresh persistence composition graph every call (delegates to the Phase 1 wiring root).
function getComposition() {
  return wiring.createComposition();
}

// Prepare the bridge object graph only — no routing, no registration, no CRUD, no DB writes.
function createBridge() {
  return {
    enabled: isBridgeEnabled(),
    controller: getController(),
    composition: getComposition(),
    status: { wired: false, production: false, mode: 'FOUNDATION' },
  };
}

// A fresh deterministic health descriptor every call — enabled derives from the OFF flag.
function health() {
  return {
    ready: true,
    enabled: isBridgeEnabled(),
    controllerAvailable: true,
    compositionAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'controller', available: true },
    { name: 'composition', available: true },
    { name: 'feature-flag-disabled', available: true },
    { name: 'bridge', available: true },
  ];
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isBridgeEnabled(),
    wired: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

module.exports = {
  isBridgeEnabled,
  getController,
  getComposition,
  createBridge,
  health,
  capabilities,
  getStatus,
};
