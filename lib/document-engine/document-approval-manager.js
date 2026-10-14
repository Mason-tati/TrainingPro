// WP-18 · E11 — Document approval manager (Enterprise Document Engine).
//
// Evaluates approval requirements, chains, decisions, and state entirely in memory. NOT a
// workflow/lifecycle engine and NOT persistence — it only decides what approval actions are
// valid and produces deterministic approval objects. Scheme-aware via the WP-17 approval
// workflow registry (its only import). Deterministic, never throws, never mutates callers,
// deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentApprovalWorkflow, isKnownDocumentApprovalWorkflow } = require('../document/document-approval-workflows');

const APPROVAL_STATES = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'DELEGATED', 'COMPLETED', 'UNKNOWN'];
const STATE_SET = new Set(APPROVAL_STATES);
const TERMINAL = new Set(['APPROVED', 'REJECTED', 'WITHDRAWN', 'COMPLETED']);

const APPROVAL_FIELDS = [
  ['approvalId', 'string'],
  ['workflow', 'string'],
  ['status', 'string'],
  ['currentStage', 'int'],
  ['totalStages', 'int'],
  ['approvers', 'array'],
  ['approvedBy', 'array'],
  ['rejectedBy', 'array'],
  ['delegatedBy', 'array'],
  ['delegateTo', 'array'],
  ['decision', 'string'],
  ['reason', 'string'],
  ['timestamp', 'date'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-approval.v1';
const ID_ARRAY_FIELDS = ['approvers', 'approvedBy', 'rejectedBy', 'delegatedBy', 'delegateTo'];

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function pickString(...args) { for (const a of args) if (typeof a === 'string' && a !== '') return a; return undefined; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

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

function coerce(kind, val) {
  if (kind === 'string') return (val === undefined || val === null) ? '' : String(val);
  if (kind === 'int') { if (Number.isInteger(val)) return val; return (typeof val === 'number' && Number.isFinite(val)) ? Math.trunc(val) : 0; }
  if (kind === 'date') return (typeof val === 'string' && val !== '') ? val : null;
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

function uniqPush(arr, value) { return arr.includes(value) ? arr.slice() : arr.concat([value]); }
function minApproversOf(wf) { return (Number.isInteger(wf.minApprovers) && wf.minApprovers > 0) ? wf.minApprovers : 1; }
function applyDecisionMeta(next, opts) {
  if (typeof opts.reason === 'string') next.reason = opts.reason;
  if (typeof opts.timestamp === 'string') next.timestamp = opts.timestamp;
  return next;
}

// ---- public ----

function createApproval(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const a = {};
  for (const [name, kind] of APPROVAL_FIELDS) a[name] = coerce(kind, src[name]);
  const workflowId = pickString(src.workflow, opts.workflow, opts.defaultWorkflow);
  a.workflow = (workflowId === undefined) ? 'NONE' : workflowId;
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  a.status = (statusId === undefined) ? 'PENDING' : statusId;
  a.currentStage = (a.currentStage >= 1) ? a.currentStage : 1;
  a.totalStages = (a.totalStages >= 1) ? a.totalStages : 1;
  return a;
}

function cloneApproval(approval) { return deepClone(obj(approval)); }
function freezeApproval(approval) { return deepFreeze(deepClone(obj(approval))); }

// ---- decision checks ----

function approveCheck(cur, approver, opts, wf) {
  const errors = [];
  if (TERMINAL.has(cur.status)) errors.push({ field: 'status', code: 'NOT_APPROVABLE', message: `cannot approve in status ${cur.status}` });
  if (!isNonEmptyString(approver)) errors.push({ field: 'approver', code: 'INVALID_APPROVER', message: 'approver must be a non-empty string' });
  else if (cur.approvedBy.includes(approver)) errors.push({ field: 'approver', code: 'DUPLICATE_APPROVER', message: `${approver} has already approved` });
  if (opts.self === true && wf.allowSelfApproval !== true) errors.push({ field: 'approver', code: 'SELF_APPROVAL_NOT_ALLOWED', message: 'self-approval is not permitted' });
  return { valid: errors.length === 0, errors, warnings: [] };
}
function rejectCheck(cur, rejector) {
  const errors = [];
  if (TERMINAL.has(cur.status)) errors.push({ field: 'status', code: 'NOT_APPROVABLE', message: `cannot reject in status ${cur.status}` });
  if (!isNonEmptyString(rejector)) errors.push({ field: 'rejector', code: 'INVALID_REJECTOR', message: 'rejector must be a non-empty string' });
  return { valid: errors.length === 0, errors, warnings: [] };
}
function delegateCheck(cur, from, to, wf) {
  const errors = [];
  if (TERMINAL.has(cur.status)) errors.push({ field: 'status', code: 'NOT_APPROVABLE', message: `cannot delegate in status ${cur.status}` });
  if (wf.allowDelegation !== true) errors.push({ field: 'workflow', code: 'DELEGATION_NOT_ALLOWED', message: 'workflow does not permit delegation' });
  if (!isNonEmptyString(from)) errors.push({ field: 'from', code: 'INVALID_DELEGATOR', message: 'delegator must be a non-empty string' });
  if (!isNonEmptyString(to)) errors.push({ field: 'to', code: 'INVALID_DELEGATE', message: 'delegate must be a non-empty string' });
  return { valid: errors.length === 0, errors, warnings: [] };
}

function canApprove(approval, approver, options) {
  const cur = createApproval(approval);
  return approveCheck(cur, approver, obj(options), getDocumentApprovalWorkflow(cur.workflow)).valid;
}
function canReject(approval, rejector) {
  return rejectCheck(createApproval(approval), rejector).valid;
}
function canDelegate(approval, from, to) {
  const cur = createApproval(approval);
  return delegateCheck(cur, from, to, getDocumentApprovalWorkflow(cur.workflow)).valid;
}

// ---- decisions ----

function approve(approval, approver, options) {
  const opts = obj(options);
  const cur = createApproval(approval);
  const wf = getDocumentApprovalWorkflow(cur.workflow);
  const check = approveCheck(cur, approver, opts, wf);
  if (!check.valid) return { valid: false, errors: check.errors, warnings: check.warnings, approval: cur };
  const next = cloneApproval(cur);
  next.approvedBy = uniqPush(next.approvedBy, approver);
  next.decision = 'approve';
  const minA = minApproversOf(wf);
  const count = next.approvedBy.length;
  next.currentStage = Math.min(next.totalStages, Math.floor((count - 1) / minA) + 1);
  next.status = (count >= next.totalStages * minA) ? 'APPROVED' : 'UNDER_REVIEW';
  return { valid: true, errors: [], warnings: [], approval: applyDecisionMeta(next, opts) };
}

function reject(approval, rejector, options) {
  const opts = obj(options);
  const cur = createApproval(approval);
  const check = rejectCheck(cur, rejector);
  if (!check.valid) return { valid: false, errors: check.errors, warnings: check.warnings, approval: cur };
  const next = cloneApproval(cur);
  next.rejectedBy = uniqPush(next.rejectedBy, rejector);
  next.decision = 'reject';
  next.status = 'REJECTED';
  return { valid: true, errors: [], warnings: [], approval: applyDecisionMeta(next, opts) };
}

function delegate(approval, from, to, options) {
  const opts = obj(options);
  const cur = createApproval(approval);
  const wf = getDocumentApprovalWorkflow(cur.workflow);
  const check = delegateCheck(cur, from, to, wf);
  if (!check.valid) return { valid: false, errors: check.errors, warnings: check.warnings, approval: cur };
  const next = cloneApproval(cur);
  next.delegatedBy = uniqPush(next.delegatedBy, from);
  next.delegateTo = uniqPush(next.delegateTo, to);
  next.decision = 'delegate';
  next.status = 'DELEGATED';
  return { valid: true, errors: [], warnings: [], approval: applyDecisionMeta(next, opts) };
}

function withdraw(approval, options) {
  const opts = obj(options);
  const cur = createApproval(approval);
  if (TERMINAL.has(cur.status)) {
    return { valid: false, errors: [{ field: 'status', code: 'NOT_WITHDRAWABLE', message: `cannot withdraw in status ${cur.status}` }], warnings: [], approval: cur };
  }
  const next = cloneApproval(cur);
  next.decision = 'withdraw';
  next.status = 'WITHDRAWN';
  return { valid: true, errors: [], warnings: [], approval: applyDecisionMeta(next, opts) };
}

function restart(approval, options) {
  const opts = obj(options);
  const cur = createApproval(approval);
  const next = cloneApproval(cur);
  next.status = 'PENDING';
  next.currentStage = 1;
  next.approvedBy = [];
  next.rejectedBy = [];
  next.delegatedBy = [];
  next.delegateTo = [];
  next.decision = '';
  return { valid: true, errors: [], warnings: [], approval: applyDecisionMeta(next, opts) };
}

function nextStage(approval) {
  const next = createApproval(approval);
  if (next.currentStage < next.totalStages) next.currentStage += 1;
  return next;
}
function previousStage(approval) {
  const next = createApproval(approval);
  if (next.currentStage > 1) next.currentStage -= 1;
  return next;
}

// ---- validation ----

function validateApproval(approval) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(approval)) {
    result.errors.push({ field: null, code: 'INVALID_APPROVAL', message: 'approval must be a plain object' });
    result.valid = false;
    return result;
  }
  const workflowId = (typeof approval.workflow === 'string') ? approval.workflow.trim() : '';
  if (workflowId !== '' && !isKnownDocumentApprovalWorkflow(workflowId)) result.warnings.push({ field: 'workflow', code: 'UNKNOWN_WORKFLOW', message: `unknown workflow: ${workflowId}` });

  const status = (typeof approval.status === 'string') ? approval.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!STATE_SET.has(status)) result.errors.push({ field: 'status', code: 'INVALID_STATUS', message: `invalid status: ${status}` });

  for (const part of ['currentStage', 'totalStages']) {
    if (hasOwn(approval, part) && !(Number.isInteger(approval[part]) && approval[part] >= 1)) {
      result.errors.push({ field: part, code: 'INVALID_STAGE', message: `${part} must be a positive integer` });
    }
  }
  if (Number.isInteger(approval.currentStage) && Number.isInteger(approval.totalStages) && approval.currentStage > approval.totalStages) {
    result.errors.push({ field: 'currentStage', code: 'STAGE_RANGE', message: 'currentStage exceeds totalStages' });
  }
  if (Array.isArray(approval.approvedBy) && uniqDeep(approval.approvedBy).length !== approval.approvedBy.length) {
    result.errors.push({ field: 'approvedBy', code: 'DUPLICATE_APPROVER', message: 'approvedBy contains duplicates' });
  }
  if (Array.isArray(approval.approvedBy) && Array.isArray(approval.rejectedBy) && approval.approvedBy.some((x) => approval.rejectedBy.includes(x))) {
    result.warnings.push({ field: 'approvedBy', code: 'DECISION_CONFLICT', message: 'an approver also appears in rejectedBy' });
  }
  if ((status === 'APPROVED' || status === 'COMPLETED') && typeof approval.decision === 'string' && approval.decision !== '' && approval.decision !== 'approve') {
    result.warnings.push({ field: 'decision', code: 'DECISION_MISMATCH', message: `decision ${approval.decision} inconsistent with status ${status}` });
  }
  if (status === 'DELEGATED' && Array.isArray(approval.delegateTo) && approval.delegateTo.length === 0) {
    result.warnings.push({ field: 'delegateTo', code: 'MISSING_DELEGATE', message: 'delegated approval has no delegate' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeApproval(approval) {
  const a = createApproval(approval);
  for (const [name, kind] of APPROVAL_FIELDS) {
    if (kind === 'string' && typeof a[name] === 'string') a[name] = a[name].trim();
    else if (kind === 'object') a[name] = normalizeObject(a[name]);
    else if (kind === 'array') a[name] = normalizeArray(a[name]);
  }
  return a;
}

function mergeApproval(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeApproval(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareApproval(a, b) {
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

function generateApprovalSnapshot(approval) {
  const normalized = normalizeApproval(approval);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), approval: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createApproval,
  approve,
  reject,
  delegate,
  withdraw,
  restart,
  nextStage,
  previousStage,
  canApprove,
  canReject,
  canDelegate,
  validateApproval,
  normalizeApproval,
  cloneApproval,
  freezeApproval,
  mergeApproval,
  compareApproval,
  generateApprovalSnapshot,
};
