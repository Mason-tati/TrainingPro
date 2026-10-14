// WP-15 · D3 — Audit event taxonomy tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const T = require(path.join(ROOT, 'lib', 'governance', 'audit-taxonomy.js'));
const { ENTITY_IDS } = require(path.join(ROOT, 'lib', 'governance', 'entities.js'));
const { ACTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'actions.js'));
const { CLASSIFICATION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'classifications.js'));
const { RETENTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'retention.js'));

const REQUIRED = [
  'users.create', 'users.update', 'documents.create', 'documents.update', 'documents.publish',
  'documents.archive', 'training.assign', 'training.complete', 'competencies.verify', 'assessments.assess',
  'risk_assessments.create', 'corrective_actions.update', 'ai_outputs.generate_ai', 'approvals.approve',
  'audit.export', 'audit.view', 'attachments.create', 'photos.create',
];
const RISKS = ['low', 'medium', 'high', 'critical'];
const CATEGORIES = ['business', 'security', 'lifecycle', 'compliance', 'ai', 'training'];
const FIELDS = ['id', 'entity', 'action', 'description', 'category', 'risk', 'classification', 'retention', 'complianceRelevant', 'lifecycleEvent', 'evidenceEvent'];

// 1 + 2. Registry exists; all required events present.
test('D3-1/2. registry exists with all required events', () => {
  assert.ok(T.AUDIT_EVENT_IDS.length >= REQUIRED.length);
  for (const id of REQUIRED) assert.ok(Object.prototype.hasOwnProperty.call(T.AUDIT_EVENTS, id), `${id} present`);
  for (const id of T.AUDIT_EVENT_IDS) {
    const e = T.AUDIT_EVENTS[id];
    for (const f of FIELDS) assert.ok(f in e, `${id}.${f} present`);
  }
});

// 3 + 4. Unique ids; valid lowercase entity.action id format (id === entity.action).
test('D3-3/4. unique ids + valid entity.action format', () => {
  assert.equal(T.AUDIT_EVENT_IDS.length, new Set(T.AUDIT_EVENT_IDS).size);
  for (const id of T.AUDIT_EVENT_IDS) {
    const e = T.AUDIT_EVENTS[id];
    assert.ok(/^[a-z_]+\.[a-z_]+$/.test(id), `${id} lowercase dot format`);
    assert.equal(id, `${e.entity}.${e.action}`, `${id} === entity.action`);
  }
});

// 5-8. Cross-registry validity (entity / action / classification / retention all known).
test('D3-5..8. every entity/action/classification/retention is known', () => {
  for (const id of T.AUDIT_EVENT_IDS) {
    const e = T.AUDIT_EVENTS[id];
    assert.ok(ENTITY_IDS.includes(e.entity), `${id} entity known`);
    assert.ok(ACTION_IDS.includes(e.action), `${id} action known`);
    assert.ok(CLASSIFICATION_IDS.includes(e.classification), `${id} classification known`);
    assert.ok(RETENTION_IDS.includes(e.retention), `${id} retention known`);
  }
});

// 9 + 10 + 18. risk/category enums valid; lifecycle/evidence/compliance flags boolean.
test('D3-9/10/18. valid enums + boolean flags', () => {
  for (const id of T.AUDIT_EVENT_IDS) {
    const e = T.AUDIT_EVENTS[id];
    assert.ok(RISKS.includes(e.risk), `${id} risk valid`);
    assert.ok(CATEGORIES.includes(e.category), `${id} category valid`);
    for (const f of ['complianceRelevant', 'lifecycleEvent', 'evidenceEvent']) assert.equal(typeof e[f], 'boolean', `${id}.${f} boolean`);
  }
});

// 11 + 12. Unknown → safe default; 'unknown' not in AUDIT_EVENT_IDS.
test('D3-11/12. unknown → safe default; not in ids', () => {
  const expected = {
    id: 'unknown', entity: 'audit', action: 'view', description: 'Unknown audit event',
    category: 'compliance', risk: 'low', classification: 'INTERNAL', retention: 'standard',
    complianceRelevant: false, lifecycleEvent: false, evidenceEvent: false,
  };
  for (const bad of ['nope.thing', '', 'users.create '.trim() + 'x', null, undefined, 5, {}]) {
    if (bad === 'users.create') continue;
    assert.deepEqual(T.getAuditEvent(bad), expected, `${String(bad)} → safe default`);
  }
  assert.ok(!T.AUDIT_EVENT_IDS.includes('unknown'));
});

// 13. isKnownAuditEvent works.
test('D3-13. isKnownAuditEvent', () => {
  assert.equal(T.isKnownAuditEvent('users.create'), true);
  for (const bad of ['nope', '', null, undefined, 5, {}]) assert.equal(T.isKnownAuditEvent(bad), false);
});

// 14 + 15. Fresh copies (list + get); registry not mutable via returned values.
test('D3-14/15. fresh copies from list/get', () => {
  const g = T.getAuditEvent('users.create');
  g.risk = 'critical'; g.entity = 'HACK';
  assert.equal(T.getAuditEvent('users.create').risk, 'medium', 'registry unaffected via get');
  const list = T.listAuditEvents();
  list.pop(); list[0].id = 'MUT';
  assert.equal(T.listAuditEvents().length, T.AUDIT_EVENT_IDS.length);
});

// 16. Registry + default deep-frozen.
test('D3-16. registry immutable / deep-frozen', () => {
  assert.ok(Object.isFrozen(T.AUDIT_EVENTS) && Object.isFrozen(T.AUDIT_EVENT_IDS));
  for (const id of T.AUDIT_EVENT_IDS) assert.ok(Object.isFrozen(T.AUDIT_EVENTS[id]));
  try { T.AUDIT_EVENTS.HACK = {}; } catch { /* ok */ }
  try { T.AUDIT_EVENTS['users.create'].risk = 'critical'; } catch { /* ok */ }
  assert.equal(T.AUDIT_EVENTS.HACK, undefined);
  assert.equal(T.AUDIT_EVENTS['users.create'].risk, 'medium');
});

// 17. Malformed input never throws.
test('D3-17. never throws on malformed input', () => {
  for (const bad of [undefined, null, NaN, {}, [], true, 5, Symbol('x'), () => {}]) {
    assert.doesNotThrow(() => T.getAuditEvent(bad));
    assert.doesNotThrow(() => T.isKnownAuditEvent(bad));
  }
  assert.doesNotThrow(() => T.listAuditEvents());
});

// 18b. exports only the expected surface.
test('D3-exports. only expected exports', () => {
  assert.deepEqual(Object.keys(T).sort(), ['AUDIT_EVENTS', 'AUDIT_EVENT_IDS', 'getAuditEvent', 'isKnownAuditEvent', 'listAuditEvents'].sort());
});

// 19. No runtime import from server.js / routes / lib/audit.js.
test('D3-19. no runtime imports of the taxonomy', () => {
  const files = [path.join(ROOT, 'server.js'), path.join(ROOT, 'lib', 'audit.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) files.push(path.join(routesDir, f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('governance/audit-taxonomy'), `${path.relative(ROOT, f)} must not import the taxonomy`);
  }
});
