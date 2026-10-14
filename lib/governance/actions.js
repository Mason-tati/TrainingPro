// WP-15 · D1 — Business action registry (governance foundation).
//
// Immutable, report-only registry of business actions, each grouped by category.
// Pure, dependency-free, deep-frozen, copy-on-read, never throws; unknown ids fall
// back to a neutral safe default. Unwired.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}
function action(id, description, category) {
  return { id, description, category };
}

const ACTIONS = deepFreeze({
  create: action('create', 'Create a record', 'mutation'),
  update: action('update', 'Update a record', 'mutation'),
  delete: action('delete', 'Delete a record', 'mutation'),
  approve: action('approve', 'Approve a record', 'lifecycle'),
  publish: action('publish', 'Publish a record', 'lifecycle'),
  archive: action('archive', 'Archive a record', 'lifecycle'),
  restore: action('restore', 'Restore a record', 'mutation'),
  export: action('export', 'Export data', 'access'),
  view: action('view', 'View a record', 'access'),
  login: action('login', 'User login', 'auth'),
  logout: action('logout', 'User logout', 'auth'),
  assign: action('assign', 'Assign a record', 'assignment'),
  verify: action('verify', 'Verify / validate a record', 'verification'),
  generate_ai: action('generate_ai', 'Generate AI content', 'ai'),
  translate: action('translate', 'Translate content', 'ai'),
  train: action('train', 'Record training', 'training'),
  assess: action('assess', 'Record assessment', 'training'),
  certify: action('certify', 'Issue certification', 'training'),
  complete: action('complete', 'Mark as complete', 'training'), // WP-15 D3 — required by the audit-taxonomy training.complete event
});

const ACTION_IDS = Object.freeze(Object.keys(ACTIONS));
const SAFE_DEFAULT = deepFreeze(action('unknown', 'Unrecognised action', 'unknown'));

function copy(e) { return { id: e.id, description: e.description, category: e.category }; }

function getAction(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, id);
  return copy(known ? ACTIONS[id] : SAFE_DEFAULT);
}

function listActions() {
  return ACTION_IDS.map((k) => copy(ACTIONS[k]));
}

module.exports = { ACTIONS, ACTION_IDS, getAction, listActions };
