// WP-14 · A1 — Permission registry (RBAC foundation).
//
// Immutable, data-only registry of fine-grained permissions. Naming convention is
// `module.action` (lowercase). NOTHING in production imports this yet — it is
// infrastructure for a future authorization layer. No Express, no DB, no logging.
'use strict';

// Risk tiers (informational; a future UI/audit layer may surface these).
const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

// Build a frozen permission entry: { id, description, module, risk }.
function perm(id, description, risk) {
  return Object.freeze({ id, description, module: id.split('.')[0], risk });
}

// The permission registry, keyed by id.
const PERMISSIONS = Object.freeze({
  'users.read': perm('users.read', 'View user accounts', 'low'),
  'users.write': perm('users.write', 'Create or modify user accounts', 'medium'),
  'users.delete': perm('users.delete', 'Delete user accounts', 'high'),

  'training.read': perm('training.read', 'View training records', 'low'),
  'training.write': perm('training.write', 'Create or modify training records', 'medium'),
  'training.delete': perm('training.delete', 'Delete training records', 'high'),

  'documents.read': perm('documents.read', 'View documents', 'low'),
  'documents.write': perm('documents.write', 'Create or modify documents', 'medium'),
  'documents.translate': perm('documents.translate', 'Translate documents', 'medium'),
  'documents.publish': perm('documents.publish', 'Publish documents', 'high'),

  'ai.use': perm('ai.use', 'Use AI-assisted features', 'medium'),
  'ai.admin': perm('ai.admin', 'Administer AI governance/config', 'high'),

  'competency.read': perm('competency.read', 'View competencies', 'low'),
  'competency.write': perm('competency.write', 'Create or modify competencies', 'medium'),

  'assessments.read': perm('assessments.read', 'View assessments', 'low'),
  'assessments.write': perm('assessments.write', 'Create or modify assessments', 'medium'),

  'reports.read': perm('reports.read', 'View reports', 'low'),
  'reports.export': perm('reports.export', 'Export reports', 'medium'),

  'settings.read': perm('settings.read', 'View system settings', 'low'),
  'settings.write': perm('settings.write', 'Modify system settings', 'high'),

  'hr.read': perm('hr.read', 'View HR / disciplinary / onboarding records', 'low'),
  'hr.write': perm('hr.write', 'Create or modify HR records', 'high'),

  'safety.read': perm('safety.read', 'View safety records', 'low'),
  'safety.write': perm('safety.write', 'Create or modify safety records', 'medium'),

  'admin.full': perm('admin.full', 'Full administrative control', 'critical'),
});

// Frozen list of all permission ids.
const PERMISSION_IDS = Object.freeze(Object.keys(PERMISSIONS));

module.exports = {
  PERMISSIONS,
  PERMISSION_IDS,
  RISK_LEVELS,
};
