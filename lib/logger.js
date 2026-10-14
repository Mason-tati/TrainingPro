// WP-08 · L1 — Structured, privacy-safe logging utility (dependency-free).
//
// Emits one JSON object per line to stdout/stderr (JSON Lines) for observability
// tooling, with a redaction-first design so secrets and sensitive data can never
// be logged. This commit provides the utility only — it is NOT wired into the app
// (no middleware, no route changes). Levels, clock, and sink are injectable so
// tests are deterministic and never pollute the test runner's output.
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const requestContext = require('./request-context');
const schema = require('./log-schema');
const pkg = require('../package.json');

// Severity order (lower number = more severe) — used only for level gating.
// The emitted record uses the UPPERCASE schema level (DEBUG/INFO/WARN/ERROR/FATAL).
const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 };
const DEFAULT_LEVEL = 'info';
const HOST = os.hostname();
const APP_VERSION = pkg.version || '0.0.0';

// ---- configurable state (overridable for tests via the __ helpers) ----
let currentLevel = normaliseLevel(process.env.LOG_LEVEL) || DEFAULT_LEVEL;
let clock = () => new Date().toISOString();
let sink = defaultSink;
const pretty = process.env.LOG_FORMAT === 'pretty';

function normaliseLevel(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  if (n === 'silent' || n === 'off' || n === 'none') return 'silent';
  return n in LEVELS ? n : null;
}

// ---- redaction ---------------------------------------------------------
const MASK = '[REDACTED]';
// Keys whose values are ALWAYS removed (case-insensitive, exact match on the key).
const DENY_KEYS = new Set([
  'password', 'pass', 'hashpass', 'prevpswd', 'secret', 'sessionsecret',
  'sid', 'sessionid', 'cookie', 'authorization', 'apikey', 'anthropic_api_key',
  'openai_api_key', 'token', 'accesstoken', 'refreshtoken', 'bearer',
  'prompt', 'completion', 'aiinput', 'aioutput',
  'ss', 'dob', 'medical', 'restrictions', 'disciplinary', 'filedata', 'base64',
]);
const MAX_STRING = 500;

function maskString(s) {
  let out = s;
  // API keys / bearer tokens / JWT-like blobs
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, MASK);
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer ' + MASK);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, MASK);
  // Emails → keep first char + domain
  out = out.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***$2');
  // Long digit runs (phone/SSN-like, 7+ digits) → keep last 2
  out = out.replace(/\b\d{5,}(\d{2})\b/g, (m, last2) => '***' + last2);
  if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + `…(truncated ${out.length - MAX_STRING})`;
  return out;
}

// Deep-redact a value: drop deny-listed keys, mask sensitive string patterns,
// truncate long strings. Safe against cycles. Never throws.
function redact(input, seen = new WeakSet()) {
  try {
    if (input == null) return input;
    if (typeof input === 'string') return maskString(input);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return input.toString();
    if (input instanceof Error) return { name: input.name, message: maskString(String(input.message || '')) };
    if (Array.isArray(input)) {
      if (seen.has(input)) return '[Circular]';
      seen.add(input);
      return input.map((v) => redact(v, seen));
    }
    if (typeof input === 'object') {
      if (seen.has(input)) return '[Circular]';
      seen.add(input);
      const out = {};
      for (const [k, v] of Object.entries(input)) {
        if (DENY_KEYS.has(k.toLowerCase())) { out[k] = MASK; continue; }
        out[k] = redact(v, seen);
      }
      return out;
    }
    return String(input);
  } catch {
    return MASK; // fail safe: never leak on redaction error
  }
}

// ---- record construction + emit ---------------------------------------
function isEnabled(level) {
  if (currentLevel === 'silent') return false;
  return LEVELS[level] <= LEVELS[currentLevel];
}

// Build a full enterprise-schema record (L2.5). Caller `fields` become redacted
// `metadata`; `fields.message` (or a string `fields`) becomes the top-level
// message. Correlation fields are read from the active request context (L2),
// falling back to schema defaults outside HTTP. The record is validated and
// normalised before return so the logger only ever emits conforming records.
function createLogRecord(level, event, fields) {
  const ctx = requestContext.get() || {};

  let message = '';
  let metaSource = {};
  if (typeof fields === 'string') {
    message = fields;
  } else if (fields && typeof fields === 'object') {
    if (typeof fields.message === 'string') message = fields.message;
    const { message: _omit, ...rest } = fields;
    metaSource = rest;
  }

  const record = {
    schemaVersion: schema.SCHEMA_VERSION,
    timestamp: clock(),
    level: String(level).toUpperCase(),
    event: typeof event === 'string' ? event : String(event),
    message,
    module: ctx.module != null ? ctx.module : 'System',
    tenantId: ctx.tenantId !== undefined ? (ctx.tenantId === undefined ? null : ctx.tenantId) : null,
    requestId: ctx.requestId != null ? ctx.requestId : null,
    actor: ctx.actor != null ? ctx.actor : 'anonymous',
    environment: process.env.NODE_ENV || 'development',
    version: APP_VERSION,
    build: process.env.BUILD_ID || 'dev',
    host: HOST,
    pid: process.pid,
    metadata: redact(metaSource),
  };

  // Validate + normalise; the logger always emits the normalised record and never
  // throws, so a malformed context can never crash the app.
  return schema.validateLogRecord(record).record;
}

