// WP-13 · S6 — Input validation helpers (ADVISORY / adoption-ready).
//
// Dependency-free pure functions. No DB, no Express, no logging, no network.
// NOTHING wires these into routes yet — this is a toolkit a later WP can adopt.
// Every helper: never throws, never mutates its input, handles non-string input
// safely, and rejects path traversal + null bytes.
'use strict';

// Control characters (C0 range incl. NUL 0x00, plus DEL 0x7F).
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// A conservative identifier: letters, digits, underscore, hyphen only (1..128).
// Rejects dots/slashes/null bytes → path traversal is impossible by construction.
function isSafeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAllowedEnum(value, allowed) {
  if (Array.isArray(allowed)) return allowed.includes(value);
  if (allowed instanceof Set) return allowed.has(value);
  return false;
}

// Strip path separators, null bytes, control chars, and traversal sequences;
// collapse unsafe characters to underscore. Returns '' for non-strings/empty.
function sanitizeFilename(value) {
  if (typeof value !== 'string') return '';
  let name = value.replace(CONTROL_CHARS, '');  // null bytes + control chars
  name = name.split(/[\\/]/).pop();             // keep only the final path segment
  name = name.replace(/\.{2,}/g, '.');          // collapse traversal dots
  name = name.replace(/[^A-Za-z0-9._-]/g, '_'); // collapse other unsafe chars
  name = name.replace(/^\.+/, '');              // no leading dots
  return name.trim();
}

// Coerce to a bounded, control-char-free string. Never throws.
function safeString(value, maxLength) {
  const s = value == null ? '' : (typeof value === 'string' ? value : String(value));
  const cleaned = s.replace(CONTROL_CHARS, '').trim();
  const cap = isPositiveInteger(maxLength) ? maxLength : 1000;
  return cleaned.slice(0, cap);
}

function validateEmail(value) {
  if (typeof value !== 'string') return false;
  if (value.includes('\x00') || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Strict calendar date in YYYY-MM-DD (a real, existing date).
function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = {
  isNonEmptyString,
  isSafeId,
  isPositiveInteger,
  isFiniteNumber,
  isAllowedEnum,
  sanitizeFilename,
  safeString,
  validateEmail,
  validateDate,
};
