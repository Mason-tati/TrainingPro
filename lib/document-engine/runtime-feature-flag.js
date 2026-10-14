// WP-22 · Phase 1 — Enterprise Document Engine Runtime Feature Flag (production-ready).
//
// The production-ready replacement for the structurally-OFF development flag. It is the SINGLE
// SOURCE OF TRUTH for whether the Enterprise Document Engine is enabled, and the ONLY module that
// reads process.env for this decision. It DEFAULTS OFF: the engine is enabled only when the
// environment variable DOCUMENT_ENGINE_ENABLED is explicitly set to an enabling value.
//
// Accepted enabling values (case-insensitive, surrounding whitespace ignored): "true", "1".
// Any other value — "false", "0", "", unexpected strings — or a missing variable → OFF.
//
// This phase does NOT wire the flag into anything: nothing imports it yet, so no behaviour changes
// and the engine stays disabled. Imports NOTHING (no helper libraries). Stateless (reads the
// environment live every call — no caching, no module state, no globals), deterministic for a
// given environment, copy-on-read (fresh objects and arrays every call), never throws, pure.
// UNWIRED — nothing in production imports it.
'use strict';

const VARIABLE = 'DOCUMENT_ENGINE_ENABLED';
const DEFAULT_ENABLED = false;

// The raw environment value (string) or undefined when unset. The ONLY process.env read.
function rawValue() {
  return process.env[VARIABLE];
}

// Whether the environment variable exists at all (regardless of its value).
function isConfigured() {
  return rawValue() !== undefined;
}

// Enabled ONLY when the variable is explicitly set to an enabling value; OFF by default.
function isEnabled() {
  const raw = rawValue();
  if (typeof raw !== 'string') {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1';
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isEnabled(),
    configured: isConfigured(),
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isEnabled(),
    configured: isConfigured(),
    safe: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-feature-flag', available: true },
    { name: 'environment-configuration', available: true },
    { name: 'foundation-mode', available: true },
    { name: 'production-disabled', available: true },
  ];
}

// A fresh deterministic configuration descriptor every call.
function getConfiguration() {
  return {
    variable: VARIABLE,
    configured: isConfigured(),
    enabled: isEnabled(),
    default: DEFAULT_ENABLED,
  };
}

module.exports = {
  isEnabled,
  isConfigured,
  getStatus,
  health,
  capabilities,
  getConfiguration,
};
