// WP-18 · E17 — Document compliance history (Enterprise Document Engine).
//
// An ordered, in-memory log of compliance events: append/replace/remove, find (by key /
// latest / previous / next), list, compare, validate, normalize, clone, freeze. Delegates
// per-compliance work to the sibling compliance manager. Deterministic, never throws, never
// mutates caller objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-compliance-manager');

const HISTORY_FIELDS = ['complianceId', 'framework', 'compliance', 'metadata', 'futureReserved'];

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

// A stable key for a compliance event: complianceId, else status, else framework.
function complianceKey(x) {
  const s = obj(x);
  const key = pickString(s.complianceId, s.status, s.framework);
  return (key === undefined) ? '' : key;
}

// Order by insertion (stable): compliance events have no timestamp field.
function orderCompliance(h) {
  return h.compliance
    .map((x, i) => [x, i])
    .sort((a, b) => (a[1] - b[1]))
    .map((p) => p[0]);
}

function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map((x) => manager.createCompliance(x));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    complianceId: (typeof src.complianceId === 'string') ? src.complianceId : ((src.complianceId === undefined || src.complianceId === null) ? null : src.complianceId),
    framework: (typeof src.framework === 'string' && src.framework !== '') ? src.framework : 'NONE',
    compliance: normalizeList(src.compliance),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listCompliance(history) { return createHistory(history).compliance; }

function appendCompliance(history, compliance) {
  const h = createHistory(history);
  h.compliance = h.compliance.concat([manager.createCompliance(compliance)]);
  return h;
}

function replaceCompliance(history, key, compliance) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createCompliance(compliance);
  h.compliance = h.compliance.map((x) => (complianceKey(x) === target ? replacement : x));
  return h;
}

function removeCompliance(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.compliance = h.compliance.filter((x) => complianceKey(x) !== target);
  return h;
}

function findCompliance(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.compliance.find((x) => complianceKey(x) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.compliance.length === 0) return null;
  const sorted = orderCompliance(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderCompliance(h);
  const idx = sorted.findIndex((x) => complianceKey(x) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderCompliance(h);
  const idx = sorted.findIndex((x) => complianceKey(x) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const x of ha.compliance) mapA.set(complianceKey(x), x);
  for (const x of hb.compliance) mapB.set(complianceKey(x), x);
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];
  for (const k of keys) {
    const inA = mapA.has(k);
    const inB = mapB.has(k);
    if (inA && !inB) removed.push(k);
    else if (!inA && inB) added.push(k);
    else if (deepEqual(mapA.get(k), mapB.get(k))) unchanged.push(k);
    else modified.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(), unchanged: unchanged.sort() };
}

function validateHistory(history) {
  const result = { valid: true, errors: [], warnings: [], duplicateCompliance: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const compliance = Array.isArray(history.compliance) ? history.compliance : [];
  if (!Array.isArray(history.compliance)) {
    result.errors.push({ field: 'compliance', code: 'INVALID_COMPLIANCE_LIST', message: 'compliance must be an array' });
  }
  const present = new Set();
  for (const x of compliance) {
    const key = complianceKey(x);
    if (present.has(key)) { if (!result.duplicateCompliance.includes(key)) result.duplicateCompliance.push(key); }
    present.add(key);
    const vv = manager.validateCompliance(x);
    for (const e of vv.errors) result.errors.push({ field: `compliance[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `compliance[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateCompliance.length > 0) {
    result.errors.push({ field: 'compliance', code: 'DUPLICATE_COMPLIANCE', message: `duplicate compliance: ${result.duplicateCompliance.join(', ')}` });
  }
  result.duplicateCompliance.sort();
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeMeta(m) {
  const out = {};
  for (const k of Object.keys(obj(m)).sort()) { const v = m[k]; out[k] = (typeof v === 'string') ? v.trim() : deepClone(v); }
  return out;
}

function normalizeHistory(history) {
  const h = createHistory(history);
  const built = {
    complianceId: h.complianceId,
    framework: h.framework,
    compliance: h.compliance.map((x) => manager.normalizeCompliance(x)),
    metadata: normalizeMeta(h.metadata),
    futureReserved: deepClone(h.futureReserved),
  };
  const out = {};
  for (const name of HISTORY_FIELDS) out[name] = built[name];
  return out;
}

function cloneHistory(history) { return deepClone(obj(history)); }
function freezeHistory(history) { return deepFreeze(deepClone(obj(history))); }

module.exports = {
  createHistory,
  appendCompliance,
  replaceCompliance,
  removeCompliance,
  findCompliance,
  findLatest,
  findPrevious,
  findNext,
  listCompliance,
  compareHistory,
  validateHistory,
  normalizeHistory,
  cloneHistory,
  freezeHistory,
};
