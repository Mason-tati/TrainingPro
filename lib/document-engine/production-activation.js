// WP-20 · E8 — Enterprise Controlled Production Activation (metadata + readiness layer).
//
// The controlled production-activation layer for the Enterprise Document Engine. This is NOT
// production activation: it exists only to describe future production-activation readiness. It
// never activates production, never enables the engine, never modifies runtime behaviour, never
// mounts routes, and never registers services. It derives its enabled state from
// ./production-validation.isProductionValidationReady(), which is permanently OFF — everything
// remains permanently disabled.
//
// Its only import is the sibling ./production-validation; it does NOT import Express, the server,
// routes, controller, adapters, service, engine, or any other module. Pure, stateless,
// deterministic, never throws, copy-on-read (fresh objects and arrays every call), no mutation, no
// singleton, no cache, no module state. Metadata only. UNWIRED — nothing in production imports it.
'use strict';

const productionValidation = require('./production-validation');

// Production activation is ready ONLY if the (permanently OFF) production validation says so —
// always false.
function isProductionActivationReady() {
  return productionValidation.isProductionValidationReady();
}

// A fresh production-activation descriptor every call — enabled derived from production validation.
function getProductionActivation() {
  return {
    ready: true,
    activationReady: false,
    enabled: productionValidation.isProductionValidationReady(),
    safe: true,
  };
}

// A fresh status object every call — enabled derived from production validation.
function getStatus() {
  return {
    enabled: productionValidation.isProductionValidationReady(),
    activationReady: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call — enabled derived from production validation.
function health() {
  return {
    ready: true,
    productionActivationAvailable: true,
    enabled: productionValidation.isProductionValidationReady(),
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'production-activation', available: true },
    { name: 'production-validation', available: true },
    { name: 'foundation-mode', available: true },
    { name: 'production-disabled', available: true },
  ];
}

// A fresh descriptor of the next controlled-integration phase every call.
function getNextPhase() {
  return { phase: 'WP-20 E9', description: 'Controlled production completion', productionImpact: false };
}

module.exports = {
  isProductionActivationReady,
  getProductionActivation,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
