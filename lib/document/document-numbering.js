// WP-17 · D1 — Document numbering helpers (document-management foundation).
//
// Pure, total functions for the future numbering scheme SITE-DEPT-TYPE-000001.
// No DB, no filesystem, no dependencies, no mutation. Every function is TOTAL — it
// handles null/undefined/garbage safely and never throws (no try/catch needed: the
// coercion helper makes every path defined). UNWIRED — nothing in production imports it.
'use strict';

const SEQ_MIN_DIGITS = 6;
const DOC_NUMBER_RE = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+-\d{6,}$/;

// Coerce any value to a safe string WITHOUT ever throwing (String(symbol) throws, so
// only primitives with a meaningful textual form are converted; everything else → '').
function toStringSafe(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return String(v);
  return '';
}

// Normalise a single segment: UPPERCASE, strip anything outside [A-Z0-9], fall back
// to the given placeholder when nothing usable remains.
function normalizeSegment(v, fallback) {
  const s = toStringSafe(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length ? s : fallback;
}

// normalizeDocumentNumber — canonicalise any input to an UPPERCASE, hyphen-separated
// [A-Z0-9-] string (spaces/underscores → hyphen, repeated hyphens collapsed, ends
// trimmed). Returns '' when nothing usable remains. Never throws.
function normalizeDocumentNumber(input) {
  return toStringSafe(input)
    .toUpperCase()
    .replace(/[\s_]+/g, '-')      // spaces / underscores → hyphen
    .replace(/[^A-Z0-9-]/g, '')   // drop any other character
    .replace(/-+/g, '-')          // collapse repeated hyphens
    .replace(/^-+|-+$/g, '');     // trim leading / trailing hyphens
}

// isValidDocumentNumber — true iff the coerced, trimmed value is a canonical
// SITE-DEPT-TYPE-###### number (sequence >= 6 digits). Never throws.
function isValidDocumentNumber(input) {
  return DOC_NUMBER_RE.test(toStringSafe(input).trim());
}

// buildDocumentNumber — assemble SITE-DEPT-TYPE-000001 from parts. Unknown/empty
// segments fall back to 'X'; a missing/invalid/negative sequence becomes 0, padded to
// six digits. Never throws; the result always satisfies isValidDocumentNumber().
function buildDocumentNumber(parts) {
  const p = (parts && typeof parts === 'object' && !Array.isArray(parts)) ? parts : {};
  const site = normalizeSegment(p.site, 'X');
  const dept = normalizeSegment(p.dept, 'X');
  const type = normalizeSegment(p.type, 'X');
  let n = Number.parseInt(toStringSafe(p.sequence), 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  const seq = String(n).padStart(SEQ_MIN_DIGITS, '0');
  return `${site}-${dept}-${type}-${seq}`;
}

module.exports = { normalizeDocumentNumber, isValidDocumentNumber, buildDocumentNumber };
