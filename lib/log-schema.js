// WP-08 · L2.5 — Enterprise log schema + validator (dependency-free).
//
// Defines the approved log-record schema and a reusable validator. The validator
// NORMALISES recoverable fields (message, actor, metadata) and REJECTS impossible
// states (bad schemaVersion, level, module, timestamp, requestId, tenantId). It
// never throws — logging must never crash the app.
'use strict';

const SCHEMA_VERSION = 1;

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_SET = new Set(LEVELS);

const MODULES = [
  'System', 'Authentication', 'Administration', 'Training', 'Competency',
  'Compliance', 'Documents', 'Translation', 'AI', 'Analytics', 'Reporting',
  'Workflow', 'Examination', 'Forms', 'Infrastructure', 'Integration', 'Workforce',
];
const MODULE_SET = new Set(MODULES);

// ISO-8601 UTC (must end in Z), millisecond precision optional.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function isValidIsoUtc(s) {
  return typeof s === 'string' && ISO_UTC_RE.test(s) && !Number.isNaN(Date.parse(s));
}

// Validate a log record. Returns { valid, errors, record } where `record` has any
// recoverable fields normalised. Never throws.
function validateLogRecord(input) {
  const errors = [];
  const isObj = input && typeof input === 'object' && !Array.isArray(input);
  if (!isObj) errors.push('record must be a non-null object');
  const r = isObj ? { ...input } : {};

  // --- rejected (impossible) states ---
  if (!('schemaVersion' in r)) errors.push('schemaVersion missing');
  else if (r.schemaVersion !== SCHEMA_VERSION) errors.push(`unsupported schemaVersion: ${r.schemaVersion}`);

  if (!LEVEL_SET.has(r.level)) errors.push(`invalid level: ${r.level}`);

  if (typeof r.event !== 'string' || r.event.length === 0) errors.push('invalid event');

  if (!MODULE_SET.has(r.module)) errors.push(`unknown module: ${r.module}`);

  if (!isValidIsoUtc(r.timestamp)) errors.push('invalid timestamp');

  if (!(r.requestId === null || (typeof r.requestId === 'string' && r.requestId.length > 0))) {
    errors.push('invalid requestId');
  }

  if (!(r.tenantId === null || typeof r.tenantId === 'string')) errors.push('invalid tenantId');

  // --- normalised (recoverable) fields — always applied ---
  if (typeof r.message !== 'string') r.message = (r.message === undefined || r.message === null) ? '' : String(r.message);
  if (typeof r.actor !== 'string') r.actor = 'anonymous';
  if (r.metadata === undefined || r.metadata === null || typeof r.metadata !== 'object' || Array.isArray(r.metadata)) {
    r.metadata = {};
  }

  return { valid: errors.length === 0, errors, record: r };
}

module.exports = { SCHEMA_VERSION, LEVELS, MODULES, isValidIsoUtc, validateLogRecord };
