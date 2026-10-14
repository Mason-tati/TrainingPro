// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Shared Validation.
//
// The single source of the small, pure predicate/helper vocabulary every Workforce service and
// repository reuses, so validation logic is defined ONCE for the whole platform (the consolidation the
// WP-17→26 review recommended). Imports NOTHING. Every export is a pure function: deterministic (no
// clock, no randomness, no I/O), never-throwing, and copy-on-read (returns fresh objects/arrays, never
// mutates its arguments). UNWIRED — nothing in production imports it.
'use strict';

// ---- type predicates ----

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isBinaryFlag(value) {
  return value === 0 || value === 1;
}
function isBoolean(value) {
  return value === true || value === false;
}
function isInSet(value, allowed) {
  return Array.isArray(allowed) && allowed.includes(value);
}
// A comparable ISO-ish date is a non-empty string; ordering is a pure lexical compare (ISO dates sort).
function isComparableDate(value) {
  return typeof value === 'string' && value.length > 0;
}

// ---- date ordering (deterministic, no clock) ----

// True unless BOTH dates are comparable strings and `end` falls strictly before `start`.
function dateOrderOk(start, end) {
  if (isComparableDate(start) && isComparableDate(end)) {
    return end >= start;
  }
  return true;
}

// ---- result helpers (the never-throw { ok, code } contract) ----

function invalid(error, code) {
  return { ok: false, error, code: code || 'VALIDATION' };
}
function ok(extra) {
  return Object.assign({ ok: true }, isPlainObject(extra) ? extra : {});
}

// ---- misc helpers ----

// Read a key with a fallback when the key is absent (undefined), preserving explicit null.
function pick(src, key, fallback) {
  return isPlainObject(src) && src[key] !== undefined ? src[key] : fallback;
}

// Parse a metadataJson string into an object; unparseable / empty / non-string → null. Never throws.
function parseMetadata(metadataJson) {
  if (typeof metadataJson !== 'string' || metadataJson.length === 0) {
    return null;
  }
  try {
    return JSON.parse(metadataJson);
  } catch (e) {
    return null;
  }
}

// Attach a parsed `metadata` field to a fresh copy of a row (copy-on-read). Null-safe.
function withMetadata(row) {
  const src = isPlainObject(row) ? row : {};
  return Object.assign({}, src, { metadata: parseMetadata(src.metadataJson) });
}

// Serialize a metadata object to a JSON string for storage; non-object → null. Never throws.
function toMetadataJson(metadata) {
  if (metadata === undefined) {
    return undefined;
  }
  if (!isPlainObject(metadata)) {
    return null;
  }
  try {
    return JSON.stringify(metadata);
  } catch (e) {
    return null;
  }
}

module.exports = {
  isPlainObject,
  isPositiveInteger,
  isNonNegativeInteger,
  isNonNegativeNumber,
  isNonEmptyString,
  isBinaryFlag,
  isBoolean,
  isInSet,
  isComparableDate,
  dateOrderOk,
  invalid,
  ok,
  pick,
  parseMetadata,
  withMetadata,
  toMetadataJson,
};
