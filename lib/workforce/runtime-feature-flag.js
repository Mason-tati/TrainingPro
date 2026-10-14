// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Runtime Feature Flag.
//
// The SINGLE SOURCE OF TRUTH for whether the Enterprise Workforce Platform is enabled, and the ONLY
// module that reads process.env for this decision. It DEFAULTS OFF: the platform is enabled only when
// the environment variable WORKFORCE_ENGINE_ENABLED is explicitly set to an enabling value.
//
// Accepted enabling values (case-insensitive, surrounding whitespace ignored): "true", "1". Any other
// value — "false", "0", "", unexpected strings — or a missing variable → OFF.
//
// This module does NOT wire the platform into anything: nothing imports it in production, so no
// behaviour changes and the platform stays disabled. Imports NOTHING. Stateless (reads the environment
// live every call — no caching, no module state, no globals), deterministic for a given environment,
// copy-on-read (fresh objects every call), never throws, pure. UNWIRED.
'use strict';

const VARIABLE = 'WORKFORCE_ENGINE_ENABLED';
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
    return DEFAULT_ENABLED;
  }
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1';
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    variable: VARIABLE,
    enabled: isEnabled(),
    configured: isConfigured(),
    mounted: false,
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

module.exports = {
  VARIABLE,
  rawValue,
  isConfigured,
  isEnabled,
  getStatus,
  health,
};
