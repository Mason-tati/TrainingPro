// WP-18 · E6 — Metadata validator (Enterprise Document Engine).
//
// The authority on the metadata field set and its validation rules. Pure and
// dependency-free — imports nothing (no database, Express, routes, services,
// repositories). validateMetadata NEVER throws and returns a structured result.
// UNWIRED — nothing in production consumes it.
'use strict';

// Canonical field order (also used for stable ordering by the normalizer).
const FIELD_NAMES = Object.freeze([
  'Title', 'Description', 'Owner', 'Author', 'Department', 'Site', 'BusinessUnit', 'Project',
  'Equipment', 'DocumentType', 'Classification', 'ComplianceFramework', 'Language', 'Version',
  'Revision', 'Keywords', 'Tags', 'EffectiveDate', 'ReviewDate', 'ExpiryDate', 'CreatedBy',
  'UpdatedBy', 'CreatedDate', 'UpdatedDate', 'CustomFields',
]);

const FIELD_TYPES = Object.freeze({
  Title: 'string', Description: 'string', Owner: 'string', Author: 'string', Department: 'string',
  Site: 'string', BusinessUnit: 'string', Project: 'string', Equipment: 'string', DocumentType: 'string',
  Classification: 'string', ComplianceFramework: 'string', Language: 'string', Version: 'string',
  Revision: 'string', CreatedBy: 'string', UpdatedBy: 'string',
  Keywords: 'array', Tags: 'array',
  EffectiveDate: 'date', ReviewDate: 'date', ExpiryDate: 'date', CreatedDate: 'date', UpdatedDate: 'date',
  CustomFields: 'object',
});

// System-managed fields that callers should not normally set.
const RESERVED_FIELDS = Object.freeze(['CreatedBy', 'CreatedDate', 'UpdatedBy', 'UpdatedDate']);
const RESERVED = new Set(RESERVED_FIELDS);

// Default per-field maximum lengths (overridable via options.maxLengths).
const MAX_LENGTHS = Object.freeze({
  Title: 200, Description: 2000, Owner: 120, Author: 120, Department: 120, Site: 120, BusinessUnit: 120,
  Project: 120, DocumentType: 80, Classification: 80, ComplianceFramework: 80,
  Language: 20, Version: 50, Revision: 50, CreatedBy: 120, UpdatedBy: 120,
});
// Fields without an explicit entry above (e.g. Equipment) fall back to this default.
const DEFAULT_MAX = 200;

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function isScalar(v) { return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'; }
function isKnownField(name) { return Object.prototype.hasOwnProperty.call(FIELD_TYPES, name); }

function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

// Pure ISO-8601 date / datetime validation — no Date object, fully deterministic.
function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > monthDays) return false;
  if (m[4] !== undefined) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59) return false;
    if (m[6] !== undefined && Number(m[6]) > 59) return false;
  }
  return true;
}

function effectiveMax(field, opts) {
  if (opts.maxLengths && Number.isInteger(opts.maxLengths[field])) return opts.maxLengths[field];
  if (Number.isInteger(MAX_LENGTHS[field])) return MAX_LENGTHS[field];
  return DEFAULT_MAX;
}

function validateString(field, value, opts, errors) {
  if (typeof value !== 'string') {
    errors.push({ field, code: 'TYPE', message: `${field} must be a string` });
    return;
  }
  const max = effectiveMax(field, opts);
  if (value.length > max) errors.push({ field, code: 'MAX_LENGTH', message: `${field} exceeds maximum length ${max}` });
  if (opts.allowedValues && Array.isArray(opts.allowedValues[field]) && !opts.allowedValues[field].includes(value)) {
    errors.push({ field, code: 'NOT_ALLOWED', message: `${field} has a value that is not allowed` });
  }
}

function validateArray(field, value, errors) {
  if (!Array.isArray(value)) {
    errors.push({ field, code: 'TYPE', message: `${field} must be an array` });
    return;
  }
  for (const el of value) {
    if (typeof el !== 'string') {
      errors.push({ field, code: 'TYPE', message: `${field} must be an array of strings` });
      return;
    }
  }
}

