// WP-20 · E4 — Enterprise Controlled Route Registration (metadata + readiness layer).
//
// The controlled route-registration layer for the Enterprise Document Engine. This is NOT
// production wiring: it never registers routes, never creates an Express router, never modifies
// Express or server.js, and never changes runtime behaviour. It exists only so later WP-20 tasks
// have a single place describing future route registration. It derives its enabled state from
// ./service-registration.isRegistrationEnabled(), which is permanently OFF — everything remains
// disabled.
//
// Its only import is the sibling ./service-registration; it does NOT import Express, the server,
// routes, controller, adapters, service, engine, or any other module. Pure, stateless,
// deterministic, never throws, copy-on-read (fresh objects and arrays every call), no mutation, no
// singleton, no cache, no module state. Never performs any registration. UNWIRED — nothing in
// production imports it.
'use strict';

const serviceRegistration = require('./service-registration');

// Route registration is enabled ONLY if the (permanently OFF) service registration says so —
// always false.
function isRouteRegistrationEnabled() {
  return serviceRegistration.isRegistrationEnabled();
}

// A fresh route-registration descriptor every call — enabled derived from service registration.
function getRouteRegistration() {
  return {
    ready: true,
    routesRegistered: false,
    enabled: serviceRegistration.isRegistrationEnabled(),
    safe: true,
  };
}

// A fresh status object every call — enabled derived from service registration.
function getStatus() {
  return {
    enabled: serviceRegistration.isRegistrationEnabled(),
    routesRegistered: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call — enabled derived from service registration.
function health() {
  return {
    ready: true,
    routeRegistrationAvailable: true,
    enabled: serviceRegistration.isRegistrationEnabled(),
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'route-registration', available: true },
    { name: 'service-registration', available: true },
    { name: 'foundation-mode', available: true },
    { name: 'production-disabled', available: true },
  ];
}

// A fresh descriptor of the next controlled-integration phase every call.
function getNextPhase() {
  return { phase: 'WP-20 E5', description: 'Controlled mounting registration', productionImpact: false };
}

module.exports = {
  isRouteRegistrationEnabled,
  getRouteRegistration,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
