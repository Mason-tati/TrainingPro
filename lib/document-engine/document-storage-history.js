// WP-18 · E16 — Document storage history (Enterprise Document Engine).
//
// An ordered, in-memory log of storage events: append/replace/remove, find (by key / latest /
// previous / next), list, compare, validate, normalize, clone, freeze. Delegates per-storage
// work to the sibling storage manager. Deterministic, never throws, never mutates caller
// objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-storage-manager');

const HISTORY_FIELDS = ['storageId', 'storageType', 'storage', 'metadata', 'futureReserved'];

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

// A stable key for a storage event: storageId, else status, else storageType.
function storageKey(x) {
  const s = obj(x);
  const key = pickString(s.storageId, s.status, s.storageType);
  return (key === undefined) ? '' : key;
}

// Order by insertion (stable): storage events have no timestamp field.
function orderStorage(h) {
  return h.storage
    .map((x, i) => [x, i])
    .sort((a, b) => (a[1] - b[1]))
    .map((p) => p[0]);
}

function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map((x) => manager.createStorage(x));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    storageId: (typeof src.storageId === 'string') ? src.storageId : ((src.storageId === undefined || src.storageId === null) ? null : src.storageId),
    storageType: (typeof src.storageType === 'string' && src.storageType !== '') ? src.storageType : 'NONE',
    storage: normalizeList(src.storage),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listStorage(history) { return createHistory(history).storage; }

function appendStorage(history, storage) {
  const h = createHistory(history);
  h.storage = h.storage.concat([manager.createStorage(storage)]);
  return h;
}

function replaceStorage(history, key, storage) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createStorage(storage);
  h.storage = h.storage.map((x) => (storageKey(x) === target ? replacement : x));
  return h;
}

function removeStorage(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.storage = h.storage.filter((x) => storageKey(x) !== target);
  return h;
}

function findStorage(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.storage.find((x) => storageKey(x) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.storage.length === 0) return null;
  const sorted = orderStorage(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderStorage(h);
  const idx = sorted.findIndex((x) => storageKey(x) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderStorage(h);
  const idx = sorted.findIndex((x) => storageKey(x) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const x of ha.storage) mapA.set(storageKey(x), x);
  for (const x of hb.storage) mapB.set(storageKey(x), x);
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
  const result = { valid: true, errors: [], warnings: [], duplicateStorage: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const storage = Array.isArray(history.storage) ? history.storage : [];
  if (!Array.isArray(history.storage)) {
    result.errors.push({ field: 'storage', code: 'INVALID_STORAGE_LIST', message: 'storage must be an array' });
  }
  const present = new Set();
  for (const x of storage) {
    const key = storageKey(x);
    if (present.has(key)) { if (!result.duplicateStorage.includes(key)) result.duplicateStorage.push(key); }
    present.add(key);
    const vv = manager.validateStorage(x);
    for (const e of vv.errors) result.errors.push({ field: `storage[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `storage[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateStorage.length > 0) {
    result.errors.push({ field: 'storage', code: 'DUPLICATE_STORAGE', message: `duplicate storage: ${result.duplicateStorage.join(', ')}` });
  }
  result.duplicateStorage.sort();
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
    storageId: h.storageId,
    storageType: h.storageType,
    storage: h.storage.map((x) => manager.normalizeStorage(x)),
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
  appendStorage,
  replaceStorage,
  removeStorage,
  findStorage,
  findLatest,
  findPrevious,
  findNext,
  listStorage,
  compareHistory,
  validateHistory,
  normalizeHistory,
  cloneHistory,
  freezeHistory,
};
