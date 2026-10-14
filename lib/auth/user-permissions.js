// WP-14 · A2 — User permission resolution (RBAC foundation).
//
// Pure functions that turn a user object into a canonical role list and an
// effective permission set, built on the A1 access-control module. No DB, no
// Express, no logging, no middleware. Never mutates the input, never throws.
// NOTHING in production imports this yet — infrastructure only.
'use strict';

const accessControl = require('./access-control');
const { ROLE_NAMES } = require('./roles');

// Case-insensitive lookup → canonical role name.
const CANONICAL = new Map(ROLE_NAMES.map((n) => [n.toLowerCase(), n]));
function canonicalRole(name) {
  if (typeof name !== 'string') return null;
  return CANONICAL.get(name.trim().toLowerCase()) || null;
}

// Turn one role source (string | array | anything) into a sorted, unique list of
// canonical KNOWN role names. Unknown / non-string entries are ignored.
function canonicalizeRoles(value) {
  const raw = typeof value === 'string' ? [value] : (Array.isArray(value) ? value : []);
  const out = new Set();
  for (const item of raw) {
    const canon = canonicalRole(item);
    if (canon) out.add(canon);
  }
  return [...out].sort();
}

// Resolve a user's canonical roles. Sources are consulted in priority order;
// the first source that yields ≥1 known role wins (an unknown-only higher-priority
// source falls through). Non-object / null user → []. Never mutates, never throws.
function normalizeUserRoles(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return [];
  for (const key of ['roleNames', 'roles', 'roleName', 'role']) {
    const canonical = canonicalizeRoles(user[key]);
    if (canonical.length > 0) return canonical;
  }
  return [];
}

// Public alias — the canonical role list for a user.
function resolveUserRoles(user) {
  return normalizeUserRoles(user);
}

// The user's effective permissions: union of every resolved role's effective
// (own + inherited) permissions. Sorted, unique, fresh array. Empty user → [].
function resolveUserPermissions(user) {
  const perms = new Set();
  for (const role of normalizeUserRoles(user)) {
    for (const p of accessControl.getEffectivePermissions(role)) perms.add(p);
  }
  return [...perms].sort();
}

function hasUserPermission(user, permission) {
  if (!accessControl.isKnownPermission(permission)) return false;
  return resolveUserPermissions(user).includes(permission);
}

function hasUserAnyPermission(user, permissions) {
  if (!Array.isArray(permissions)) return false;
  const effective = resolveUserPermissions(user);
  return permissions.some((p) => accessControl.isKnownPermission(p) && effective.includes(p));
}

function hasUserAllPermissions(user, permissions) {
  if (!Array.isArray(permissions)) return false;
  const effective = resolveUserPermissions(user);
  return permissions.every((p) => accessControl.isKnownPermission(p) && effective.includes(p));
}

module.exports = {
  resolveUserPermissions,
  resolveUserRoles,
  hasUserPermission,
  hasUserAnyPermission,
  hasUserAllPermissions,
  normalizeUserRoles,
};
