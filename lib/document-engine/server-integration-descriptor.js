// WP-24 · Phase 6 — Enterprise Document Engine Controlled Server Integration Descriptor.
//
// The sixth REAL implementation phase. It resolves the WP-24 Phase 5 Express mount descriptor and
// packages it into the FINAL server integration descriptor that will eventually be consumed by the
// single gated integration point inside server.js. IMPORTANT: this phase DOES NOT modify server.js,
// DOES NOT register the router on any app, DOES NOT register routes, and DOES NOT activate the
// engine — runtime behaviour is 100% identical.
//
// The integration descriptor is inert: `ready:true`, `integrated:false`, `registered:false`,
// `mounted:false`, `executed:false`, `production:false`. It REUSES the mount descriptor, activation,
// handler, controller, and services (no duplicated logic/composition). It NEVER executes the
// controller/handler/activation/mount, NEVER opens a database connection, NEVER executes SQL/CRUD
// during construction, NEVER creates Express/HTTP objects, and registers no routes. The engine
// remains unreachable from production; enabled derives from the runtime feature flag, which is OFF
// while DOCUMENT_ENGINE_ENABLED is unset. It reads NO environment itself (only the runtime feature
// flag reads the environment). Stateless, deterministic, copy-on-read (fresh integration/status
// every call; the controller/service/handler references are intentionally shared), never throws, no
// globals, no singleton, no cache, no mutable state. UNWIRED — nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const expressMountDescriptor = require('./express-mount-descriptor');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isIntegrationDescriptorEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh Express mount descriptor every call (delegates to the WP-24 Phase 5 module — the source
// of the reused mount descriptor + activation + handler + controller + services). `db` optional (test).
function getMountDescriptor(db) {
  return db === undefined
    ? expressMountDescriptor.createExpressMountDescriptor()
    : expressMountDescriptor.createExpressMountDescriptor({ db });
}

// Prepare the final server integration descriptor only — describes the future single gated
// integration point without integrating, mounting, registering, executing, or creating Express.
function createServerIntegrationDescriptor(options) {
  const opts = isPlainObject(options) ? options : {};
  const mountDescriptor = 'db' in opts ? getMountDescriptor(opts.db) : getMountDescriptor();
  return {
    enabled: isIntegrationDescriptorEnabled(),
    mountDescriptor,
    integration: {
      ready: true,
      integrated: false,
      registered: false,
      mounted: false,
      executed: false,
      production: false,
      mount: mountDescriptor.mount,
      handler: mountDescriptor.mount.handler,
      controller: mountDescriptor.mount.controller,
      services: mountDescriptor.mount.services,
    },
    status: {
      enabled: isIntegrationDescriptorEnabled(),
      handlerReady: true,
      activationReady: true,
      mountReady: true,
      integrationReady: true,
      bound: true,
      composed: true,
      wired: false,
      registered: false,
      mounted: false,
      integrated: false,
      active: false,
      executed: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isIntegrationDescriptorEnabled(),
    handlerReady: true,
    activationReady: true,
    mountReady: true,
    integrationReady: true,
    bound: true,
    composed: true,
    wired: false,
    registered: false,
    mounted: false,
    integrated: false,
    active: false,
    executed: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isIntegrationDescriptorEnabled(),
    integrationDescriptorAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'server-integration-descriptor', available: true },
    { name: 'express-mount-descriptor', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-24 Phase 7',
    description: 'Controlled Gated Server Mount (single app.use, staging only)',
    productionImpact: false,
  };
}

module.exports = {
  isIntegrationDescriptorEnabled,
  getMountDescriptor,
  createServerIntegrationDescriptor,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
