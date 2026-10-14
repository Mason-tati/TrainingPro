// WP-20 · E3 — Enterprise Controlled Service Registration (metadata + readiness layer).
//
// The controlled service-registration layer for the Enterprise Document Engine. It does NOT
// register any service, does NOT modify server.js, and changes NO production behaviour — it only
// exposes the metadata and readiness that future production wiring will consult when the engine's
// service is eventually registered. It derives its enabled state from
// ./integration-adapter.isIntegrationEnabled(), which is permanently OFF, so registration is
// always reported disabled.
//
// Its only import is the sibling ./integration-adapter; it does NOT import Express, the server,
// routes, controller, services, repositories, or the engine. Pure, stateless, deterministic,
// never throws, copy-on-read (fresh objects and arrays every call), no mutation, no singleton, no
// cache, no module state. Never performs any registration. UNWIRED — nothing in production
// imports it.
'use strict';

const adapter = require('./integration-adapter');

// Registration is enabled ONLY if the (permanently OFF) integration adapter says so — always false.
function isRegistrationEnabled() {
  return adapter.isIntegrationEnabled();
}

// A fresh registration descriptor every call — enabled derived from the integration adapter.
function getRegistration() {
  return { ready: true, registered: false, enabled: adapter.isIntegrationEnabled(), safe: true };
}

// A fresh status object every call — enabled derived from the integration adapter.
function getStatus() {
  return { enabled: adapter.isIntegrationEnabled(), registered: false, production: false, mode: 'FOUNDATION' };
}

// A fresh deterministic health object every call — enabled derived from the integration adapter.
function health() {
  return { ready: true, registrationAvailable: true, enabled: adapter.isIntegrationEnabled() };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'service-registration', available: true },
    { name: 'integration-adapter', available: true },
    { name: 'foundation-mode', available: true },
    { name: 'production-disabled', available: true },
  ];
}

// A fresh descriptor of the next controlled-integration phase every call.
function getNextPhase() {
  return { phase: 'WP-20 E4', description: 'Controlled route registration', productionImpact: false };
}

module.exports = {
  isRegistrationEnabled,
  getRegistration,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
