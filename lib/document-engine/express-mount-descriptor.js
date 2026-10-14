// WP-24 · Phase 5 — Enterprise Document Engine Controlled Express Mount Descriptor.
//
// The fifth REAL implementation phase. It resolves the WP-24 Phase 4 live-handler activation
// descriptor and prepares an EXPRESS MOUNT DESCRIPTOR that a future server-integration phase will
// consume. IMPORTANT: this phase DOES NOT mount the handler, DOES NOT register routes, DOES NOT
// modify server.js, and DOES NOT create Express objects — runtime behaviour is 100% identical.
//
// The mount descriptor is inert: `ready:true`, `mounted:false`, `executed:false`, `registered:false`.
// It REUSES the existing activation descriptor, handler, controller, and services (no duplicated
// logic/composition). It NEVER executes the controller/handler/activation, NEVER opens a database
// connection, NEVER executes SQL/CRUD during construction, NEVER creates Express/HTTP objects, and
// registers no routes. The engine remains unreachable from production; enabled derives from the
// runtime feature flag, which is OFF while DOCUMENT_ENGINE_ENABLED is unset. It reads NO environment
// itself (only the runtime feature flag reads the environment). Stateless, deterministic,
// copy-on-read (fresh mount/status every call; the controller/service/handler references are
// intentionally shared), never throws, no globals, no singleton, no cache, no mutable state.
// UNWIRED — nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const liveHandlerActivationAdapter = require('./live-handler-activation-adapter');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isMountDescriptorEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh live-handler activation every call (delegates to the WP-24 Phase 4 adapter — the source
// of the reused activation descriptor + handler + controller + services). `db` is optional, for tests.
function getActivation(db) {
  return db === undefined
    ? liveHandlerActivationAdapter.createLiveHandlerActivation()
    : liveHandlerActivationAdapter.createLiveHandlerActivation({ db });
}

// Prepare the Express mount descriptor only — describes the future mount without mounting,
// executing, registering, or creating any Express object.
function createExpressMountDescriptor(options) {
  const opts = isPlainObject(options) ? options : {};
  const activation = 'db' in opts ? getActivation(opts.db) : getActivation();
  return {
    enabled: isMountDescriptorEnabled(),
    activation,
    mount: {
      ready: true,
      mounted: false,
      executed: false,
      registered: false,
      handler: activation.activation.handler,
      controller: activation.activation.controller,
      services: activation.activation.services,
    },
    status: {
      enabled: isMountDescriptorEnabled(),
      handlerReady: true,
      activationReady: true,
      mountReady: true,
      bound: true,
      composed: true,
      wired: false,
      registered: false,
      mounted: false,
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
    enabled: isMountDescriptorEnabled(),
    handlerReady: true,
    activationReady: true,
    mountReady: true,
    bound: true,
    composed: true,
    wired: false,
    registered: false,
    mounted: false,
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
    enabled: isMountDescriptorEnabled(),
    mountDescriptorAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'express-mount-descriptor', available: true },
    { name: 'live-handler-activation-adapter', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-24 Phase 6',
    description: 'Controlled Guarded Route Mount (staging only)',
    productionImpact: false,
  };
}

module.exports = {
  isMountDescriptorEnabled,
  getActivation,
  createExpressMountDescriptor,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
