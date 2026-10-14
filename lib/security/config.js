// WP-13 · S1 — Security configuration skeleton (single source of truth).
//
// Infrastructure ONLY. This module exposes an immutable configuration object
// resolved from the environment at load time. It contains no Express code, no
// middleware, no logging, no database access, no network, no startup logic, and
// no side effects — and NOTHING in the application consumes it yet. Every default
// is chosen to preserve current production behaviour (all enforcement OFF; the
// session secret keeps its existing value).
'use strict';

// Existing production session secret — kept as the fallback so that, until an
// explicit SESSION_SECRET is provided, behaviour (and active sessions) are
// unchanged.
const DEFAULT_SESSION_SECRET = 'traintrack-secret-key-2024';

// ── Internal helpers (NOT exported) ─────────────────────────────────────────
// A boolean flag is ON only when the env value is the EXACT literal string
// "true" (case-sensitive, no trimming). If the variable is unset (undefined),
// the provided default applies. Anything else — "TRUE", "True", " true", "1",
// "yes", "on", "enabled", "false", blank — resolves to false.
function boolEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v === 'true';
}

// A string setting: returns the trimmed-non-blank env value, otherwise the
// fallback. Blank / whitespace-only / undefined / null all return the fallback.
function stringEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null) return fallback;
  return String(v).trim() === '' ? fallback : v;
}

// A positive-integer setting: returns the parsed value only when it is a finite
// positive integer; blank / invalid / ≤0 all fall back to the safe default.
function intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ── The single immutable security configuration object ──────────────────────
// Grouped by concern; every nested group is frozen as well as the root.
module.exports = Object.freeze({
  session: Object.freeze({
    // SESSION_SECRET — env override, else the current production secret.
    SESSION_SECRET: stringEnv('SESSION_SECRET', DEFAULT_SESSION_SECRET),
  }),
  cookies: Object.freeze({
    SECURE_COOKIES: boolEnv('SECURE_COOKIES', false),
  }),
  rateLimit: Object.freeze({
    RATE_LIMIT_ENFORCE: boolEnv('RATE_LIMIT_ENFORCE', false),
    // Generous, behaviour-preserving login-throttle defaults (S3). Invalid /
    // blank / ≤0 values fall back to these.
    RATE_LIMIT_LOGIN_MAX_ATTEMPTS: intEnv('RATE_LIMIT_LOGIN_MAX_ATTEMPTS', 10),
    RATE_LIMIT_LOGIN_WINDOW_MS: intEnv('RATE_LIMIT_LOGIN_WINDOW_MS', 15 * 60 * 1000),
    RATE_LIMIT_LOGIN_BLOCK_MS: intEnv('RATE_LIMIT_LOGIN_BLOCK_MS', 15 * 60 * 1000),
  }),
  errors: Object.freeze({
    GENERIC_ERROR_RESPONSES: boolEnv('GENERIC_ERROR_RESPONSES', false),
  }),
  headers: Object.freeze({
    ENABLE_SECURITY_HEADERS: boolEnv('ENABLE_SECURITY_HEADERS', false),
    ENABLE_CSP: boolEnv('ENABLE_CSP', false),
    CSP_REPORT_ONLY: boolEnv('CSP_REPORT_ONLY', true),
    ENABLE_HSTS: boolEnv('ENABLE_HSTS', false),
  }),
  proxy: Object.freeze({
    TRUST_PROXY: boolEnv('TRUST_PROXY', false),
  }),
  uploads: Object.freeze({
    ENABLE_UPLOAD_VALIDATION: boolEnv('ENABLE_UPLOAD_VALIDATION', false),
  }),
  password: Object.freeze({
    ENABLE_PASSWORD_POLICY: boolEnv('ENABLE_PASSWORD_POLICY', false),
  }),
  admin: Object.freeze({
    // Report-only default-admin detection is the only control enabled by default
    // (S4 will log a warning; it never blocks login).
    ENABLE_DEFAULT_ADMIN_WARNING: boolEnv('ENABLE_DEFAULT_ADMIN_WARNING', true),
  }),
});
