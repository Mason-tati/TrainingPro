// WP-18 · E15 — Document access history (Enterprise Document Engine).
//
// An ordered, in-memory log of access events: append/replace/remove, find (by key / latest /
// previous / next), list, compare, validate, normalize, clone, freeze. Delegates per-access
// work to the sibling access manager. Deterministic, never throws, never mutates caller
// objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-access-manager');

const HISTORY_FIELDS = ['accessId', 'accessType', 'access', 'metadata', 'futureReserved'];

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

// A stable key for an access event: accessId, else status, else principal.
function accessKey(x) {
  const s = obj(x);
  const key = pickString(s.accessId, s.status, s.principal);
  return (key === undefined) ? '' : key;
}

// Order by insertion (stable): access events have no timestamp field.
function orderAccess(h) {
  return h.access
    .map((x, i) => [x, i])
    .sort((a, b) => (a[1] - b[1]))
    .map((p) => p[0]);
}

function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map((x) => manager.createAccess(x));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    accessId: (typeof src.accessId === 'string') ? src.accessId : ((src.accessId === undefined || src.accessId === null) ? null : src.accessId),
    accessType: (typeof src.accessType === 'string' && src.accessType !== '') ? src.accessType : 'NONE',
    access: normalizeList(src.access),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listAccess(history) { return createHistory(history).access; }

function appendAccess(history, access) {
  const h = createHistory(history);
  h.access = h.access.concat([manager.createAccess(access)]);
  return h;
}

function replaceAccess(history, key, access) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createAccess(access);
  h.access = h.access.map((x) => (accessKey(x) === target ? replacement : x));
  return h;
}

function removeAccess(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.access = h.access.filter((x) => accessKey(x) !== target);
  return h;
}

function findAccess(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.access.find((x) => accessKey(x) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.access.length === 0) return null;
  const sorted = orderAccess(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderAccess(h);
  const idx = sorted.findIndex((x) => accessKey(x) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderAccess(h);
  const idx = sorted.findIndex((x) => accessKey(x) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const x of ha.access) mapA.set(accessKey(x), x);
  for (const x of hb.access) mapB.set(accessKey(x), x);
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
  const result = { valid: true, errors: [], warnings: [], duplicateAccess: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const access = Array.isArray(history.access) ? history.access : [];
  if (!Array.isArray(history.access)) {
    result.errors.push({ field: 'access', code: 'INVALID_ACCESS_LIST', message: 'access must be an array' });
  }
  const present = new Set();
  for (const x of access) {
    const key = accessKey(x);
    if (present.has(key)) { if (!result.duplicateAccess.includes(key)) result.duplicateAccess.push(key); }
    present.add(key);
    const vv = manager.validateAccess(x);
    for (const e of vv.errors) result.errors.push({ field: `access[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `access[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateAccess.length > 0) {
    result.errors.push({ field: 'access', code: 'DUPLICATE_ACCESS', message: `duplicate access: ${result.duplicateAccess.join(', ')}` });
  }
  result.duplicateAccess.sort();
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
    accessId: h.accessId,
    accessType: h.accessType,
    access: h.access.map((x) => manager.normalizeAccess(x)),
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
  appendAccess,
  replaceAccess,
  removeAccess,
  findAccess,
  findLatest,
  findPrevious,
  findNext,
  listAccess,
  compareHistory,
  validateHistory,
  normalizeHistory,
  cloneHistory,
  freezeHistory,
};
