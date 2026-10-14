// WP-15 · D2 — Business audit helper (governance foundation).
//
// A safe, sanitizing helper that PREPARES (and optionally writes) governance
// business-audit records using the EXISTING tblAudit schema — a future,
// migration-ready alternative to lib/audit.js. It validates entity/action against
// the D1 registries, sanitizes all values (allow-lists safe scalars, masks
// secrets, caps length, drops objects/arrays), resolves the actor safely (never a
// session id/cookie/token), maps to tblAudit, and FAILS OPEN — it never throws.
//
// NOTHING in production imports this. lib/audit.js and the DB schema are unchanged.
'use strict';

const requestContext = require('../request-context');
const { ENTITY_IDS } = require('./entities');
const { ACTION_IDS } = require('./actions');

const MAX_LEN = 256;

// Metadata keys that are dropped outright (never copied).
const FORBIDDEN_KEYS = new Set([
  'password', 'pass', 'hashpass', 'hash', 'cookie', 'connect.sid', 'authorization',
  'bearer', 'jwt', 'token', 'accesstoken', 'refreshtoken', 'sessionid', 'sid',
  'sql', 'query', 'dbpath', 'databasepath', 'requestbody', 'responsebody', 'body',
  'prompt', 'completion', 'aioutput', 'rawoutput', 'filedata', 'base64', 'binary',
]);

// Mask secrets / long numbers, strip control chars, cap length. Never throws.
function maskString(input) {
  let out = String(input);
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');       // API keys
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');          // bearer tokens
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, '[REDACTED]'); // JWT
  out = out.replace(/connect\.sid=\S+/gi, 'connect.sid=[REDACTED]');   // session cookie
  out = out.replace(/\b\d{6,}\b/g, '[REDACTED]');                      // long digit runs (account numbers)
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');          // control chars
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN);
  return out;
}

// Coerce a scalar to a masked, capped string. Never throws.
function sanitizeScalar(value, cap) {
  const limit = typeof cap === 'number' && cap > 0 ? cap : MAX_LEN;
  const masked = maskString(typeof value === 'string' ? value : String(value));
  return masked.length > limit ? masked.slice(0, limit) : masked;
}

// A tblAudit Old/New value: only short strings / numbers / booleans / null survive
// (as text); objects, arrays, functions, symbols → null (dropped). Never throws.
function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return maskString(value);
  return null;
}

// A string/number scalar field (e.g. recordId, field) → sanitized string, else null.
function scalarField(value, cap) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return sanitizeScalar(String(value), cap);
  return null;
}

// Resolve the actor: input.actor → request-context actor → "system". Never a
// session id / cookie / token (actor is a short username-like scalar). Never throws.
function resolveActor(inputActor) {
  if (typeof inputActor === 'string' && inputActor.trim() !== '') return sanitizeScalar(inputActor, 128);
  try {
    const ctx = requestContext.get();
    const a = ctx && ctx.actor;
    if (typeof a === 'string' && a.trim() !== '') return sanitizeScalar(a, 128);
  } catch { /* ignore */ }
  return 'system';
}

// Pure: return a safe metadata copy — only short strings / numbers / booleans;
// forbidden keys dropped; strings masked/capped; objects/arrays dropped. Fresh
// object. Never mutates input. Never throws. (Not written to tblAudit; utility.)
function sanitizeAuditMetadata(metadata) {
  const out = {};
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const [k, v] of Object.entries(metadata)) {
      if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) continue;
      if (v === null || v === undefined) continue;
      if (typeof v === 'number') { if (Number.isFinite(v)) out[String(k)] = v; continue; }
      if (typeof v === 'boolean') { out[String(k)] = v; continue; }
      if (typeof v === 'string') { out[String(k)] = maskString(v); continue; }
      // objects / arrays / functions / symbols → dropped
    }
  }
  return out;
}

// Pure: build a sanitized tblAudit row from the input model. No database. Never
// mutates input. Never throws. requestId / metadata / scope are intentionally
// NOT mapped (per the tblAudit mapping). Fresh object.
function buildAuditRecord(input) {
  const inp = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  return {
    AuditUser: resolveActor(inp.actor),
    AuditTable: typeof inp.entity === 'string' ? sanitizeScalar(inp.entity, 128) : null,
    AuditAction: typeof inp.action === 'string' ? sanitizeScalar(inp.action, 128) : null,
    AuditRecord: scalarField(inp.recordId, 128),
    AuditField: typeof inp.field === 'string' ? sanitizeScalar(inp.field, 128) : null,
    OldValue: sanitizeValue(inp.oldValue),
    NewValue: sanitizeValue(inp.newValue),
  };
}

// Prepare and (only for a known entity+action) write a governance audit record to
// the EXISTING tblAudit. Fails open — never throws. Returns { ok, written, reason,
// record }. Unknown entity/action → not written.
async function recordAuditEvent(input) {
  try {
    const inp = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const entityKnown = typeof inp.entity === 'string' && ENTITY_IDS.includes(inp.entity);
    const actionKnown = typeof inp.action === 'string' && ACTION_IDS.includes(inp.action);
    if (!entityKnown || !actionKnown) {
      return { ok: true, written: false, reason: 'unknown_entity_or_action', record: null };
    }
    const record = buildAuditRecord(inp);
    try {
      const { dbRun } = require('../../database/db'); // lazy — pure helpers never touch the DB
      await dbRun(
        `INSERT INTO tblAudit (AuditDate,AuditUser,AuditTable,AuditAction,AuditRecord,AuditField,OldValue,NewValue)
         VALUES (datetime('now'),?,?,?,?,?,?,?)`,
        [record.AuditUser, record.AuditTable, record.AuditAction, record.AuditRecord, record.AuditField, record.OldValue, record.NewValue],
      );
      return { ok: true, written: true, reason: 'written', record };
    } catch {
      return { ok: true, written: false, reason: 'write_failed', record }; // fail open
    }
  } catch {
    return { ok: true, written: false, reason: 'error', record: null }; // fail open
  }
}

module.exports = { recordAuditEvent, buildAuditRecord, sanitizeAuditMetadata };
