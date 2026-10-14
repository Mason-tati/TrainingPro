// WP-18 · E9 — Document version manager (Enterprise Document Engine).
//
// Creates, increments, compares, validates, normalizes, merges, freezes, clones, and
// snapshots version objects entirely in memory. Scheme-aware via the WP-17 versioning
// registry (its only import). Deterministic, never throws, never mutates caller objects,
// deep-immutable on request, copy-on-read. UNWIRED — nothing in production consumes it.
'use strict';

const { getDocumentVersioning, isKnownDocumentVersioning } = require('../document/document-versioning');

// The canonical version structure: field name → kind.
const VERSION_FIELDS = [
  ['scheme', 'string'],
  ['major', 'int'],
  ['minor', 'int'],
  ['patch', 'int'],
  ['revision', 'string'],
  ['label', 'string'],
  ['effectiveDate', 'date'],
  ['expiryDate', 'date'],
  ['obsoleteDate', 'date'],
  ['status', 'string'],
  ['changeSummary', 'string'],
  ['author', 'string'],
  ['approvedBy', 'string'],
  ['approvedDate', 'date'],
  ['previousVersion', 'ref'],
  ['nextVersion', 'ref'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-version.v1';
const DATE_FIELDS = ['effectiveDate', 'expiryDate', 'obsoleteDate', 'approvedDate'];

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function intOr(v, d) { return Number.isInteger(v) ? v : d; }
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

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  const md = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > md) return false;
  if (m[4] !== undefined) { if (Number(m[4]) > 23 || Number(m[5]) > 59) return false; if (m[6] !== undefined && Number(m[6]) > 59) return false; }
  return true;
}