function format(record) {
  return pretty ? JSON.stringify(record, null, 2) : JSON.stringify(record);
}

function defaultSink(record) {
  const line = format(record) + '\n';
  if (record.level === 'error' || record.level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

function log(level, event, fields) {
  if (!(level in LEVELS)) level = 'info';
  if (!isEnabled(level)) return;
  const record = createLogRecord(level, event, fields);
  try { sink(record); } catch { /* logging must never break the app */ }
}

// ---- WP-08 L6: AI / DB boundary placeholders ----------------------------
// Helper methods for FUTURE AI and database logging (WP-10 / DB work). They are
// defined and proven safe now but are NOT wired into any production code path.
// Both use a strict metadata ALLOW-LIST, so forbidden content (prompts, AI
// output, SQL, params, connection strings, secrets) is discarded by
// construction — then the normal pipeline (redaction + schema validation +
// request context) applies on top.
const AI_ALLOWED_FIELDS = new Set([
  'provider', 'model', 'agent', 'operation', 'inputTokens', 'outputTokens',
  'totalTokens', 'costUsd', 'status', 'decisionStatus', 'approvedBy',
  'durationMs', 'errorName', 'errorMessage',
  // WP-11 P1 — report-only policy-engine metadata (additive; no content).
  'policyVersion', 'policyMode', 'estimatedTokens',
]);
const DB_ALLOWED_FIELDS = new Set([
  'operation', 'table', 'entity', 'errorName', 'errorMessage', 'durationMs',
  'retryable', 'status',
]);

function pickAllowed(fields, allowed, defaultMessage) {
  const out = { message: defaultMessage };
  if (fields && typeof fields === 'object') {
    if (typeof fields.message === 'string') out.message = fields.message;
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.has(k)) out[k] = v; // everything else (prompt, sql, …) is discarded
    }
  }
  return out;
}

// Run the emit with the record's module forced, preserving requestId/actor/tenant
// from any active context. Never throws.
function logWithModule(moduleName, level, event, safeFields) {
  try {
    const ctx = requestContext.get() || {};
    requestContext.run({ ...ctx, module: moduleName }, () => log(level, event, safeFields));
  } catch { /* logging must never crash the app */ }
}

// ---- public API --------------------------------------------------------
module.exports = {
  LEVELS,
  fatal: (event, fields) => log('fatal', event, fields),
  error: (event, fields) => log('error', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  info: (event, fields) => log('info', event, fields),
  debug: (event, fields) => log('debug', event, fields),
  redact,
  format,
  // WP-08 L6 — AI boundary placeholder (module=AI; metadata allow-list; never
  // prompts/completions/AI text). Not wired into production yet.
  aiEvent: (event, fields) =>
    logWithModule('AI', 'info', event, pickAllowed(fields, AI_ALLOWED_FIELDS, 'AI event')),
  // WP-08 L6 — DB boundary placeholder (module=Infrastructure; metadata
  // allow-list; never SQL/params/connection strings). Not wired yet.
  dbError: (event, fields) =>
    logWithModule('Infrastructure', 'error', event, pickAllowed(fields, DB_ALLOWED_FIELDS, 'Database operation failed')),
  // Re-export the schema validator for convenience (canonical home: log-schema.js).
  validateLogRecord: schema.validateLogRecord,
  // Generate a new correlation id (used by the request-correlation middleware).
  generateRequestId: () => crypto.randomUUID(),
  // Test/host seams (do not use in production code paths):
  __setSink(fn) { const prev = sink; sink = typeof fn === 'function' ? fn : defaultSink; return prev; },
  __resetSink() { sink = defaultSink; },
  __setClock(fn) { const prev = clock; clock = typeof fn === 'function' ? fn : clock; return prev; },
  __setLevel(name) { const prev = currentLevel; currentLevel = normaliseLevel(name) || DEFAULT_LEVEL; return prev; },
  __getLevel() { return currentLevel; },
};
