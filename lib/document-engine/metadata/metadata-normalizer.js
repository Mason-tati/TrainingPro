// WP-18 · E6 — Metadata normalizer (Enterprise Document Engine).
//
// Deterministic normalization: whitespace, line endings, casing, empty values, dates,
// arrays (dedupe + sort), custom-field objects, and stable field ordering. Pure — the
// only import is the sibling validator (for the canonical field set). NEVER throws and
// NEVER mutates the caller's object. UNWIRED.
'use strict';

const { FIELD_NAMES, FIELD_TYPES, isKnownField } = require('./metadata-validator');

// Fields whose scalar value is upper-cased / lower-cased during normalization.
const UPPERCASE_FIELDS = new Set(['Site', 'Department', 'DocumentType', 'Classification', 'ComplianceFramework', 'BusinessUnit']);
const LOWERCASE_FIELDS = new Set(['Language']);

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
    return out;
  }
  return value;
}

function collapseWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')      // CRLF / CR → LF
    .replace(/[ \t\f\v]+/g, ' ')  // collapse horizontal whitespace
    .replace(/ *\n */g, '\n')     // trim around newlines
    .replace(/\n{2,}/g, '\n')     // collapse blank lines
    .trim();
}

function normalizeString(field, value) {
  const raw = (typeof value === 'string') ? value : String(value === null || value === undefined ? '' : value);
  let s = collapseWhitespace(raw);
  if (UPPERCASE_FIELDS.has(field)) s = s.toUpperCase();
  else if (LOWERCASE_FIELDS.has(field)) s = s.toLowerCase();
  return s;
}

function normalizeArray(value, opts) {
  const dedupe = opts.dedupe !== false;
  const sortArrays = opts.sortArrays !== false;
  let arr;
  if (Array.isArray(value)) arr = value.slice();
  else if (value === null || value === undefined) arr = [];
  else arr = [value];
  arr = arr
    .map((x) => (typeof x === 'string' ? collapseWhitespace(x) : String(x)))
    .filter((x) => x !== '');
  if (dedupe) {
    const seen = new Set();
    arr = arr.filter((x) => {
      const key = x.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (sortArrays) arr = arr.slice().sort();
  return arr;
}

function normalizeDate(value) {
  if (typeof value !== 'string') return deepClone(value);
  const m = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/);
  if (!m) return value.trim();
  const pad = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}${m[4]}`;
}

function normalizeObject(value) {
  if (!isPlainObject(value)) return deepClone(value);
  const out = {};
  for (const k of Object.keys(value).sort()) {
    const v = value[k];
    out[k] = (typeof v === 'string') ? collapseWhitespace(v) : deepClone(v);
  }
  return out;
}

function isEmptyValue(v) {
  return v === '' || v === null || v === undefined
    || (Array.isArray(v) && v.length === 0)
    || (isPlainObject(v) && Object.keys(v).length === 0);
}

// Normalize a metadata object into a fresh, canonically-ordered object. Never throws,
// never mutates input. options: { dropEmpty=true, dropUnknown=false, dedupe=true, sortArrays=true }
function normalizeMetadata(meta, options) {
  const opts = obj(options);
  const dropEmpty = opts.dropEmpty !== false;
  const dropUnknown = opts.dropUnknown === true;
  const src = obj(meta);
  const norm = {};

  for (const k of Object.keys(src)) {
    const known = isKnownField(k);
    if (!known && dropUnknown) continue;
    const type = known ? FIELD_TYPES[k] : 'unknown';
    let val = src[k];
    if (type === 'string') val = normalizeString(k, val);
    else if (type === 'array') val = normalizeArray(val, opts);
    else if (type === 'date') val = normalizeDate(val);
    else if (type === 'object') val = normalizeObject(val);
    else val = deepClone(val);
    if (dropEmpty && isEmptyValue(val)) continue;
    norm[k] = val;
  }

  // stable ordering: known fields in canonical order, then unknown fields sorted
  const out = {};
  for (const name of FIELD_NAMES) {
    if (Object.prototype.hasOwnProperty.call(norm, name)) out[name] = norm[name];
  }
  const unknownKeys = Object.keys(norm).filter((k) => !isKnownField(k)).sort();
  for (const k of unknownKeys) out[k] = norm[k];
  return out;
}

module.exports = { normalizeMetadata };
