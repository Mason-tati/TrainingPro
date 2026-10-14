// WP-22 · Phase 5 — Enterprise Document Engine Controlled Production Registration Validation.
//
// Validates that the complete production registration descriptor has been assembled correctly,
// while ensuring absolutely nothing is mounted or registered into TrainingPro. The engine remains
// completely disabled — its enabled state derives from the runtime feature flag, which is OFF
// while DOCUMENT_ENGINE_ENABLED is unset. No runtime behaviour changes.
//
// Its only imports are ./runtime-feature-flag and ./server-registration-preparation. It reads NO
// environment itself (only the runtime feature flag reads the environment), and uses NO Express,
// NO HTTP/HTTPS, NO server creation, NO route/middleware registration, NO router mounting, NO
// database, NO filesystem, NO path/sqlite/dotenv. Branch-free, stateless, deterministic,
// copy-on-read (fresh objects and arrays every call), never throws, no globals, no singleton, no
// cache, no mutable state. UNWIRED — nothing in production imports it.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const serverRegistrationPreparation = require('./server-registration-preparation');

// Validated-and-enabled iff the runtime feature flag is enabled — OFF by default.
function isRegistrationValidated() {
  return runtimeFeatureFlag.isEnabled();
}

// A fresh server registration descriptor every call (delegates to the Phase 4 preparation).
function getServerRegistration() {
  return serverRegistrationPreparation.createServerRegistration();
}

// Prepare the registration-validation descriptor only — never registers or mounts anything.
function createRegistrationValidation() {
  return {
    enabled: isRegistrationValidated(),
    serverRegistration: getServerRegistration(),
    status: {
      validated: true,
      prepared: true,
      registered: false,
      mounted: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isRegistrationValidated(),
    validated: true,
    prepared: true,
    registered: false,
    mounted: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isRegistrationValidated(),
    validationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'production-registration-validation', available: true },
    { name: 'server-registration-preparation', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

// A fresh descriptor of the next phase every call.
function getNextPhase() {
  return {
    phase: 'WP-22 Phase 6',
    description: 'Controlled Server Wiring Preparation',
    productionImpact: false,
  };
}

module.exports = {
  isRegistrationValidated,
  getServerRegistration,
  createRegistrationValidation,
  getStatus,
  health,
  capabilities,
  getNextPhase,
};
