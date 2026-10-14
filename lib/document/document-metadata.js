// WP-17 · D2 — Document metadata builder (document-management foundation).
//
// Pure, total helpers that assemble a safe, normalized metadata object from arbitrary
// input using the D1 registries and the D2 governance mapping. No DB, no filesystem,
// no request context, no logging. Sanitizes free text (control chars stripped, secret
// patterns masked, length-capped). Never throws; unknown inputs are made safe.
// UNWIRED — nothing in production runtime imports it.
'use strict';

const { getDocumentType } = require('./document-types');
const { getDocumentStatus } = require('./document-status');
const { getReviewFrequency } = require('./review-frequency');
const { getApprovalLevel } = require('./approval-levels');
const { normalizeDocumentNumber, isValidDocumentNumber, buildDocumentNumber } = require('./document-numbering');
const { getDocumentGovernance } = require('./document-governance');

const TITLE_CAP = 160;
const DESC_CAP = 1000;
const FIELD_CAP = 120;
const TITLE_FALLBACK = 'Untitled Document';

// Remove ASCII control characters.
function stripControl(s) {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// Mask / remove secret-bearing patterns so they can never be persisted in metadata.
function maskSecrets(s) {
  return s
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')                                   // API keys
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')                                     // bearer tokens
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, '[REDACTED]')  // JWT
    .replace(/connect\.sid=\S+/gi, 'connect.sid=[REDACTED]')                              // session cookie
    .replace(/\b(password|passwd|pwd|token|api[_-]?key|apikey|secret)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]') // credential k=v
    .replace(/\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER)\b\s+[^;]*?\b(FROM|INTO|TABLE|WHERE|SET|VALUES|SELECT)\b[^;]*/gi, '[REDACTED]'); // SQL
}

// Common text sanitizer: string-only, control-stripped, secret-masked, trimmed, capped.
function sanitizeText(input, cap, fallback) {
  if (typeof input !== 'string') return fallback;
  let s = maskSecrets(stripControl(input)).trim();
  if (s.length > cap) s = s.slice(0, cap).trim();
  return s.length ? s : fallback;
}

function sanitizeDocumentTitle(input) { return sanitizeText(input, TITLE_CAP, TITLE_FALLBACK); }
function sanitizeDocumentDescription(input) { return sanitizeText(input, DESC_CAP, ''); }

// A short free-text field (owner/department/site) — same sanitizer, empty fallback.
function sanitizeField(input) { return sanitizeText(input, FIELD_CAP, ''); }

// Normalize a version to a safe short token; defaults to '1'.
function normalizeVersion(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') {
    const s = v.trim().replace(/[^0-9A-Za-z.]/g, '');
    return s.length ? s : '1';
  }
  return '1';
}

// Resolve a document number: use a provided valid/normalizable number, else build one
// from site / department / type / sequence parts.
function resolveDocumentNumber(p) {
  const provided = normalizeDocumentNumber(p.documentNumber);
  if (isValidDocumentNumber(provided)) return provided;
  return buildDocumentNumber({ site: p.site, dept: p.department, type: p.type, sequence: p.sequence });
}

// buildDocumentMetadata — assemble a safe, fully-normalized metadata object from any
// input. Unknown ids resolve to safe registry defaults; governance is embedded fresh.
function buildDocumentMetadata(input) {
  const p = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const type = getDocumentType(p.type).id;
  const status = getDocumentStatus(p.status).id;
  const reviewFrequency = getReviewFrequency(p.reviewFrequency).id;
  const approvalLevel = getApprovalLevel(p.approvalLevel).id;
  const governance = getDocumentGovernance(type);
  return {
    title: sanitizeDocumentTitle(p.title),
    description: sanitizeDocumentDescription(p.description),
    type,
    status,
    reviewFrequency,
    approvalLevel,
    documentNumber: resolveDocumentNumber(p),
    version: normalizeVersion(p.version),
    owner: sanitizeField(p.owner),
    department: sanitizeField(p.department),
    site: sanitizeField(p.site),
    classification: governance.classification,
    retention: governance.retention,
    governance,
  };
}

// normalizeDocumentMetadata — canonicalize an existing / partial metadata object into
// the safe metadata shape. Idempotent (build's output fed back yields the same object).
function normalizeDocumentMetadata(input) {
  return buildDocumentMetadata(input);
}

module.exports = {
  buildDocumentMetadata,
  normalizeDocumentMetadata,
  sanitizeDocumentTitle,
  sanitizeDocumentDescription,
};
