// WP-18 · E15 — Document access control manager (Enterprise Document Engine).
//
// Evaluates document permissions entirely in memory. NOT authentication, RBAC, or
// authorization middleware and NOT persistence — it only decides which permissions are
// effective and produces deterministic access objects with a derived status. Capability-aware
// via the WP-17 access registry (its only import). Deterministic, never throws, never mutates
// callers, deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentAccess, isKnownDocumentAccess } = require('../document/document-access');

const ACCESS_STATES = ['PENDING', 'GRANTED', 'PARTIALLY_GRANTED', 'DENIED', 'REVOKED', 'EXPIRED', 'UNKNOWN'];
const STATE_SET = new Set(ACCESS_STATES);
const KNOWN_PERMISSIONS = ['read', 'create', 'edit', 'delete', 'review', 'approve', 'publish', 'archive', 'restore', 'supersede', 'translate', 'export', 'print', 'download', 'assignTraining', 'assignAssessment', 'manageRelationships', 'manageMetadata'];
const PERMISSION_SET = new Set(KNOWN_PERMISSIONS);

const ACCESS_FIELDS = [
  ['accessId', 'string'],
  ['accessType', 'string'],
  ['status', 'string'],
  ['principal', 'string'],
  ['principalType', 'string'],
  ['permissions', 'array'],
  ['grantedPermissions', 'array'],
  ['deniedPermissions', 'array'],
  ['effectivePermissions', 'array'],
  ['requiresAuthentication', 'bool'],
  ['requiresActiveEmployment', 'bool'],
  ['decision', 'string'],
  ['comments', 'string'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-access.v1';

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
  if (kind === 'bool') return val === true;
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

function uniqPush(arr, value) { return arr.includes(value) ? arr.slice() : arr.concat([value]); }
function without(arr, value) { return arr.filter((x) => x !== value); }
function applyMeta(next, opts) {
  if (typeof opts.comments === 'string') next.comments = opts.comments;
  return next;
}

function permissionCapability(mode, permission) {
  const flag = `can${permission.charAt(0).toUpperCase()}${permission.slice(1)}`;
  return mode[flag] === true;
}

function computeEffective(access) {
  const mode = getDocumentAccess(access.accessType);
  const effective = access.permissions.filter((p) => (
    (access.grantedPermissions.includes(p) || permissionCapability(mode, p)) && !access.deniedPermissions.includes(p)
  ));
  return uniqDeep(effective);
}

function deriveStatus(permissions, effective) {
  if (permissions.length === 0) return 'PENDING';
  if (effective.length === 0) return 'DENIED';
  if (permissions.every((p) => effective.includes(p))) return 'GRANTED';
  return 'PARTIALLY_GRANTED';
}

function evaluate(access) {
  access.effectivePermissions = computeEffective(access);
  access.status = deriveStatus(access.permissions, access.effectivePermissions);
  return access;
}

// ---- public ----

function createAccess(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const a = {};
  for (const [name, kind] of ACCESS_FIELDS) a[name] = coerce(kind, src[name]);
  const typeId = pickString(src.accessType, opts.accessType, opts.defaultType);
  a.accessType = (typeId === undefined) ? 'NONE' : typeId;
  const mode = getDocumentAccess(a.accessType);
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  a.status = (statusId === undefined) ? 'PENDING' : statusId;
  a.requiresAuthentication = hasOwn(src, 'requiresAuthentication') ? (src.requiresAuthentication === true) : mode.requiresAuthentication;
  a.requiresActiveEmployment = hasOwn(src, 'requiresActiveEmployment') ? (src.requiresActiveEmployment === true) : mode.requiresActiveEmployment;
  a.effectivePermissions = computeEffective(a);
  return a;
}

function cloneAccess(access) { return deepClone(obj(access)); }
function freezeAccess(access) { return deepFreeze(deepClone(obj(access))); }

function evaluatePermissions(access) { return evaluate(createAccess(access)); }

function actionCheck(cur, permission) {
  const errors = [];
  if (cur.status === 'EXPIRED') errors.push({ field: 'status', code: 'NOT_MODIFIABLE', message: 'access has expired' });
  if (!isNonEmptyString(permission)) errors.push({ field: 'permission', code: 'INVALID_PERMISSION', message: 'permission must be a non-empty string' });
  return errors;
}

function grantPermission(access, permission, options) {
  const opts = obj(options);
  const cur = createAccess(access);
  const errors = actionCheck(cur, permission);
  if (errors.length > 0) return { valid: false, errors, warnings: [], access: cur };
  const next = cloneAccess(cur);
  next.permissions = uniqPush(next.permissions, permission);
  next.grantedPermissions = uniqPush(next.grantedPermissions, permission);
  next.deniedPermissions = without(next.deniedPermissions, permission);
  next.decision = 'grant';
  return { valid: true, errors: [], warnings: [], access: applyMeta(evaluate(next), opts) };
}

function denyPermission(access, permission, options) {
  const opts = obj(options);
  const cur = createAccess(access);
  const errors = actionCheck(cur, permission);
  if (errors.length > 0) return { valid: false, errors, warnings: [], access: cur };
  const next = cloneAccess(cur);
  next.permissions = uniqPush(next.permissions, permission);
  next.deniedPermissions = uniqPush(next.deniedPermissions, permission);
  next.grantedPermissions = without(next.grantedPermissions, permission);
  next.decision = 'deny';
  return { valid: true, errors: [], warnings: [], access: applyMeta(evaluate(next), opts) };
}

function revokePermission(access, permission, options) {
  const opts = obj(options);
  const cur = createAccess(access);
  const errors = actionCheck(cur, permission);
  if (errors.length === 0 && !cur.permissions.includes(permission)) errors.push({ field: 'permission', code: 'NOT_APPLICABLE', message: `${permission} is not a requested permission` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], access: cur };
  const next = cloneAccess(cur);
  next.grantedPermissions = without(next.grantedPermissions, permission);
  next.deniedPermissions = uniqPush(next.deniedPermissions, permission);
  next.decision = 'revoke';
  evaluate(next);
  if (next.status === 'DENIED') next.status = 'REVOKED';
  return { valid: true, errors: [], warnings: [], access: applyMeta(next, opts) };
}

function expireAccess(access, options) {
  const opts = obj(options);
  const cur = createAccess(access);
  if (cur.status === 'EXPIRED') {
    return { valid: false, errors: [{ field: 'status', code: 'ALREADY_EXPIRED', message: 'access is already expired' }], warnings: [], access: cur };
  }
  const next = cloneAccess(cur);
  next.decision = 'expire';
  evaluate(next);
  next.status = 'EXPIRED';
  return { valid: true, errors: [], warnings: [], access: applyMeta(next, opts) };
}

function validateAccess(access) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(access)) {
    result.errors.push({ field: null, code: 'INVALID_ACCESS', message: 'access must be a plain object' });
    result.valid = false;
    return result;
  }
  const typeId = (typeof access.accessType === 'string') ? access.accessType.trim() : '';
  if (typeId !== '' && !isKnownDocumentAccess(typeId)) result.warnings.push({ field: 'accessType', code: 'UNKNOWN_ACCESS_TYPE', message: `unknown access type: ${typeId}` });

  const status = (typeof access.status === 'string') ? access.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!STATE_SET.has(status)) result.errors.push({ field: 'status', code: 'INVALID_STATUS', message: `invalid status: ${status}` });

  if (Array.isArray(access.permissions) && uniqDeep(access.permissions).length !== access.permissions.length) {
    result.errors.push({ field: 'permissions', code: 'DUPLICATE_PERMISSION', message: 'permissions contains duplicates' });
  }
  if (Array.isArray(access.permissions) && access.permissions.some((p) => !PERMISSION_SET.has(p))) {
    result.warnings.push({ field: 'permissions', code: 'UNKNOWN_PERMISSION', message: 'permissions contains an unrecognised permission' });
  }
  if (Array.isArray(access.grantedPermissions) && Array.isArray(access.deniedPermissions)
      && access.grantedPermissions.some((p) => access.deniedPermissions.includes(p))) {
    result.warnings.push({ field: 'grantedPermissions', code: 'GRANT_DENY_CONFLICT', message: 'a permission is both granted and denied' });
  }
  if (Array.isArray(access.effectivePermissions) && Array.isArray(access.deniedPermissions)
      && access.effectivePermissions.some((p) => access.deniedPermissions.includes(p))) {
    result.warnings.push({ field: 'effectivePermissions', code: 'INCONSISTENT_EFFECTIVE', message: 'an effective permission is also denied' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeAccess(access) {
  const a = createAccess(access);
  for (const [name, kind] of ACCESS_FIELDS) {
    if (kind === 'string' && typeof a[name] === 'string') a[name] = a[name].trim();
    else if (kind === 'object') a[name] = normalizeObject(a[name]);
    else if (kind === 'array') a[name] = normalizeArray(a[name]);
  }
  return a;
}

function mergeAccess(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeAccess(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareAccess(a, b) {
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

function generateAccessSnapshot(access) {
  const normalized = normalizeAccess(access);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), access: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createAccess,
  grantPermission,
  denyPermission,
  revokePermission,
  expireAccess,
  validateAccess,
  normalizeAccess,
  cloneAccess,
  freezeAccess,
  mergeAccess,
  compareAccess,
  generateAccessSnapshot,
  evaluatePermissions,
};