function validateCustomFields(field, value, opts, errors) {
  if (!isPlainObject(value)) {
    errors.push({ field, code: 'INVALID_CUSTOM_FIELD', message: `${field} must be a plain object` });
    return;
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (key.trim() === '') {
      errors.push({ field, code: 'INVALID_CUSTOM_FIELD', message: 'custom field key must be non-empty' });
      continue;
    }
    const scalarOk = isScalar(v) || (Array.isArray(v) && v.every(isScalar));
    if (!scalarOk) {
      errors.push({ field, code: 'INVALID_CUSTOM_FIELD', message: `custom field ${key} has an unsupported value` });
      continue;
    }
    if (typeof opts.customFieldValidator === 'function') {
      let verdict;
      try { verdict = opts.customFieldValidator(key, v); } catch (e) { verdict = false; }
      if (verdict !== true) {
        errors.push({ field, code: 'INVALID_CUSTOM_FIELD', message: (typeof verdict === 'string') ? verdict : `custom field ${key} is invalid` });
      }
    }
  }
}

// Validate metadata. Never throws; returns a structured result:
//   { valid, errors[], warnings[], unknownFields[], reservedFields[], duplicateKeys[] }
function validateMetadata(meta, options) {
  const opts = isPlainObject(options) ? options : {};
  const errors = [];
  const warnings = [];
  const result = { valid: true, errors, warnings, unknownFields: [], reservedFields: [], duplicateKeys: [] };

  if (!isPlainObject(meta)) {
    errors.push({ field: null, code: 'INVALID_METADATA', message: 'metadata must be a plain object' });
    result.valid = false;
    return result;
  }

  const keys = Object.keys(meta);

  // duplicate (case-insensitive) key detection
  const byLower = new Map();
  for (const k of keys) {
    const lk = k.toLowerCase();
    byLower.set(lk, (byLower.get(lk) || []).concat(k));
  }
  for (const group of byLower.values()) {
    if (group.length > 1) {
      result.duplicateKeys.push(...group);
      errors.push({ field: group.join(','), code: 'DUPLICATE_KEY', message: `duplicate field keys: ${group.join(', ')}` });
    }
  }

  // required fields
  const required = Array.isArray(opts.required) ? opts.required : [];
  for (const rf of required) {
    const v = meta[rf];
    const missing = v === undefined || v === null
      || (typeof v === 'string' && v.trim() === '')
      || (Array.isArray(v) && v.length === 0);
    if (missing) errors.push({ field: rf, code: 'REQUIRED', message: `${rf} is required` });
  }

  // per-field checks
  for (const k of keys) {
    if (!isKnownField(k)) {
      result.unknownFields.push(k);
      const entry = { field: k, code: 'UNKNOWN_FIELD', message: `unknown field: ${k}` };
      if (opts.allowUnknown === false) errors.push(entry); else warnings.push(entry);
      continue;
    }
    if (RESERVED.has(k)) {
      result.reservedFields.push(k);
      const entry = { field: k, code: 'RESERVED_FIELD', message: `reserved field: ${k}` };
      if (opts.allowReserved === false) errors.push(entry); else warnings.push(entry);
    }
    const v = meta[k];
    if (v === undefined || v === null) continue; // null handling: not a type error
    const type = FIELD_TYPES[k];
    if (type === 'string') validateString(k, v, opts, errors);
    else if (type === 'array') validateArray(k, v, errors);
    else if (type === 'date') { if (!isValidDateString(v)) errors.push({ field: k, code: 'INVALID_DATE', message: `${k} is not a valid date` }); }
    else validateCustomFields(k, v, opts, errors);
  }

  result.valid = errors.length === 0;
  return result;
}

module.exports = {
  FIELD_NAMES, FIELD_TYPES, RESERVED_FIELDS, MAX_LENGTHS,
  isKnownField, isPlainObject, isScalar, isValidDateString, validateMetadata,
};
