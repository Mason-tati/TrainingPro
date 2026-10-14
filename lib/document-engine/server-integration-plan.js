// WP-21 · Phase 5 — Enterprise Feature-Gated Server Integration Planning.
//
// Documents and prepares the future integration between the Enterprise Document Engine and
// TrainingPro. This is NOT production wiring: it never modifies server.js, never registers the
// router on any app, never mounts Express, never registers middleware, never writes the database,
// never enables production, and never changes runtime behaviour. Everything stays protected behind
// the OFF feature flag.
//
// It wraps the Phase 4 server-mount preparation into an integration-plan descriptor. `planned` is
// true (the plan exists), while `integrated`/`production` remain false (nothing is wired). Its only
// imports are ./runtime-feature-flag and ./server-mount-preparation. Pure, stateless, deterministic,
// copy-on-read (fresh objects and arrays every call), never throws, no mutable globals, no
// singleton, no cache, no side effects. UNWIRED — nothing in production imports it.
'use strict';

const featureFlag = require('./runtime-feature-flag');
const serverMountPreparation = require('./server-mount-preparation');

// Enabled iff the (permanently OFF) feature flag says so — currently false.
function isIntegrationPlanningEnabled() {
  return featureFlag.isEnabled();
}

// A fresh server-mount descriptor every call (delegates to the Phase 4 preparation).
function getServerMount() {
  return serverMountPreparation.createServerMount();
}

// Prepare the integration-plan descriptor only — no registration, no Express app, no routing, no
// CRUD, no database writes.
function createIntegrationPlan() {
  return {
    enabled: isIntegrationPlanningEnabled(),
    serverMount: getServerMount(),
    status: { planned: true, integrated: false, production: false, mode: 'FOUNDATION' },
  };
}

// A fresh deterministic health descriptor every call — enabled derives from the OFF flag.
function health() {
  return {
    ready: true,
    enabled: isIntegrationPlanningEnabled(),
    planningAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'server-mount', available: true },
    { name: 'integration-plan', available: true },
    { name: 'feature-flag-disabled', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isIntegrationPlanningEnabled(),
    planned: true,
    integrated: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-21 Phase 6',
    description: 'Feature-gated production integration validation',
    productionImpact: false,
  };
}

module.exports = {
  isIntegrationPlanningEnabled,
  getServerMount,
  createIntegrationPlan,
  health,
  capabilities,
  getStatus,
  getNextPhase,
};
