// WP-20 · E5 — Enterprise Controlled Mount Registration (metadata + readiness layer).
//
// The controlled mount-registration layer for the Enterprise Document Engine. This is NOT
// production wiring: it never mounts anything, never registers middleware, never creates an
// Express application or router, and never modifies runtime behaviour. It exists only to describe
// future mount registration. It derives its enabled state from
// ./route-registration.isRouteRegistrationEnabled(), which is permanently OFF — everything
// remains disabled.
//
// Its only import is the sibling ./route-registration; it does NOT import Express, the server,
// routes, controller, adapters, service, engine, or any other module. Pure, stateless,
// deterministic, never throws, copy-on-read (fresh objects and arrays every call), no mutation, no
// singleton, no cache, no module state. Never performs any mounting. UNWIRED — nothing in
// production imports it.
'use strict';

const routeRegistration = require('./route-registration');

// Mount registration is enabled ONLY if the (permanently OFF) route registration says so —
// always false.
function isMountRegistrationEnabled() {
  return routeRegistration.isRouteRegistrationEnabled();
}

// A fresh mount-registration descriptor every call — enabled derived from route registration.
function getMountRegistration() {
  return {
    ready: true,
    mounted: false,
    enabled: routeRegistration.isRouteRegistrationEnabled(),
    safe: true,
  };
}

// A fresh status object every call — enabled derived from route registration.
function getStatus() {
  return {
    enabled: routeRegistration.isRouteRegistrationEnabled(),
    mounted: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call — enabled derived from route registration.
function health() {
  return {
    ready: true,
    mountRegistrationAvailable: true,
    enabled: routeRegistration.isRouteRegistrationEnabled(),
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'mount-registration', available: true },
    { name: 'route-registration', available: true },
    { name: 'foundation-mode', available: true },
    { name: 'production-disabled', available: true },
  ];
}

// A fresh descriptor of the next controlled-integration phase every call.
function getNextPhase() {
  return { phase: 'WP-20 E6', description: 'Controlled production readiness', productionImpact: false };
}

module.exports = {
  isMountRegistrationEnabled,
  getMountRegistration,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
