// WP-21 · Phase 3 — Enterprise Guarded Route Mount Foundation.
//
// Prepares the future mounting process for the Enterprise Document Engine while remaining
// completely disabled. This is NOT production wiring: nothing is mounted, nothing is registered,
// no Express application is modified, no middleware is registered, no database is written, and no
// runtime behaviour changes. Everything stays protected behind the OFF feature flag.
//
// It holds the WP-19 routes (isolated Express Router) and the Phase 2 API bridge, and assembles a
// mount descriptor — but never registers the router on any app, never creates an Express app, and
// never routes a request. Its only imports are ./runtime-feature-flag, ./api-bridge, and ./routes. Pure,
// stateless, deterministic, copy-on-read (fresh objects and arrays every call — the routes and
// controller references are intentionally shared as the mountable surface), never throws, no
// mutable globals, no singleton, no cache. UNWIRED — nothing in production imports it.
'use strict';

const featureFlag = require('./runtime-feature-flag');
const apiBridge = require('./api-bridge');
const routes = require('./routes');

// Enabled iff the (permanently OFF) feature flag says so — currently false.
function isMountEnabled() {
  return featureFlag.isEnabled();
}

// The existing WP-19 routes (Express Router) — returned as-is (no wrapper, no mutation). This is
// the surface a future WP would eventually mount; here it is never mounted.
function getRoutes() {
  return routes;
}

// A fresh API bridge every call (delegates to the Phase 2 bridge).
function getBridge() {
  return apiBridge.createBridge();
}

// Prepare the mount object graph only — no registration, no Express app, no routing, no CRUD, no
// database writes.
function createMount() {
  return {
    enabled: isMountEnabled(),
    routes: getRoutes(),
    bridge: getBridge(),
    status: { mounted: false, production: false, mode: 'FOUNDATION' },
  };
}

// A fresh deterministic health descriptor every call — enabled derives from the OFF flag.
function health() {
  return {
    ready: true,
    enabled: isMountEnabled(),
    routesAvailable: true,
    bridgeAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'routes', available: true },
    { name: 'bridge', available: true },
    { name: 'feature-flag-disabled', available: true },
    { name: 'guarded-mount', available: true },
  ];
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isMountEnabled(),
    mounted: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

module.exports = {
  isMountEnabled,
  getRoutes,
  getBridge,
  createMount,
  health,
  capabilities,
  getStatus,
};
