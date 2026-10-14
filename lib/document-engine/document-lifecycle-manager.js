// WP-18 · E10 — Document lifecycle manager (Enterprise Document Engine).
//
// Determines which lifecycle status changes are legal and produces deterministic
// transition results, entirely in memory. NOT a workflow/approval engine and NOT
// persistence — it only decides legality and shapes lifecycle objects. Scheme-aware via
// the WP-17 status + workflow registries (its only imports). Deterministic, never throws,
// never mutates callers, deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentStatus, DOCUMENT_STATUS_IDS } = require('../document/document-status');
const { getDocumentWorkflow, isKnownDocumentWorkflow } = require('../document/document-workflows');

// Canonical forward lifecycle graph over the WP-17 statuses.
const FORWARD = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['UNDER_APPROVAL'],
  UNDER_APPROVAL: ['APPROVED'],
  APPROVED: ['PUBLISHED'],
  PUBLISHED: ['SUPERSEDED', 'ARCHIVED', 'OBSOLETE'],
  SUPERSEDED: ['ARCHIVED'],
  ARCHIVED: [],
  OBSOLETE: [],
};
// Backward (rollback) transitions — permitted only when the workflow supports rollback.
const ROLLBACK = {
  DRAFT: [],
  IN_REVIEW: ['DRAFT'],
  UNDER_APPROVAL: ['IN_REVIEW'],
  APPROVED: ['UNDER_APPROVAL'],
  PUBLISHED: ['APPROVED'],
  SUPERSEDED: [],
  ARCHIVED: [],
  OBSOLETE: [],
};

