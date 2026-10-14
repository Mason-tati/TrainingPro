// WP-21 · Phase 4 — Enterprise Feature-Gated Server Mount Preparation.
//
// Prepares the future server.js integration descriptor while remaining completely disabled. This
// is NOT production wiring: it never registers the router on any app, never modifies Express,
// never modifies server.js, never registers middleware, never writes the database, and never
// enables production. Everything stays protected behind the OFF feature flag.
//
// It wraps the Phase 3 guarded mount into a server-mount descriptor a future WP could hand to
// server.js — but here it is never handed anywhere. Its only imports are ./runtime-feature-flag and
// ./guarded-route-mount. Pure, stateless, deterministic, copy-on-read (fresh objects and arrays
// every call), never throws, no mutable globals, no singleton, no cache, no side effects. UNWIRED
// — nothing in production imports it.
'use strict';

const featureFlag = require('./runtime-feature-flag');
const guardedRouteMount = require('./guarded-route-mount');

// Enabled iff the (permanently OFF) feature flag says so — currently false.
function isServerMountEnabled() {
  return featureFlag.isEnabled();
}

// A fresh guarded mount descriptor every call (delegates to the Phase 3 guarded route mount).
function getGuardedMount() {
  return guardedRouteMount.createMount();
}

// Prepare the server-mount descriptor only — no registration, no Express app, no routing, no CRUD,
// no database writes.
function createServerMount() {
  return {
    enabled: isServerMountEnabled(),
    mount: getGuardedMount(),
    status: { mounted: false, production: false, mode: 'FOUNDATION' },
  };
}

// A fresh deterministic health descriptor every call — enabled derives from the OFF flag.
function health() {
  return {
    ready: true,
    enabled: isServerMountEnabled(),
    mountAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'guarded-mount', available: true },
    { name: 'feature-flag-disabled', available: true },
    { name: 'server-mount-preparation', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isServerMountEnabled(),
    mounted: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-21 Phase 5',
    description: 'Feature-gated server integration planning',
    productionImpact: false,
  };
}

module.exports = {
  isServerMountEnabled,
  getGuardedMount,
  createServerMount,
  health,
  capabilities,
  getStatus,
  getNextPhase,
};