function coerce(kind, val) {
  if (kind === 'string') return (val === undefined || val === null) ? '' : String(val);
  if (kind === 'int') { if (Number.isInteger(val)) return val; return (typeof val === 'number' && Number.isFinite(val)) ? Math.trunc(val) : 0; }
  if (kind === 'date') return (typeof val === 'string' && val !== '') ? val : null;
  if (kind === 'ref') return (typeof val === 'string' && val !== '') ? val : null;
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

function versionString(v) {
  const s = obj(v);
  const core = [intOr(s.major, 0), intOr(s.minor, 0), intOr(s.patch, 0)].join('.');
  const rev = (typeof s.revision === 'string' && s.revision.trim() !== '') ? `-${s.revision.trim()}` : '';
  return core + rev;
}

// ---- public ----

function createVersion(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const v = {};
  for (const [name, kind] of VERSION_FIELDS) v[name] = coerce(kind, src[name]);
  const schemeId = pickString(src.scheme, opts.scheme, opts.defaultScheme);
  v.scheme = (schemeId === undefined) ? 'NONE' : schemeId;
  return v;
}

function cloneVersion(version) { return deepClone(obj(version)); }
function freezeVersion(version) { return deepFreeze(deepClone(obj(version))); }

function applyBumpMeta(v, options) {
  const opts = obj(options);
  if (typeof opts.author === 'string') v.author = opts.author;
  if (typeof opts.changeSummary === 'string') v.changeSummary = opts.changeSummary;
  if (typeof opts.status === 'string') v.status = opts.status;
  if (typeof opts.effectiveDate === 'string') v.effectiveDate = opts.effectiveDate;
  return v;
}

function incrementMajor(version, options) {
  const v = createVersion(version);
  v.major = intOr(v.major, 0) + 1; v.minor = 0; v.patch = 0;
  return applyBumpMeta(v, options);
}
function incrementMinor(version, options) {
  const v = createVersion(version);
  v.minor = intOr(v.minor, 0) + 1; v.patch = 0;
  return applyBumpMeta(v, options);
}
function incrementPatch(version, options) {
  const v = createVersion(version);
  v.patch = intOr(v.patch, 0) + 1;
  return applyBumpMeta(v, options);
}
function nextRevision(rev) {
  const r = rev.trim(); // rev is always a coerced string here (createVersion guarantees it)
  if (/^\d+$/.test(r)) return String(Number(r) + 1);
  if (/^[A-Za-z]$/.test(r)) { const code = r.toUpperCase().charCodeAt(0); return code >= 90 ? 'AA' : String.fromCharCode(code + 1); }
  return 'A';
}
function incrementRevision(version, options) {
  const v = createVersion(version);
  v.revision = nextRevision(v.revision);
  return applyBumpMeta(v, options);
}

// A new revision derived from a base version: bump revision and link to the predecessor.
function createRevision(base, options) {
  const opts = obj(options);
  const prev = createVersion(base);
  const next = incrementRevision(prev, opts);
  next.previousVersion = versionString(prev);
  return next;
}

function cmpInt(x, y) { return x < y ? -1 : (x > y ? 1 : 0); }
function cmpRevision(ra, rb) {
  const a = String(ra); // ra/rb are always coerced revision strings here
  const b = String(rb);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return cmpInt(Number(a), Number(b));
  return a < b ? -1 : (a > b ? 1 : 0);
}
function versionOrder(a, b) {
  return cmpInt(intOr(a.major, 0), intOr(b.major, 0))
    || cmpInt(intOr(a.minor, 0), intOr(b.minor, 0))
    || cmpInt(intOr(a.patch, 0), intOr(b.patch, 0))
    || cmpRevision(a.revision, b.revision);
}

function compareVersions(a, b) {
  const va = createVersion(a);
  const vb = createVersion(b);
  if (va.scheme !== vb.scheme) return 'incompatible';
  const cmp = versionOrder(va, vb);
  if (cmp < 0) return 'older';
  if (cmp > 0) return 'newer';
  return 'equal';
}

function validateVersion(version) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(version)) {
    result.errors.push({ field: null, code: 'INVALID_VERSION', message: 'version must be a plain object' });
    result.valid = false;
    return result;
  }
  const schemeId = (typeof version.scheme === 'string') ? version.scheme.trim() : '';
  let scheme = null;
  if (schemeId === '') {
    result.errors.push({ field: 'scheme', code: 'MISSING_SCHEME', message: 'scheme is required' });
  } else if (!isKnownDocumentVersioning(schemeId)) {
    result.errors.push({ field: 'scheme', code: 'UNKNOWN_SCHEME', message: `unknown scheme: ${schemeId}` });
  } else {
    scheme = getDocumentVersioning(schemeId);
  }
  for (const part of ['major', 'minor', 'patch']) {
    if (hasOwn(version, part) && !(Number.isInteger(version[part]) && version[part] >= 0)) {
      result.errors.push({ field: part, code: 'INVALID_NUMBER', message: `${part} must be a non-negative integer` });
    }
  }
  if (hasOwn(version, 'revision') && typeof version.revision !== 'string') {
    result.errors.push({ field: 'revision', code: 'INVALID_REVISION', message: 'revision must be a string' });
  }
  for (const df of DATE_FIELDS) {
    if (hasOwn(version, df) && version[df] !== null && version[df] !== undefined && !isValidDateString(version[df])) {
      result.errors.push({ field: df, code: 'INVALID_DATE', message: `${df} is not a valid date` });
    }
  }
  if (isValidDateString(version.effectiveDate) && isValidDateString(version.expiryDate) && version.expiryDate < version.effectiveDate) {
    result.errors.push({ field: 'expiryDate', code: 'DATE_ORDER', message: 'expiryDate is before effectiveDate' });
  }
  if (scheme) {
    if (!scheme.majorSupported && intOr(version.major, 0) > 0) result.warnings.push({ field: 'major', code: 'MAJOR_UNSUPPORTED', message: 'scheme does not support major' });
    if (!scheme.minorSupported && intOr(version.minor, 0) > 0) result.warnings.push({ field: 'minor', code: 'MINOR_UNSUPPORTED', message: 'scheme does not support minor' });
    if (!scheme.patchSupported && intOr(version.patch, 0) > 0) result.warnings.push({ field: 'patch', code: 'PATCH_UNSUPPORTED', message: 'scheme does not support patch' });
    if (!scheme.revisionSupported && typeof version.revision === 'string' && version.revision.trim() !== '') result.warnings.push({ field: 'revision', code: 'REVISION_UNSUPPORTED', message: 'scheme does not support revision' });
    if (!scheme.supportsEffectiveDate && isValidDateString(version.effectiveDate)) result.warnings.push({ field: 'effectiveDate', code: 'EFFECTIVE_UNSUPPORTED', message: 'scheme does not support effectiveDate' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeVersion(version) {
  const v = createVersion(version);
  for (const [name, kind] of VERSION_FIELDS) {
    if (kind === 'string' && typeof v[name] === 'string') v[name] = v[name].trim();
    else if (kind === 'object') v[name] = normalizeObject(v[name]);
    else if (kind === 'array') v[name] = normalizeArray(v[name]);
  }
  return v;
}

function mergeVersions(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeVersions(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (`0000000${h.toString(16)}`).slice(-8);
}

function generateVersionSnapshot(version) {
  const normalized = normalizeVersion(version);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), version: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createVersion,
  createRevision,
  incrementMajor,
  incrementMinor,
  incrementPatch,
  incrementRevision,
  compareVersions,
  validateVersion,
  normalizeVersion,
  freezeVersion,
  cloneVersion,
  mergeVersions,
  generateVersionSnapshot,
};
