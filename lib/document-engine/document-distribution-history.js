// WP-18 · E13 — Document distribution history (Enterprise Document Engine).
//
// An ordered, in-memory log of distribution events: append/replace/remove, find (by key /
// latest / previous / next), list, compare, validate, normalize, clone, freeze. Delegates
// per-distribution work to the sibling distribution manager. Deterministic, never throws,
// never mutates caller objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-distribution-manager');

const HISTORY_FIELDS = ['distributionId', 'mode', 'distributions', 'metadata', 'futureReserved'];

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

// A stable key for a distribution event: distributionId, else status, else mode.
function distributionKey(d) {
  const s = obj(d);
  const key = pickString(s.distributionId, s.status, s.mode);
  return (key === undefined) ? '' : key;
}
// Order by insertion (stable): distribution events have no timestamp field.
function orderDistributions(h) {
  return h.distributions
    .map((d, i) => [d, i])
    .sort((a, b) => (a[1] - b[1]))
    .map((p) => p[0]);
}

function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map((d) => manager.createDistribution(d));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    distributionId: (typeof src.distributionId === 'string') ? src.distributionId : ((src.distributionId === undefined || src.distributionId === null) ? null : src.distributionId),
    mode: (typeof src.mode === 'string' && src.mode !== '') ? src.mode : 'NONE',
    distributions: normalizeList(src.distributions),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listDistributions(history) { return createHistory(history).distributions; }

function appendDistribution(history, distribution) {
  const h = createHistory(history);
  h.distributions = h.distributions.concat([manager.createDistribution(distribution)]);
  return h;
}

function replaceDistribution(history, key, distribution) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createDistribution(distribution);
  h.distributions = h.distributions.map((d) => (distributionKey(d) === target ? replacement : d));
  return h;
}

function removeDistribution(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.distributions = h.distributions.filter((d) => distributionKey(d) !== target);
  return h;
}

function findDistribution(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.distributions.find((d) => distributionKey(d) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.distributions.length === 0) return null;
  const sorted = orderDistributions(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderDistributions(h);
  const idx = sorted.findIndex((d) => distributionKey(d) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderDistributions(h);
  const idx = sorted.findIndex((d) => distributionKey(d) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const d of ha.distributions) mapA.set(distributionKey(d), d);
  for (const d of hb.distributions) mapB.set(distributionKey(d), d);
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
  const result = { valid: true, errors: [], warnings: [], duplicateDistributions: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const distributions = Array.isArray(history.distributions) ? history.distributions : [];
  if (!Array.isArray(history.distributions)) {
    result.errors.push({ field: 'distributions', code: 'INVALID_DISTRIBUTIONS', message: 'distributions must be an array' });
  }
  const present = new Set();
  for (const d of distributions) {
    const key = distributionKey(d);
    if (present.has(key)) { if (!result.duplicateDistributions.includes(key)) result.duplicateDistributions.push(key); }
    present.add(key);
    const vv = manager.validateDistribution(d);
    for (const e of vv.errors) result.errors.push({ field: `distributions[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `distributions[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateDistributions.length > 0) {
    result.errors.push({ field: 'distributions', code: 'DUPLICATE_DISTRIBUTION', message: `duplicate distributions: ${result.duplicateDistributions.join(', ')}` });
  }
  result.duplicateDistributions.sort();
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
    distributionId: h.distributionId,
    mode: h.mode,
    distributions: h.distributions.map((d) => manager.normalizeDistribution(d)),
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
  appendDistribution,
  replaceDistribution,
  removeDistribution,
  findDistribution,
  findLatest,
  findPrevious,
  findNext,
  listDistributions,
  compareHistory,
  validateHistory,
  normalizeHistory,
  cloneHistory,
  freezeHistory,
};
