// WP-18 · E9 — Document version history (Enterprise Document Engine).
//
// Manages an ordered, in-memory collection of version objects: append/remove/replace,
// find (by key / latest / previous / next), compare, validate, normalize, freeze, clone.
// Delegates per-version work to the sibling version manager. Deterministic, never throws,
// never mutates caller objects, copy-on-read. UNWIRED — nothing in production consumes it.
'use strict';

const manager = require('./document-version-manager');

const HISTORY_FIELDS = ['documentId', 'scheme', 'versions', 'metadata', 'futureReserved'];

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function intOr(v, d) { return Number.isInteger(v) ? v : d; }

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

// A stable key for a version (major.minor.patch[-revision]); prefers an explicit label.
function versionKey(v) {
  const s = obj(v);
  if (typeof s.label === 'string' && s.label.trim() !== '') return s.label.trim();
  const core = [intOr(s.major, 0), intOr(s.minor, 0), intOr(s.patch, 0)].join('.');
  const rev = (typeof s.revision === 'string' && s.revision.trim() !== '') ? `-${s.revision.trim()}` : '';
  return core + rev;
}

// Total order over versions (ignores scheme so mixed histories still order deterministically).
function orderVersions(a, b) {
  const r = manager.compareVersions(a, b);
  if (r === 'older') return -1;
  if (r === 'newer') return 1;
  if (r === 'equal') return 0;
  // incompatible → fall back to a deterministic key comparison
  const ka = versionKey(a);
  const kb = versionKey(b);
  return ka < kb ? -1 : (ka > kb ? 1 : 0);
}

function normalizeVersions(list) {
  return (Array.isArray(list) ? list : []).map((v) => manager.createVersion(v));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    documentId: (typeof src.documentId === 'string') ? src.documentId : ((src.documentId === undefined || src.documentId === null) ? null : src.documentId),
    scheme: (typeof src.scheme === 'string' && src.scheme !== '') ? src.scheme : 'NONE',
    versions: normalizeVersions(src.versions),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listVersions(history) {
  const h = createHistory(history);
  return h.versions;
}

function appendVersion(history, version) {
  const h = createHistory(history);
  h.versions = h.versions.concat([manager.createVersion(version)]);
  return h;
}

function removeVersion(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.versions = h.versions.filter((v) => versionKey(v) !== target);
  return h;
}

function replaceVersion(history, key, version) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createVersion(version);
  h.versions = h.versions.map((v) => (versionKey(v) === target ? replacement : v));
  return h;
}

function findVersion(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.versions.find((v) => versionKey(v) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.versions.length === 0) return null;
  let latest = h.versions[0];
  for (let i = 1; i < h.versions.length; i += 1) {
    if (orderVersions(h.versions[i], latest) > 0) latest = h.versions[i];
  }
  return deepClone(latest);
}

function sortedVersions(h) {
  return h.versions.map((v, i) => [v, i]).sort((a, b) => (orderVersions(a[0], b[0]) || (a[1] - b[1]))).map((p) => p[0]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = sortedVersions(h);
  const idx = sorted.findIndex((v) => versionKey(v) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = sortedVersions(h);
  const idx = sorted.findIndex((v) => versionKey(v) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const v of ha.versions) mapA.set(versionKey(v), v);
  for (const v of hb.versions) mapB.set(versionKey(v), v);
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
  const result = { valid: true, errors: [], warnings: [], duplicateVersions: [], brokenLinks: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const versions = Array.isArray(history.versions) ? history.versions : [];
  if (!Array.isArray(history.versions)) {
    result.errors.push({ field: 'versions', code: 'INVALID_VERSIONS', message: 'versions must be an array' });
  }
  const keys = [];
  const present = new Set();
  for (const v of versions) {
    const key = versionKey(v);
    if (present.has(key)) { if (!result.duplicateVersions.includes(key)) result.duplicateVersions.push(key); }
    present.add(key);
    keys.push(key);
    const vv = manager.validateVersion(v);
    for (const e of vv.errors) result.errors.push({ field: `versions[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `versions[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateVersions.length > 0) {
    result.errors.push({ field: 'versions', code: 'DUPLICATE_VERSION', message: `duplicate versions: ${result.duplicateVersions.join(', ')}` });
  }
  // link integrity: previousVersion / nextVersion must reference an existing version
  for (const v of versions) {
    for (const link of ['previousVersion', 'nextVersion']) {
      const ref = v[link];
      if (typeof ref === 'string' && ref !== '' && !present.has(ref)) {
        const broken = `${versionKey(v)}.${link}→${ref}`;
        if (!result.brokenLinks.includes(broken)) result.brokenLinks.push(broken);
      }
    }
  }
  if (result.brokenLinks.length > 0) {
    result.warnings.push({ field: 'links', code: 'BROKEN_LINK', message: `broken links: ${result.brokenLinks.join(', ')}` });
  }
  result.duplicateVersions.sort();
  result.brokenLinks.sort();
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeHistory(history) {
  const h = createHistory(history);
  const versions = sortedVersions({ versions: h.versions.map((v) => manager.normalizeVersion(v)) });
  const norm = {};
  const built = {
    documentId: h.documentId,
    scheme: h.scheme,
    versions,
    metadata: normalizeMeta(h.metadata),
    futureReserved: deepClone(h.futureReserved),
  };
  for (const name of HISTORY_FIELDS) norm[name] = built[name];
  return norm;
}
function normalizeMeta(m) {
  const out = {};
  for (const k of Object.keys(obj(m)).sort()) { const v = m[k]; out[k] = (typeof v === 'string') ? v.trim() : deepClone(v); }
  return out;
}

function freezeHistory(history) { return deepFreeze(deepClone(obj(history))); }
function cloneHistory(history) { return deepClone(obj(history)); }

module.exports = {
  createHistory,
  appendVersion,
  removeVersion,
  replaceVersion,
  findVersion,
  findLatest,
  findPrevious,
  findNext,
  listVersions,
  compareHistory,
  validateHistory,
  normalizeHistory,
  freezeHistory,
  cloneHistory,
};