const LIFECYCLE_FIELDS = [
  ['status', 'string'],
  ['previousStatus', 'string'],
  ['workflow', 'string'],
  ['reason', 'string'],
  ['performedBy', 'string'],
  ['approvedBy', 'string'],
  ['timestamp', 'date'],
  ['effectiveDate', 'date'],
  ['comment', 'string'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-lifecycle.v1';
const DATE_FIELDS = ['timestamp', 'effectiveDate'];

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function pickString(...args) { for (const a of args) if (typeof a === 'string' && a !== '') return a; return undefined; }
function isKnownStatus(id) { return typeof id === 'string' && DOCUMENT_STATUS_IDS.includes(id); }

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
function canon(x) { return (x !== null && typeof x === 'object') ? JSON.stringify(x) : `${typeof x}:${String(x)}`; }
function uniqDeep(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { const k = canon(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
function normalizeAny(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return normalizeArray(v);
  if (isPlainObject(v)) return normalizeObject(v);
  return v;
}
function normalizeArray(arr) {
  const mapped = arr.map(normalizeAny).filter((x) => x !== '');
  return uniqDeep(mapped).map((x) => [canon(x), x]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((p) => p[1]);
}
function normalizeObject(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = normalizeAny(o[k]);
  return out;
}

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  const md = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > md) return false;
  if (m[4] !== undefined) { if (Number(m[4]) > 23 || Number(m[5]) > 59) return false; if (m[6] !== undefined && Number(m[6]) > 59) return false; }
  return true;
}

function coerce(kind, val) {
  if (kind === 'string') return (val === undefined || val === null) ? '' : String(val);
  if (kind === 'date') return (typeof val === 'string' && val !== '') ? val : null;
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

// ---- transition legality ----

function transitionCheck(from, to, workflowId) {
  const errors = [];
  const warnings = [];
  const f = (typeof from === 'string') ? from : '';
  const t = (typeof to === 'string') ? to : '';
  const fromKnown = isKnownStatus(f);
  const toKnown = isKnownStatus(t);
  if (!fromKnown) errors.push({ field: 'from', code: 'UNKNOWN_FROM_STATUS', message: `unknown from status: ${f}` });
  if (!toKnown) errors.push({ field: 'to', code: 'UNKNOWN_TO_STATUS', message: `unknown to status: ${t}` });
  const wf = getDocumentWorkflow(workflowId);
  let kind = 'illegal';
  if (fromKnown && toKnown) {
    if (f === t) kind = 'noop';
    else if (FORWARD[f].includes(t)) kind = 'forward';
    else if (ROLLBACK[f].includes(t)) {
      if (wf.supportsRollback) kind = 'rollback';
      else errors.push({ field: 'to', code: 'ROLLBACK_NOT_ALLOWED', message: `rollback ${f}→${t} not permitted by workflow ${wf.id}` });
    } else {
      errors.push({ field: 'to', code: 'ILLEGAL_TRANSITION', message: `illegal transition ${f}→${t}` });
    }
  }
  return { valid: errors.length === 0, kind, errors, warnings, workflow: wf.id };
}

// ---- public ----

function createLifecycle(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const lc = {};
  for (const [name, kind] of LIFECYCLE_FIELDS) lc[name] = coerce(kind, src[name]);
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  lc.status = (statusId === undefined) ? 'DRAFT' : statusId;
  const workflowId = pickString(src.workflow, opts.workflow, opts.defaultWorkflow);
  lc.workflow = (workflowId === undefined) ? 'NONE' : workflowId;
  return lc;
}

function canTransition(from, to, workflowId) { return transitionCheck(from, to, workflowId).valid; }
function validateTransition(from, to, workflowId) { return transitionCheck(from, to, workflowId); }

function transition(current, to, options) {
  const opts = obj(options);
  const cur = createLifecycle(current);
  const workflowId = pickString(opts.workflow, cur.workflow);
  const check = transitionCheck(cur.status, to, workflowId);
  const targetStatus = check.valid ? to : cur.status; // when valid, `to` is a known status string
  const lifecycle = createLifecycle({
    status: targetStatus,
    previousStatus: cur.status,
    workflow: workflowId,
    reason: opts.reason,
    performedBy: opts.performedBy,
    approvedBy: opts.approvedBy,
    timestamp: opts.timestamp,
    effectiveDate: opts.effectiveDate,
    comment: opts.comment,
    metadata: opts.metadata,
    futureReserved: cur.futureReserved,
  });
  return { valid: check.valid, kind: check.kind, errors: check.errors, warnings: check.warnings, lifecycle };
}

function validateLifecycle(lifecycle) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(lifecycle)) {
    result.errors.push({ field: null, code: 'INVALID_LIFECYCLE', message: 'lifecycle must be a plain object' });
    result.valid = false;
    return result;
  }
  const status = (typeof lifecycle.status === 'string') ? lifecycle.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!isKnownStatus(status)) result.errors.push({ field: 'status', code: 'UNKNOWN_STATUS', message: `unknown status: ${status}` });

  const prev = (typeof lifecycle.previousStatus === 'string') ? lifecycle.previousStatus.trim() : '';
  if (prev !== '' && !isKnownStatus(prev)) result.warnings.push({ field: 'previousStatus', code: 'UNKNOWN_PREVIOUS_STATUS', message: `unknown previousStatus: ${prev}` });

  const workflowId = (typeof lifecycle.workflow === 'string') ? lifecycle.workflow.trim() : '';
  if (workflowId !== '' && !isKnownDocumentWorkflow(workflowId)) result.warnings.push({ field: 'workflow', code: 'UNKNOWN_WORKFLOW', message: `unknown workflow: ${workflowId}` });

  for (const df of DATE_FIELDS) {
    if (hasOwn(lifecycle, df) && lifecycle[df] !== null && lifecycle[df] !== undefined && !isValidDateString(lifecycle[df])) {
      result.errors.push({ field: df, code: 'INVALID_DATE', message: `${df} is not a valid date` });
    }
  }
  if (isValidDateString(lifecycle.timestamp) && isValidDateString(lifecycle.effectiveDate) && lifecycle.effectiveDate < lifecycle.timestamp) {
    result.warnings.push({ field: 'effectiveDate', code: 'DATE_ORDER', message: 'effectiveDate precedes timestamp' });
  }
  if (prev !== '' && isKnownStatus(prev) && isKnownStatus(status)) {
    const check = transitionCheck(prev, status, workflowId);
    if (!check.valid) result.errors.push({ field: 'status', code: 'ILLEGAL_TRANSITION', message: `illegal transition ${prev}→${status}` });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeLifecycle(lifecycle) {
  const lc = createLifecycle(lifecycle);
  for (const [name, kind] of LIFECYCLE_FIELDS) {
    if (kind === 'string' && typeof lc[name] === 'string') lc[name] = lc[name].trim();
    else if (kind === 'object') lc[name] = normalizeObject(lc[name]);
    else if (kind === 'array') lc[name] = normalizeArray(lc[name]);
  }
  return lc;
}

function cloneLifecycle(lifecycle) { return deepClone(obj(lifecycle)); }
function freezeLifecycle(lifecycle) { return deepFreeze(deepClone(obj(lifecycle))); }

function mergeLifecycle(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeLifecycle(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareLifecycle(a, b) {
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

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (`0000000${h.toString(16)}`).slice(-8);
}

function generateLifecycleSnapshot(lifecycle) {
  const normalized = normalizeLifecycle(lifecycle);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), lifecycle: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createLifecycle,
  transition,
  canTransition,
  validateTransition,
  validateLifecycle,
  normalizeLifecycle,
  cloneLifecycle,
  freezeLifecycle,
  mergeLifecycle,
  compareLifecycle,
  generateLifecycleSnapshot,
};
