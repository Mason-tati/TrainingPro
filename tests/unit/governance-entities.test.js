// WP-15 · D1 — Governed-entity registry tests (+ cross-registry consistency + no-import scan).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'governance', 'entities.js'));
const { CLASSIFICATION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'classifications.js'));
const { RETENTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'retention.js'));
const { SENSITIVE_DATA_IDS } = require(path.join(ROOT, 'lib', 'governance', 'sensitive-data.js'));

const EXPECTED = ['users', 'documents', 'training', 'competencies', 'assessments', 'risk_assessments', 'corrective_actions', 'ai_outputs', 'attachments', 'photos', 'approvals', 'audit', 'disciplinary', 'medical', 'onboarding', 'leave', 'equipment']; // WP-15 D4 disciplinary/medical + WP-16 M2 onboarding/leave/equipment
const RESERVED_NULL = ['businessOwner', 'technicalOwner', 'responsibleDepartment', 'approvalAuthority', 'aiModel', 'promptVersion', 'policyVersion', 'confidence', 'verifiedBy', 'verificationDate'];

test('D1-e1. registry has all governed entities with reserved placeholder fields', () => {
  assert.deepEqual([...E.ENTITY_IDS].sort(), [...EXPECTED].sort());
  for (const id of E.ENTITY_IDS) {
    const e = E.ENTITIES[id];
    assert.equal(e.id, id);
    assert.ok(Array.isArray(e.sensitiveCategories));
    assert.ok(Array.isArray(e.evidenceEdges) && e.evidenceEdges.length === 0, `${id}.evidenceEdges empty placeholder`);
    for (const f of RESERVED_NULL) assert.equal(e[f], null, `${id}.${f} remains null`);
    assert.equal(typeof e.aiGenerated, 'boolean');
    assert.equal(e.humanVerified, false, `${id}.humanVerified placeholder false`);
  }
});

test('D1-e2. cross-registry consistency (classification/retention/sensitive all known)', () => {
  for (const id of E.ENTITY_IDS) {
    const e = E.ENTITIES[id];
    assert.ok(CLASSIFICATION_IDS.includes(e.classification), `${id} classification known`);
    assert.ok(RETENTION_IDS.includes(e.retention), `${id} retention known`);
    for (const s of e.sensitiveCategories) assert.ok(SENSITIVE_DATA_IDS.includes(s), `${id} sensitive ${s} known`);
  }
  assert.equal(E.ENTITIES.ai_outputs.aiGenerated, true, 'ai_outputs flagged AI-generated');
  assert.deepEqual(E.ENTITIES.users.sensitiveCategories, ['pii', 'credentials']);
});

test('D1-e3. deep frozen / immutable (incl. nested arrays)', () => {
  assert.ok(Object.isFrozen(E.ENTITIES) && Object.isFrozen(E.ENTITY_IDS));
  for (const id of E.ENTITY_IDS) {
    assert.ok(Object.isFrozen(E.ENTITIES[id]));
    assert.ok(Object.isFrozen(E.ENTITIES[id].sensitiveCategories));
    assert.ok(Object.isFrozen(E.ENTITIES[id].evidenceEdges));
  }
  try { E.ENTITIES.HACK = {}; } catch { /* ok */ }
  try { E.ENTITIES.users.sensitiveCategories.push('x'); } catch { /* ok */ }
  assert.equal(E.ENTITIES.HACK, undefined);
  assert.deepEqual(E.ENTITIES.users.sensitiveCategories, ['pii', 'credentials']);
});

test('D1-e4. getEntity: known + unknown → safe default; deep copy-on-read', () => {
  assert.equal(E.getEntity('documents').id, 'documents');
  const d = E.getEntity('nope');
  assert.equal(d.classification, 'CONFIDENTIAL', 'unknown → safe CONFIDENTIAL');
  assert.equal(d.retention, 'standard');
  for (const bad of [null, undefined, 5, {}]) assert.equal(E.getEntity(bad).id, 'unknown');
  // mutating the returned copy (incl. nested arrays) does not affect the registry
  const u = E.getEntity('users');
  u.sensitiveCategories.push('hacked'); u.evidenceEdges.push('x'); u.businessOwner = 'me';
  assert.deepEqual(E.ENTITIES.users.sensitiveCategories, ['pii', 'credentials']);
  assert.equal(E.ENTITIES.users.businessOwner, null);
  assert.notEqual(u.sensitiveCategories, E.ENTITIES.users.sensitiveCategories, 'fresh nested array');
});

test('D1-e5. listEntities fresh copies; never throws', () => {
  const list = E.listEntities();
  list.pop(); list[0].sensitiveCategories.push('x');
  assert.equal(E.listEntities().length, EXPECTED.length);
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => E.getEntity(bad));
});

// D1 — no runtime importer: server.js / routes / top-level lib must not require lib/governance.
test('D1-e6. no runtime imports of lib/governance', () => {
  const files = [path.join(ROOT, 'server.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) files.push(path.join(routesDir, f));
  const libDir = path.join(ROOT, 'lib');
  for (const f of fs.readdirSync(libDir)) if (f.endsWith('.js')) files.push(path.join(libDir, f)); // top-level lib only
  // WP-16 M3/M4/M5 — these routes are the approved governance/audit-adapter consumers.
  const M3_MIGRATED = new Set(['classes.js', 'trainers.js', 'roster.js', 'register.js', 'assignment.js', 'attendance.js', 'equipment.js', 'disciplinary.js', 'onboarding.js', 'leave.js', 'staff.js', 'competency.js', 'forms.js', 'content.js', 'exams.js', 'powerpoints.js', 'files.js', 'translator.js', 'knowledgebase.js']);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (M3_MIGRATED.has(path.basename(f))) {
      assert.ok(!/governance\/(?!audit-adapter)/.test(src), `${path.basename(f)} may import only governance/audit-adapter`);
    } else {
      assert.ok(!src.includes('governance/'), `${path.relative(ROOT, f)} must not import lib/governance`);
    }
  }
});
