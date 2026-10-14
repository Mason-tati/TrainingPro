// WP-16 · M2 — Legacy audit compatibility adapter (governance foundation).
//
// A safe, sanitizing drop-in for legacy logAudit() that a FUTURE migration batch
// can adopt. It PRESERVES the existing tblAudit row shape (original AuditTable /
// AuditAction strings, per PO decision) while mapping them INTERNALLY to
// governance entity/action ids purely for validation + sanitization. Supports
// both legacy calling conventions, handles dynamic/unknown inputs via safe
// fallbacks, and FAILS OPEN — it never throws. NOTHING in production imports it.
'use strict';

const requestContext = require('../request-context');
const { getEntity } = require('./entities');

const MAX_LEN = 256;
const FALLBACK_ENTITY = 'audit';   // known entity, no content-drop → values preserved (masked/capped)
const FALLBACK_ACTION = 'update';  // known governance action

// ── legacy → governance mappings (from the M1 inventory + PO guidance) ──────
const TABLE_MAP = Object.freeze({
  tblStaff: 'users', tblEmpJob: 'users', tblTrainer: 'users',
  Disciplinary: 'disciplinary', Onboarding: 'onboarding', OnboardingReview: 'onboarding',
  LeaveType: 'leave', LeaveBooking: 'leave',
  Competency: 'competencies', CompetencyFramework: 'competencies', CompetencyRecord: 'competencies',
  Exam: 'assessments', tblExam: 'assessments', tblTest: 'assessments', tblQ: 'assessments',
  tblFormTemplate: 'assessments', tblFormSubmission: 'assessments',
  KBArticle: 'documents', tblFiles: 'documents', PPTX: 'documents',
  AIContent: 'ai_outputs',
  tblClass: 'training', tblRoster: 'training', tblRegister: 'training', Assignment: 'training', Attendance: 'training',
  Equipment: 'equipment', EquipmentType: 'equipment', EquipmentService: 'equipment', EquipmentBreakdown: 'equipment',
});
const ACTION_MAP = Object.freeze({
  CREATE: 'create', UPDATE: 'update', DELETE: 'delete',
  UPLOAD: 'create', UPLOAD_DOC: 'create', DELETE_DOC: 'delete',
  ROLE_ADD: 'assign', ROLE_REMOVE: 'update', ASSIGN: 'assign', ASSESS: 'assess',
  BOOK: 'create', SIGN: 'verify', STATUS: 'update', MOVE: 'update', EDIT: 'update',
  EMAIL: 'update', PROMOTE: 'update', MEDICAL: 'update', MARK_ALL_PRESENT: 'update',
  SUPERVISOR_SIGN: 'verify', TEMPLATE_FORM_UPLOAD: 'create', TEMPLATE_FORM_DELETE: 'delete',
  PPTX_UPLOAD: 'create', PPTX_DELETE: 'delete', PPTX_BUILD: 'generate_ai', DEVELOP: 'generate_ai',
  DUPLICATE: 'create', FROM_MASTER: 'create', APPROVE_TRANSLATION: 'approve', TRANSLATE: 'translate',
  'AI-EXTRACT': 'generate_ai', EXAM: 'assess', SAVE: 'update', COVER: 'generate_ai', CERTIFICATE: 'certify',
  lock: 'update', unlock: 'update', 'shift-type': 'create',
});

// Free-text sensitive categories that cause a VALUE to be dropped entirely.
// (credentials/pii/financial are pattern-masked, not whole-value dropped.)
const CONTENT_DROP = new Set(['medical', 'disciplinary_freetext', 'ai_content']);

// ── sanitization primitives (self-contained; dependency-free) ───────────────
function maskString(input) {
  let out = String(input);
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, '[REDACTED]');
  out = out.replace(/connect\.sid=\S+/gi, 'connect.sid=[REDACTED]');
  out = out.replace(/\b\d{6,}\b/g, '[REDACTED]');
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN);
  return out;
}
function maskCap(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return maskString(value);
  return null; // objects/arrays/functions/symbols dropped
}
function scalar(value, cap) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const s = maskString(String(value));
    const limit = typeof cap === 'number' ? cap : MAX_LEN;
    return s.length > limit ? s.slice(0, limit) : s;
  }
  return null;
}

// ── public mapping helpers (pure; never throw) ──────────────────────────────
function mapLegacyTable(table) {
  return (typeof table === 'string' && Object.prototype.hasOwnProperty.call(TABLE_MAP, table))
    ? TABLE_MAP[table] : FALLBACK_ENTITY;
}
function mapLegacyAction(action) {
  if (typeof action !== 'string') return FALLBACK_ACTION;
  if (Object.prototype.hasOwnProperty.call(ACTION_MAP, action)) return ACTION_MAP[action];
  const up = action.toUpperCase();
  return Object.prototype.hasOwnProperty.call(ACTION_MAP, up) ? ACTION_MAP[up] : FALLBACK_ACTION;
}
function listLegacyTableMappings() { return { ...TABLE_MAP }; }
function listLegacyActionMappings() { return { ...ACTION_MAP }; }

