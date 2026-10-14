// WP-18 · E16 — Document storage manager (Enterprise Document Engine).
//
// Evaluates storage definitions and lifecycle state entirely in memory. It performs NO file
// uploads, NO filesystem access, NO cloud access, and NO persistence — it only resolves a
// storage object against its type mode and produces deterministic storage objects. Mode-aware
// via the WP-17 storage registry (its only import). Deterministic, never throws, never mutates
// callers, deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentStorage, isKnownDocumentStorage } = require('../document/document-storage');

const STORAGE_STATES = ['PENDING', 'ACTIVE', 'ARCHIVED', 'BACKUP', 'RETIRED', 'FAILED', 'UNKNOWN'];
const STATE_SET = new Set(STORAGE_STATES);
const MODE_FLAGS = ['requiresEncryption', 'requiresChecksum', 'requiresVirusScan', 'supportsVersioning', 'supportsBackup'];

const STORAGE_FIELDS = [
  ['storageId', 'string'],
  ['storageType', 'string'],
  ['status', 'string'],
  ['provider', 'string'],
  ['storageClass', 'string'],
  ['retentionDays', 'nullint'],
  ['maxFileSizeMb', 'nullint'],
  ['requiresEncryption', 'bool'],
  ['requiresChecksum', 'bool'],
  ['requiresVirusScan', 'bool'],
  ['supportsVersioning', 'bool'],
  ['supportsBackup', 'bool'],
  ['location', 'string'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-storage.v1';

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
  if (kind === 'nullint') {
    if (val === null || val === undefined) return null;
    if (Number.isInteger(val)) return val;
    return (typeof val === 'number' && Number.isFinite(val)) ? Math.trunc(val) : null;
  }
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

function applyOpts(next, opts) {
  if (typeof opts.location === 'string') next.location = opts.location;
  return next;
}

// ---- public ----

function createStorage(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const a = {};
  for (const [name, kind] of STORAGE_FIELDS) a[name] = coerce(kind, src[name]);
  const typeId = pickString(src.storageType, opts.storageType, opts.defaultType);
  a.storageType = (typeId === undefined) ? 'NONE' : typeId;
  const mode = getDocumentStorage(a.storageType);
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  a.status = (statusId === undefined) ? 'PENDING' : statusId;
  // mode-derived fields default from the storage mode unless explicitly provided
  if (!hasOwn(src, 'provider')) a.provider = mode.provider;
  if (!hasOwn(src, 'storageClass')) a.storageClass = mode.storageClass;
  if (!hasOwn(src, 'retentionDays')) a.retentionDays = mode.defaultRetentionDays;
  if (!hasOwn(src, 'maxFileSizeMb')) a.maxFileSizeMb = mode.maxFileSizeMb;
  for (const flag of MODE_FLAGS) { if (!hasOwn(src, flag)) a[flag] = mode[flag]; }
  return a;
}

function cloneStorage(storage) { return deepClone(obj(storage)); }
function freezeStorage(storage) { return deepFreeze(deepClone(obj(storage))); }

// Re-derive every mode-controlled field from the storage type (canonical evaluation).
function evaluateStorage(storage) {
  const s = createStorage(storage);
  const mode = getDocumentStorage(s.storageType);
  s.provider = mode.provider;
  s.storageClass = mode.storageClass;
  s.retentionDays = mode.defaultRetentionDays;
  s.maxFileSizeMb = mode.maxFileSizeMb;
  for (const flag of MODE_FLAGS) s[flag] = mode[flag];
  return s;
}

function archiveStorage(storage, options) {
  const opts = obj(options);
  const cur = createStorage(storage);
  if (cur.status === 'RETIRED') return { valid: false, errors: [{ field: 'status', code: 'NOT_TRANSITIONABLE', message: 'storage is retired' }], warnings: [], storage: cur };
  const next = cloneStorage(cur);
  next.status = 'ARCHIVED';
  return { valid: true, errors: [], warnings: [], storage: applyOpts(next, opts) };
}

function backupStorage(storage, options) {
  const opts = obj(options);
  const cur = createStorage(storage);
  if (cur.status === 'RETIRED') return { valid: false, errors: [{ field: 'status', code: 'NOT_TRANSITIONABLE', message: 'storage is retired' }], warnings: [], storage: cur };
  if (cur.supportsBackup !== true) return { valid: false, errors: [{ field: 'supportsBackup', code: 'BACKUP_NOT_SUPPORTED', message: 'storage does not support backup' }], warnings: [], storage: cur };
  const next = cloneStorage(cur);
  next.status = 'BACKUP';
  return { valid: true, errors: [], warnings: [], storage: applyOpts(next, opts) };
}

function retireStorage(storage, options) {
  const opts = obj(options);
  const cur = createStorage(storage);
  if (cur.status === 'RETIRED') return { valid: false, errors: [{ field: 'status', code: 'ALREADY_RETIRED', message: 'storage is already retired' }], warnings: [], storage: cur };
  const next = cloneStorage(cur);
  next.status = 'RETIRED';
  return { valid: true, errors: [], warnings: [], storage: applyOpts(next, opts) };
}

function failStorage(storage, options) {
  const opts = obj(options);
  const cur = createStorage(storage);
  if (cur.status === 'RETIRED') return { valid: false, errors: [{ field: 'status', code: 'NOT_TRANSITIONABLE', message: 'storage is retired' }], warnings: [], storage: cur };
  const next = cloneStorage(cur);
  next.status = 'FAILED';
  return { valid: true, errors: [], warnings: [], storage: applyOpts(next, opts) };
}

function validateStorage(storage) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(storage)) {
    result.errors.push({ field: null, code: 'INVALID_STORAGE', message: 'storage must be a plain object' });
    result.valid = false;
    return result;
  }
  const typeId = (typeof storage.storageType === 'string') ? storage.storageType.trim() : '';
  const typeKnown = isKnownDocumentStorage(typeId);
  if (typeId !== '' && !typeKnown) result.warnings.push({ field: 'storageType', code: 'UNKNOWN_STORAGE_TYPE', message: `unknown storage type: ${typeId}` });

  const status = (typeof storage.status === 'string') ? storage.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!STATE_SET.has(status)) result.errors.push({ field: 'status', code: 'INVALID_STATUS', message: `invalid status: ${status}` });

  if (typeKnown) {
    const mode = getDocumentStorage(typeId);
    if (typeof storage.provider === 'string' && storage.provider !== '' && storage.provider !== mode.provider) {
      result.warnings.push({ field: 'provider', code: 'PROVIDER_MISMATCH', message: `provider ${storage.provider} does not match type ${typeId}` });
    }
    if (typeof storage.storageClass === 'string' && storage.storageClass !== '' && storage.storageClass !== mode.storageClass) {
      result.warnings.push({ field: 'storageClass', code: 'CLASS_MISMATCH', message: `storageClass ${storage.storageClass} does not match type ${typeId}` });
    }
  }
  if (hasOwn(storage, 'retentionDays') && !(storage.retentionDays === null || (Number.isInteger(storage.retentionDays) && storage.retentionDays >= 0))) {
    result.errors.push({ field: 'retentionDays', code: 'INVALID_RETENTION', message: 'retentionDays must be null or a non-negative integer' });
  }
  if (hasOwn(storage, 'maxFileSizeMb') && !(storage.maxFileSizeMb === null || (Number.isInteger(storage.maxFileSizeMb) && storage.maxFileSizeMb > 0))) {
    result.errors.push({ field: 'maxFileSizeMb', code: 'INVALID_MAX_SIZE', message: 'maxFileSizeMb must be null or a positive integer' });
  }
  if (Array.isArray(storage.futureReserved) && uniqDeep(storage.futureReserved).length !== storage.futureReserved.length) {
    result.warnings.push({ field: 'futureReserved', code: 'DUPLICATE_ENTRY', message: 'futureReserved contains duplicates' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeStorage(storage) {
  const s = createStorage(storage);
  for (const [name, kind] of STORAGE_FIELDS) {
    if (kind === 'string' && typeof s[name] === 'string') s[name] = s[name].trim();
    else if (kind === 'object') s[name] = normalizeObject(s[name]);
    else if (kind === 'array') s[name] = normalizeArray(s[name]);
  }
  return s;
}

function mergeStorage(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeStorage(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareStorage(a, b) {
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

function generateStorageSnapshot(storage) {
  const normalized = normalizeStorage(storage);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), storage: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createStorage,
  archiveStorage,
  backupStorage,
  retireStorage,
  failStorage,
  validateStorage,
  normalizeStorage,
  cloneStorage,
  freezeStorage,
  mergeStorage,
  compareStorage,
  generateStorageSnapshot,
  evaluateStorage,
};
