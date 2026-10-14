// WP-20 · E1 — Enterprise Document Engine Feature Flag (integration-preparation layer).
//
// The first integration-preparation layer for controlled production integration of the Enterprise
// Document Engine. It DOES NOT wire the engine into production and changes NO production behaviour.
// Future WP-20 tasks use this flag to decide whether the engine is enabled; it defaults to OFF.
//
// Pure CommonJS, imports NOTHING: no Express, no database, no OS environment access, no
// filesystem, no runtime inspection, no server, no routes, no configuration loading. Stateless,
// deterministic, copy-on-read (fresh objects and arrays every call), never throws, no mutable
// globals, no singleton, no cache, no side effects. UNWIRED — nothing in production imports it.
'use strict';

// The flag is OFF, always. enable()/disable() are pure descriptors — they compute a value but
// hold NO module state, so isEnabled() can never become true through them.
function isEnabled() {
  return false;
}

// Pure descriptor of the "enabled" outcome. Does NOT modify any module state.
function enable() {
  return { enabled: true };
}

// Pure descriptor of the "disabled" outcome. Does NOT modify any module state.
function disable() {
  return { enabled: false };
}

// A fresh deterministic status object every call.
function getStatus() {
  return { enabled: false, mode: 'FOUNDATION', production: false };
}

// A fresh deterministic health object every call.
function health() {
  return { ready: true, enabled: false, safe: true };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'feature-flag', available: true },
    { name: 'foundation-mode', available: true },
    { name: 'production-disabled', available: true },
  ];
}

module.exports = {
  isEnabled,
  enable,
  disable,
  getStatus,
  health,
  capabilities,
};
