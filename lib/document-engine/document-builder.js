// WP-18 · E8 — Document builder (Enterprise Document Engine).
//
// A pure, dependency-free builder for the Enterprise Document structure. It shapes,
// clones, normalizes, freezes, compares, merges, structurally-validates, and snapshots
// document objects. Imports nothing. Every method is deterministic, never throws, and
// never mutates its inputs. UNWIRED — nothing in production consumes it.
'use strict';

// The canonical Enterprise Document structure: field name → kind.
const DOCUMENT_FIELDS = [
  ['id', 'scalar'],
  ['documentNumber', 'string'],
  ['title', 'string'],
  ['description', 'string'],
  ['metadata', 'object'],
  ['policy', 'object'],
  ['workflow', 'object'],
  ['status', 'object'],
  ['version', 'object'],
  ['relationships', 'array'],
  ['attachments', 'array'],
  ['notifications', 'array'],
  ['distribution', 'array'],
  ['access', 'array'],
  ['storage', 'object'],
  ['search', 'object'],
  ['compliance', 'object'],
  ['validation', 'object'],
  ['audit', 'array'],
  ['customFields', 'object'],
  ['futureReserved', 'array'],
];
const FIELD_NAMES = DOCUMENT_FIELDS.map(([n]) => n);
const FIELD_KIND = {};
for (const [n, k] of DOCUMENT_FIELDS) FIELD_KIND[n] = k;

const SNAPSHOT_SCHEMA = 'enterprise-document.v1';

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

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
    for (const k of ka) {
      if (!hasOwn(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function deepFreeze(value) {
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    return Object.freeze(value);
  }
  return value;
}

function canon(x) {
  return (x !== null && typeof x === 'object') ? JSON.stringify(x) : `${typeof x}:${String(x)}`;
}
function uniqDeep(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = canon(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

function coerce(kind, v) {
  if (kind === 'string') return (v === undefined || v === null) ? '' : String(v);
  if (kind === 'object') return isPlainObject(v) ? deepClone(v) : {};
  if (kind === 'array') return Array.isArray(v) ? deepClone(v) : [];
  // scalar: keep primitives / null; reject objects & arrays
  if (v === undefined) return null;
  return (isPlainObject(v) || Array.isArray(v)) ? null : v;
}

// ---- public ----

// Shape an input into the canonical, ordered, deep-cloned document structure.
function createDocument(input) {
  const src = obj(input);
  const doc = {};
  for (const [name, kind] of DOCUMENT_FIELDS) doc[name] = coerce(kind, src[name]);
  return doc;
}

function cloneDocument(document) { return deepClone(obj(document)); }

function normalizeAny(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return normalizeArray(value);
  if (isPlainObject(value)) return normalizeObject(value);
  return value;
}
function normalizeArray(arr) {
  const mapped = arr.map(normalizeAny).filter((x) => x !== '');
  const deduped = uniqDeep(mapped);
  return deduped
    .map((x) => [canon(x), x])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map((p) => p[1]);
}
function normalizeObject(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = normalizeAny(o[k]);
  return out;
}

// Deterministically normalize a document: stable field order, trimmed strings, sorted
// object keys, de-duplicated + sorted arrays. Returns a fresh object; never mutates input.
function normalizeDocument(document) {
  const src = obj(document);
  const norm = {};
  for (const k of Object.keys(src)) norm[k] = normalizeAny(src[k]);
  const out = {};
  for (const name of FIELD_NAMES) if (hasOwn(norm, name)) out[name] = norm[name];
  const extras = Object.keys(norm).filter((k) => !hasOwn(FIELD_KIND, k)).sort();
  for (const k of extras) out[k] = norm[k];
  return out;
}

// Deep-freeze a deep copy — the caller's object is never frozen.
function freezeDocument(document) { return deepFreeze(deepClone(obj(document))); }

// Compare two documents field-by-field. Returns sorted field-name arrays.
function compareDocuments(a, b) {
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

// Merge `incoming` onto `base`. Options: strategy ('overwrite'|'keepExisting'),
// arrays ('replace'|'append'|'union'), objects ('replace'|'merge').
function mergeDocuments(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeDocuments(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function kindMatches(kind, v) {
  if (kind === 'string') return typeof v === 'string';
  if (kind === 'object') return isPlainObject(v);
  if (kind === 'array') return Array.isArray(v);
  return !isPlainObject(v) && !Array.isArray(v); // scalar
}

// Structurally validate a document. Never throws.
function validateStructure(document) {
  const result = { valid: true, errors: [], warnings: [], missingComponents: [] };
  if (!isPlainObject(document)) {
    result.errors.push({ field: null, code: 'INVALID_STRUCTURE', message: 'document must be a plain object' });
    result.valid = false;
    return result;
  }
  for (const [name, kind] of DOCUMENT_FIELDS) {
    if (!hasOwn(document, name)) {
      result.missingComponents.push(name);
      result.errors.push({ field: name, code: 'MISSING_FIELD', message: `${name} is missing` });
      continue;
    }
    if (!kindMatches(kind, document[name])) {
      result.errors.push({ field: name, code: 'WRONG_KIND', message: `${name} must be of kind ${kind}` });
    }
  }
  if (typeof document.title === 'string' && document.title.trim() === '') {
    result.warnings.push({ field: 'title', code: 'EMPTY', message: 'title is empty' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

// Pure, deterministic 32-bit FNV-1a digest (hex) — no clock, no crypto dependency.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (`0000000${h.toString(16)}`).slice(-8);
}

// A deterministic, immutable snapshot suitable for future auditing.
function generateDocumentSnapshot(document) {
  const normalized = normalizeDocument(document);
  const canonical = JSON.stringify(normalized);
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    digest: fnv1a(canonical),
    fieldCount: Object.keys(normalized).length,
    document: normalized,
  };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createDocument,
  cloneDocument,
  normalizeDocument,
  freezeDocument,
  compareDocuments,
  mergeDocuments,
  validateStructure,
  generateDocumentSnapshot,
};
