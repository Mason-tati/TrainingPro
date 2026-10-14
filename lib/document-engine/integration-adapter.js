// WP-20 · E2 — Enterprise Feature-Gated Integration Adapter (first controlled integration layer).
//
// The feature-gated adapter that all future WP-20 integration tasks will use. It does NOT enable
// the engine, does NOT mount routes, does NOT modify server.js, and changes NO production
// behaviour. It derives its enabled state from ./runtime-feature-flag.isEnabled(), which is permanently
// OFF — so the adapter always reports the engine as disabled.
//
// Its only import is the sibling ./runtime-feature-flag; it does NOT import Express, routes, mounting,
// controller, service, repository, engine, or server. Pure, stateless, deterministic, never
// throws, copy-on-read (fresh objects and arrays every call), no mutation, no singleton, no
// caching, no module state. UNWIRED — nothing in production imports it.
'use strict';

const flag = require('./runtime-feature-flag');

// The engine is enabled ONLY if the (permanently OFF) feature flag says so — always false.
function isIntegrationEnabled() {
  return flag.isEnabled();
}

// A fresh status object every call — enabled derived from the feature flag.
function getStatus() {
  return { enabled: flag.isEnabled(), mode: 'FOUNDATION', production: false, integration: false };
}

// A fresh integration descriptor every call — enabled derived from the feature flag.
function getIntegration() {
  return { ready: true, enabled: flag.isEnabled(), mounted: false, safe: true };
}

// A fresh deterministic health object every call — enabled derived from the feature flag.
function health() {
  return { ready: true, enabled: flag.isEnabled(), healthy: true };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'feature-gate', available: true },
    { name: 'integration-adapter', available: true },
    { name: 'foundation-mode', available: true },
    { name: 'production-disabled', available: true },
  ];
}

// A fresh descriptor of the next controlled-integration phase every call.
function getNextPhase() {
  return { phase: 'WP-20 E3', description: 'Controlled service registration', productionImpact: false };
}

module.exports = {
  isIntegrationEnabled,
  getStatus,
  getIntegration,
  health,
  capabilities,
  getNextPhase,
};
