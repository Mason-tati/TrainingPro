// WP-18 · E17 — Document compliance manager (Enterprise Document Engine).
//
// Evaluates document compliance objects and lifecycle state entirely in memory. It performs
// NO auditing, NO reporting, NO document updates, and NO persistence — it only resolves a
// compliance object against its framework and produces deterministic compliance objects.
// Framework-aware via the WP-17 compliance registry (its only import). Deterministic, never
// throws, never mutates callers, deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentCompliance, isKnownDocumentCompliance } = require('../document/document-compliance');

const COMPLIANCE_STATES = ['PENDING', 'COMPLIANT', 'NON_COMPLIANT', 'UNDER_REVIEW', 'WAIVED', 'EXPIRED', 'UNKNOWN'];
const STATE_SET = new Set(COMPLIANCE_STATES);
const REQUIRES_FLAGS = ['requiresDocumentControl', 'requiresVersionControl', 'requiresApproval', 'requiresReview', 'requiresAudit', 'requiresRetention', 'requiresTraining', 'requiresReadAcknowledgement'];

const COMPLIANCE_FIELDS = [
  ['complianceId', 'string'],
  ['framework', 'string'],
  ['status', 'string'],
  ['requiresDocumentControl', 'bool'],
  ['requiresVersionControl', 'bool'],
  ['requiresApproval', 'bool'],
  ['requiresReview', 'bool'],
  ['requiresAudit', 'bool'],
  ['requiresRetention', 'bool'],
  ['requiresTraining', 'bool'],
  ['requiresReadAcknowledgement', 'bool'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-compliance.v1';

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function pickString(...args) { for (const a of args) if (typeof a === 'string' && a !== '') return a; return undefined; }

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
    return out;
  }
  return value;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!hasOwn(b, k)) return false; if (!deepEqual(a[k], b[k])) return false; }
    return true;
  }
  return false;
}
function deepFreeze(value) {
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  if (isPlainObject(value)) { for (const k of Object.keys(value)) deepFreeze(value[k]); return Object.freeze(value); }
  return value;
}
function canon(x) { return (x !== null && typeof x === 'object') ? JSON.stringify(x) : `${typeof x}:${String(x)}`; }
function uniqDeep(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { const k = canon(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
function normalizeAny(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return normalizeArray(v);
  if (isPlainObject(v)) return normalizeObject(v);
  return v;
}
function normalizeArray(arr) {
  const mapped = arr.map(normalizeAny).filter((x) => x !== '');
  return uniqDeep(mapped).map((x) => [canon(x), x]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((p) => p[1]);
}
function normalizeObject(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = normalizeAny(o[k]);
  return out;
}

function coerce(kind, val) {
  if (kind === 'string') return (val === undefined || val === null) ? '' : String(val);
  if (kind === 'bool') return val === true;
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

// ---- public ----

function createCompliance(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const a = {};
  for (const [name, kind] of COMPLIANCE_FIELDS) a[name] = coerce(kind, src[name]);
  const frameworkId = pickString(src.framework, opts.framework, opts.defaultFramework);
  a.framework = (frameworkId === undefined) ? 'NONE' : frameworkId;
  const mode = getDocumentCompliance(a.framework);
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  a.status = (statusId === undefined) ? 'PENDING' : statusId;
  // framework-controlled flags default from the framework unless explicitly provided
  for (const flag of REQUIRES_FLAGS) { if (!hasOwn(src, flag)) a[flag] = mode[flag]; }
  return a;
}

function cloneCompliance(compliance) { return deepClone(obj(compliance)); }
function freezeCompliance(compliance) { return deepFreeze(deepClone(obj(compliance))); }

// Re-derive every framework-controlled flag from the framework (removes drift).
function evaluateCompliance(compliance) {
  const c = createCompliance(compliance);
  const mode = getDocumentCompliance(c.framework);
  for (const flag of REQUIRES_FLAGS) c[flag] = mode[flag];
  return c;
}

function transition(compliance, targetStatus) {
  const cur = createCompliance(compliance);
  if (cur.status === 'EXPIRED') return { valid: false, errors: [{ field: 'status', code: 'NOT_MODIFIABLE', message: 'compliance has expired' }], warnings: [], compliance: cur };
  const next = cloneCompliance(cur);
  next.status = targetStatus;
  return { valid: true, errors: [], warnings: [], compliance: next };
}

function markCompliant(compliance) { return transition(compliance, 'COMPLIANT'); }
function markNonCompliant(compliance) { return transition(compliance, 'NON_COMPLIANT'); }
function waiveCompliance(compliance) { return transition(compliance, 'WAIVED'); }

function expireCompliance(compliance) {
  const cur = createCompliance(compliance);
  if (cur.status === 'EXPIRED') return { valid: false, errors: [{ field: 'status', code: 'ALREADY_EXPIRED', message: 'compliance is already expired' }], warnings: [], compliance: cur };
  const next = cloneCompliance(cur);
  next.status = 'EXPIRED';
  return { valid: true, errors: [], warnings: [], compliance: next };
}

function validateCompliance(compliance) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(compliance)) {
    result.errors.push({ field: null, code: 'INVALID_COMPLIANCE', message: 'compliance must be a plain object' });
    result.valid = false;
    return result;
  }
  const frameworkId = (typeof compliance.framework === 'string') ? compliance.framework.trim() : '';
  if (frameworkId !== '' && !isKnownDocumentCompliance(frameworkId)) result.warnings.push({ field: 'framework', code: 'UNKNOWN_FRAMEWORK', message: `unknown framework: ${frameworkId}` });

  const status = (typeof compliance.status === 'string') ? compliance.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!STATE_SET.has(status)) result.errors.push({ field: 'status', code: 'INVALID_STATUS', message: `invalid status: ${status}` });

  for (const flag of REQUIRES_FLAGS) {
    if (hasOwn(compliance, flag) && typeof compliance[flag] !== 'boolean') {
      result.errors.push({ field: flag, code: 'INVALID_BOOLEAN', message: `${flag} must be a boolean` });
    }
  }
  if (Array.isArray(compliance.futureReserved) && uniqDeep(compliance.futureReserved).length !== compliance.futureReserved.length) {
    result.warnings.push({ field: 'futureReserved', code: 'DUPLICATE_ENTRY', message: 'futureReserved contains duplicates' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeCompliance(compliance) {
  const c = createCompliance(compliance);
  for (const [name, kind] of COMPLIANCE_FIELDS) {
    if (kind === 'string' && typeof c[name] === 'string') c[name] = c[name].trim();
    else if (kind === 'object') c[name] = normalizeObject(c[name]);
    else if (kind === 'array') c[name] = normalizeArray(c[name]);
  }
  return c;
}

function mergeCompliance(base, incoming, options) {
  const opts = obj(options);
  const strategy = (opts.strategy === 'keepExisting') ? 'keepExisting' : 'overwrite';
  const arrays = opts.arrays || 'replace';
  const objects = opts.objects || 'replace';
  const out = deepClone(obj(base));
  const inc = deepClone(obj(incoming));
  for (const key of Object.keys(inc)) {
    const iv = inc[key];
    if (!hasOwn(out, key)) { out[key] = iv; continue; }
    const bv = out[key];
    if (Array.isArray(bv) && Array.isArray(iv)) {
      if (arrays === 'append') out[key] = bv.concat(iv);
      else if (arrays === 'union') out[key] = uniqDeep(bv.concat(iv));
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else if (isPlainObject(bv) && isPlainObject(iv)) {
      if (objects === 'merge') out[key] = mergeCompliance(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareCompliance(a, b) {
  const A = obj(a);
  const B = obj(b);
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];
  for (const k of keys) {
    const inA = hasOwn(A, k);
    const inB = hasOwn(B, k);
    if (inA && !inB) removed.push(k);
    else if (!inA && inB) added.push(k);
    else if (deepEqual(A[k], B[k])) unchanged.push(k);
    else modified.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(), unchanged: unchanged.sort() };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (`0000000${h.toString(16)}`).slice(-8);
}

function generateComplianceSnapshot(compliance) {
  const normalized = normalizeCompliance(compliance);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), compliance: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createCompliance,
  markCompliant,
  markNonCompliant,
  waiveCompliance,
  expireCompliance,
  validateCompliance,
  normalizeCompliance,
  cloneCompliance,
  freezeCompliance,
  mergeCompliance,
  compareCompliance,
  generateComplianceSnapshot,
  evaluateCompliance,
};
