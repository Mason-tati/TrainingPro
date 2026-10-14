// WP-14 · A1 — Access-control helpers (RBAC foundation).
//
// Pure functions over the role + permission registries. No Express, no DB, no
// logging. Every helper: never throws, treats unknown roles/permissions as
// false/empty, never mutates, and returns fresh copies. NOTHING in production
// imports this yet — no enforcement is wired anywhere.
'use strict';

const { ROLES } = require('./roles');
const { PERMISSIONS } = require('./permissions');

function isKnownRole(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ROLES, role);
}

function isKnownPermission(permission) {
  return typeof permission === 'string' && Object.prototype.hasOwnProperty.call(PERMISSIONS, permission);
}

// All roles `role` inherits from, transitively, INCLUDING itself. Cycle-safe.
// Unknown role → []. Returns a fresh array.
function expandInheritedRoles(role) {
  if (!isKnownRole(role)) return [];
  const seen = new Set();
  const stack = [role];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const def = ROLES[current];
    if (def && Array.isArray(def.inherits)) {
      for (const parent of def.inherits) {
        if (isKnownRole(parent) && !seen.has(parent)) stack.push(parent);
      }
    }
  }
  return [...seen];
}

// Union of own + inherited permissions for `role`. Unknown role → []. Returns a
// fresh, sorted array of permission ids.
function getEffectivePermissions(role) {
  if (!isKnownRole(role)) return [];
  const perms = new Set();
  for (const r of expandInheritedRoles(role)) {
    const def = ROLES[r];
    if (def && Array.isArray(def.permissions)) {
      for (const p of def.permissions) perms.add(p);
    }
  }
  return [...perms].sort();
}

function hasPermission(role, permission) {
  if (!isKnownRole(role) || !isKnownPermission(permission)) return false;
  return getEffectivePermissions(role).includes(permission);
}

function hasAnyPermission(role, permissions) {
  if (!isKnownRole(role) || !Array.isArray(permissions)) return false;
  const effective = getEffectivePermissions(role);
  return permissions.some((p) => isKnownPermission(p) && effective.includes(p));
}

function hasAllPermissions(role, permissions) {
  if (!isKnownRole(role) || !Array.isArray(permissions)) return false;
  const effective = getEffectivePermissions(role);
  return permissions.every((p) => isKnownPermission(p) && effective.includes(p));
}

module.exports = {
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  expandInheritedRoles,
  getEffectivePermissions,
  isKnownRole,
  isKnownPermission,
};
