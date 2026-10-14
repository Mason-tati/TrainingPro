// WP-14 · A1 — Role registry (RBAC foundation).
//
// Immutable built-in role definitions. Each role has a name, description, a list
// of inherited role names (transitively expanded by access-control), and its own
// permission ids (from lib/auth/permissions.js). NOTHING in production imports
// this yet — it is infrastructure for a future authorization layer.
'use strict';

// Build a frozen role: { name, description, inherits[], permissions[] }.
function role(name, description, inherits, permissions) {
  return Object.freeze({
    name,
    description,
    inherits: Object.freeze([...inherits]),
    permissions: Object.freeze([...permissions]),
  });
}

const ROLES = Object.freeze({
  VIEWER: role('VIEWER', 'Read-only access to core records', [], [
    'training.read', 'documents.read', 'competency.read', 'assessments.read', 'reports.read',
  ]),
  OPERATOR: role('OPERATOR', 'Front-line operator / trainee', ['VIEWER'], []),
  TRAINER: role('TRAINER', 'Delivers training and assessments', ['OPERATOR'], [
    'training.write', 'assessments.write', 'documents.write', 'ai.use',
  ]),
  SUPERVISOR: role('SUPERVISOR', 'Supervises teams and competencies', ['TRAINER'], [
    'competency.write', 'reports.export',
  ]),
  TRAINING_MANAGER: role('TRAINING_MANAGER', 'Manages training content and delivery', ['SUPERVISOR'], [
    'training.delete', 'documents.translate', 'documents.publish', 'settings.read', 'users.read',
  ]),
  HR: role('HR', 'Human resources / disciplinary / onboarding', ['VIEWER'], [
    'hr.read', 'hr.write', 'users.read', 'users.write',
  ]),
  SAFETY: role('SAFETY', 'Safety records and documentation', ['VIEWER'], [
    'safety.read', 'safety.write', 'documents.write',
  ]),
  ADMIN: role('ADMIN', 'Full administrative control', ['TRAINING_MANAGER', 'HR', 'SAFETY'], [
    'admin.full', 'users.delete', 'settings.write', 'ai.admin',
  ]),
});

// Frozen list of all role names.
const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

module.exports = {
  ROLES,
  ROLE_NAMES,
};
