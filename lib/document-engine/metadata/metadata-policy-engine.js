// WP-18 · E7 — Metadata policy engine (Enterprise Document Engine).
//
// Consumes the metadata-policy registry to validate metadata against a policy, apply policy
// defaults, inherit/merge/compare/normalize policies, and clone/freeze them. Pure — the only
// import is the sibling policy registry. Every public method is deterministic, never throws,
// and never mutates caller objects (deep clone in, frozen copies out on request). UNWIRED.
'use strict';

const { getMetadataPolicy, listMetadataPolicies } = require('./metadata-policy');

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

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
    for (const k of ka) {
      if (!hasOwn(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function deepFreeze(value) {
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    return Object.freeze(value);
  }
  return value;
}

function keyOf(x) {
  return (typeof x) + ' ' + ((x !== null && typeof x === 'object') ? JSON.stringify(x) : String(x));
}
function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyOf(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

const REQUIRE_FLAG_FIELDS = {
  requireOwner: 'Owner', requireAuthor: 'Author', requireDepartment: 'Department', requireSite: 'Site',
  requireReviewDate: 'ReviewDate', requireEffectiveDate: 'EffectiveDate', requireClassification: 'Classification',
  requireCompliance: 'ComplianceFramework', requireLanguage: 'Language', requireVersion: 'Version',
};
const RESERVED_FIELDS = ['CreatedBy', 'CreatedDate', 'UpdatedBy', 'UpdatedDate'];
const RESERVED = new Set(RESERVED_FIELDS);

const POLICY_FIELDS = [
  'id', 'displayName', 'description', 'requiredFields', 'optionalFields', 'readOnlyFields', 'inheritFields',
  'allowedCustomFields', 'allowUnknownFields', 'allowReservedFields', 'requireOwner', 'requireAuthor',
  'requireDepartment', 'requireSite', 'requireReviewDate', 'requireEffectiveDate', 'requireClassification',
  'requireCompliance', 'requireLanguage', 'requireVersion', 'futureReserved',
];
const DEFAULT_POLICY_PRECEDENCE = ['site', 'department', 'classification', 'documentType', 'template', 'parent'];

// ---- public: registry passthrough ----

function getPolicy(id) { return getMetadataPolicy(id); }
function listPolicies() { return listMetadataPolicies(); }

// ---- policy resolution ----

// Resolve a policy from an id (registry lookup, UNKNOWN default) or a partial policy object
// (completed with the UNKNOWN defaults). Anything else → the UNKNOWN default. Never throws.
function resolvePolicy(policyOrId) {
  if (typeof policyOrId === 'string') return getMetadataPolicy(policyOrId);
  if (isPlainObject(policyOrId)) return mergePolicies(getMetadataPolicy(null), policyOrId, { arrays: 'replace' });
  return getMetadataPolicy(null);
}

function requiredFrom(policy) {
  const req = Array.isArray(policy.requiredFields) ? policy.requiredFields.slice() : [];
  for (const flag of Object.keys(REQUIRE_FLAG_FIELDS)) {
    if (policy[flag] === true) req.push(REQUIRE_FLAG_FIELDS[flag]);
  }
  return uniq(req);
}

function permittedFrom(policy, required) {
  const set = new Set(required);
  for (const key of ['optionalFields', 'readOnlyFields', 'inheritFields']) {
    const arr = policy[key];
    if (Array.isArray(arr)) for (const f of arr) set.add(f);
  }
  set.add('CustomFields');
  return set;
}

function isMissing(v) {
  return v === undefined || v === null
    || (typeof v === 'string' && v.trim() === '')
    || (Array.isArray(v) && v.length === 0);
}

// ---- public: validation ----

function validateAgainstPolicy(metadata, policyOrId, options) {
  const opts = obj(options);
  const policy = resolvePolicy(policyOrId);
  const result = { valid: true, errors: [], warnings: [], missingFields: [], unknownFields: [] };
  if (!isPlainObject(metadata)) {
    result.errors.push({ field: null, code: 'INVALID_METADATA', message: 'metadata must be a plain object' });
    result.valid = false;
    return result;
  }
  const required = requiredFrom(policy);
  const permitted = permittedFrom(policy, required);
  const readOnly = new Set(Array.isArray(policy.readOnlyFields) ? policy.readOnlyFields : []);

  for (const rf of required) {
    if (isMissing(metadata[rf])) {
      result.missingFields.push(rf);
      result.errors.push({ field: rf, code: 'MISSING_REQUIRED', message: `${rf} is required` });
    }
  }

  for (const k of Object.keys(metadata)) {
    if (RESERVED.has(k)) {
      if (policy.allowReservedFields) result.warnings.push({ field: k, code: 'RESERVED_FIELD', message: `${k} is reserved` });
      else result.errors.push({ field: k, code: 'RESERVED_NOT_ALLOWED', message: `${k} is reserved and not allowed` });
      continue;
    }
    if (readOnly.has(k)) result.warnings.push({ field: k, code: 'READ_ONLY', message: `${k} is read-only` });
    if (!permitted.has(k)) {
      result.unknownFields.push(k);
      const entry = { field: k, code: 'UNKNOWN_FIELD', message: `unknown field: ${k}` };
      if (policy.allowUnknownFields) result.warnings.push(entry); else result.errors.push(entry);
    }
  }

  const cf = metadata.CustomFields;
  if (isPlainObject(cf)) {
    const allowed = Array.isArray(policy.allowedCustomFields) ? policy.allowedCustomFields : [];
    const wildcard = allowed.includes('*');
    for (const ck of Object.keys(cf)) {
      if (!wildcard && !allowed.includes(ck)) {
        const field = `CustomFields.${ck}`;
        result.unknownFields.push(field);
        const entry = { field, code: 'CUSTOM_NOT_ALLOWED', message: `custom field not allowed: ${ck}` };
        if (policy.allowUnknownFields) result.warnings.push(entry); else result.errors.push(entry);
      }
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}

// ---- public: conform metadata to a policy ----

function applyDefaults(metadata, policyOrId, options) {
  const opts = obj(options);
  const policy = resolvePolicy(policyOrId);
  const out = deepClone(obj(metadata));
  const required = requiredFrom(policy);
  const permitted = permittedFrom(policy, required);
  const readOnly = new Set(Array.isArray(policy.readOnlyFields) ? policy.readOnlyFields : []);
  for (const k of Object.keys(out)) {
    if (RESERVED.has(k) && !policy.allowReservedFields) { delete out[k]; continue; }
    if (readOnly.has(k) && opts.stripReadOnly !== false) { delete out[k]; continue; }
    if (!permitted.has(k) && !policy.allowUnknownFields) { delete out[k]; }
  }
  return out;
}

// ---- public: inheritance across policy sources ----

function inheritPolicy(sources, options) {
  const opts = obj(options);
  const order = (Array.isArray(opts.precedence) && opts.precedence.length > 0) ? opts.precedence.slice() : DEFAULT_POLICY_PRECEDENCE.slice();
  const blocked = new Set(Array.isArray(opts.blocked) ? opts.blocked.filter((x) => typeof x === 'string') : []);
  const provided = {};
  if (Array.isArray(sources)) {
    for (const s of sources) {
      if (isPlainObject(s) && typeof s.source === 'string') provided[s.source] = obj(s.policy);
    }
  } else if (isPlainObject(sources)) {
    for (const k of Object.keys(sources)) provided[k] = obj(sources[k]);
  }
  const allFields = new Set();
  for (const name of order) {
    const m = provided[name];
    if (m) for (const f of Object.keys(m)) allFields.add(f);
  }
  const policy = {};
  const resolution = {};
  for (const field of allFields) {
    if (blocked.has(field)) continue; // blocked → not inherited from any source
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const src = order[i];
      const m = provided[src];
      if (!m || !hasOwn(m, field)) continue;
      policy[field] = deepClone(m[field]);
      resolution[field] = src;
      break;
    }
  }
  return { policy, resolution };
}

// ---- public: merge ----

function mergePolicies(base, incoming, options) {
  const opts = obj(options);
  const strategy = (opts.strategy === 'keepExisting') ? 'keepExisting' : 'overwrite';
  const arrays = opts.arrays || 'replace';
  const out = deepClone(obj(base));
  const inc = deepClone(obj(incoming));
  for (const key of Object.keys(inc)) {
    const iv = inc[key];
    if (!hasOwn(out, key)) { out[key] = iv; continue; }
    const bv = out[key];
    if (Array.isArray(bv) && Array.isArray(iv)) {
      if (arrays === 'union') out[key] = uniq(bv.concat(iv));
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

// ---- public: compare ----

function comparePolicies(a, b) {
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

// ---- public: freeze / clone ----

function freezePolicy(policy) { return deepFreeze(deepClone(obj(policy))); }
function clonePolicy(policy) { return deepClone(obj(policy)); }

// ---- public: normalize ----

function normalizeArray(arr) {
  const mapped = arr.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '');
  return uniq(mapped).sort();
}

function normalizePolicy(policy) {
  const src = obj(policy);
  const norm = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (Array.isArray(v)) norm[k] = normalizeArray(v);
    else if (typeof v === 'string') norm[k] = v.trim();
    else norm[k] = deepClone(v);
  }
  const out = {};
  for (const name of POLICY_FIELDS) if (hasOwn(norm, name)) out[name] = norm[name];
  const extra = Object.keys(norm).filter((k) => !POLICY_FIELDS.includes(k)).sort();
  for (const k of extra) out[k] = norm[k];
  return out;
}

module.exports = {
  getPolicy,
  validateAgainstPolicy,
  applyDefaults,
  inheritPolicy,
  mergePolicies,
  comparePolicies,
  freezePolicy,
  clonePolicy,
  normalizePolicy,
  listPolicies,
};