// Sanitize a legacy Old/New value given the resolved entity's sensitive
// categories: drop free-text for content-sensitive entities; else mask + cap.
function sanitizeLegacyAuditValues(sensitiveCategories, value) {
  const cats = Array.isArray(sensitiveCategories) ? sensitiveCategories : [];
  if (cats.some((c) => CONTENT_DROP.has(c))) return (value === null || value === undefined) ? null : '[REDACTED]';
  return maskCap(value);
}

// Detect a request-like first argument.
function isRequestLike(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (v.session || v.body || v.headers || v.method || (v.user && typeof v.user === 'object'));
}
// Resolve actor from a request-like object — username sources only; never a
// session id/cookie/authorization/body payload.
function actorFromRequest(req) {
  const u = (req.session && req.session.user && req.session.user.username)
    || (req.user && req.user.username)
    || (req.body && typeof req.body.username === 'string' ? req.body.username : null);
  if (typeof u === 'string' && u.trim() !== '') return scalar(u, 128);
  try {
    const ctx = requestContext.get();
    if (ctx && typeof ctx.actor === 'string' && ctx.actor.trim() !== '') return scalar(ctx.actor, 128);
  } catch { /* ignore */ }
  return 'system';
}
function resolveStandardActor(user) {
  if (typeof user === 'string' && user.trim() !== '') return scalar(user, 128);
  try {
    const ctx = requestContext.get();
    if (ctx && typeof ctx.actor === 'string' && ctx.actor.trim() !== '') return scalar(ctx.actor, 128);
  } catch { /* ignore */ }
  return 'system';
}

// Normalize either calling convention into a common arg object. Never throws.
//   standard: (user, table, action, recordId, field, oldValue, newValue)
//   req-first: (req,  table, action, recordId, field, oldValue, newValue)
function normalizeLegacyArgs(args) {
  const a = Array.isArray(args) ? args : [];
  const reqForm = isRequestLike(a[0]);
  return {
    convention: reqForm ? 'req' : 'standard',
    actor: reqForm ? actorFromRequest(a[0]) : resolveStandardActor(a[0]),
    table: a[1],
    action: a[2],
    recordId: a[3],
    field: a[4],
    oldValue: a[5],
    newValue: a[6],
  };
}

// Prepare and (in isolated tests only) write a sanitized, shape-preserving row to
// the EXISTING tblAudit. Never throws; fails open. Returns { ok, written, reason,
// record, mapping }.
async function recordLegacyAudit(...args) {
  try {
    const n = normalizeLegacyArgs(args);
    const entity = mapLegacyTable(n.table);
    const action = mapLegacyAction(n.action);
    const sensitiveCategories = getEntity(entity).sensitiveCategories;
    const record = {
      AuditUser: n.actor,
      AuditTable: typeof n.table === 'string' ? scalar(n.table, 128) : null, // preserve legacy string
      AuditAction: typeof n.action === 'string' ? scalar(n.action, 128) : null, // preserve legacy string
      AuditRecord: scalar(n.recordId, 128),
      AuditField: typeof n.field === 'string' ? scalar(n.field, 128) : null,
      OldValue: sanitizeLegacyAuditValues(sensitiveCategories, n.oldValue),
      NewValue: sanitizeLegacyAuditValues(sensitiveCategories, n.newValue),
    };
    const mapping = { legacyTable: (typeof n.table === 'string' ? n.table : null), legacyAction: (typeof n.action === 'string' ? n.action : null), entity, action, sensitiveCategories: [...sensitiveCategories] };
    try {
      const { dbRun } = require('../../database/db'); // lazy — never touched by the pure helpers
      await dbRun(
        `INSERT INTO tblAudit (AuditDate,AuditUser,AuditTable,AuditAction,AuditRecord,AuditField,OldValue,NewValue)
         VALUES (datetime('now'),?,?,?,?,?,?,?)`,
        [record.AuditUser, record.AuditTable, record.AuditAction, record.AuditRecord, record.AuditField, record.OldValue, record.NewValue],
      );
      return { ok: true, written: true, reason: 'written', record, mapping };
    } catch {
      return { ok: true, written: false, reason: 'write_failed', record, mapping }; // fail open
    }
  } catch {
    return { ok: true, written: false, reason: 'error', record: null, mapping: null }; // fail open
  }
}

module.exports = {
  recordLegacyAudit,
  mapLegacyTable,
  mapLegacyAction,
  normalizeLegacyArgs,
  sanitizeLegacyAuditValues,
  listLegacyTableMappings,
  listLegacyActionMappings,
};
