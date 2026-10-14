// WP-12 · C1 — Enterprise Operation Policy Registry tests.
// Proves the registry covers every approved operation with valid governance
// metadata, returns a safe default for unknown operations, and is immutable /
// side-effect-free. Architectural only — nothing consumes the registry yet.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'lib', 'ai', 'operation-policy.js');
const opPolicy = require(MODULE_PATH);

// Every approved AI operation currently in TrainingPro.
const EXPECTED_OPERATIONS = [
  'generate_content', 'extract_flowchart', 'translate_section', 'translate_segments',
  'ocr_translate_visual', 'generate_cover_svg', 'generate_cover_image', 'develop_deck',
  'draft_description', 'draft_disciplinary', 'role_description', 'question_extract',
  'generate_answers', 'form_fields', 'ai_form_fields', 'kb_article', 'glossary_notes',
  'doc_check',
];

const REQUIRED_FIELDS = [
  'classification', 'approval', 'owner', 'businessArea', 'riskLevel', 'retention',
  'pii', 'auditRequired', 'humanApproval', 'costProfile', 'providerPreference',
];

const ALLOWED = {
  classification: new Set(['general', 'training', 'document', 'translation', 'assessment', 'hr', 'image_generation']),
  approval: new Set(['draft', 'not_required']),
  businessArea: new Set(['Training', 'Learning', 'HR', 'Safety', 'Documentation', 'General']),
  riskLevel: new Set(['low', 'medium', 'high', 'critical']),
  costProfile: new Set(['standard', 'large', 'vision', 'image']),
  providerPreference: new Set(['anthropic', 'openai']),
};

// 1. Every approved operation exists in the registry.
test('C1-1. every approved operation exists', () => {
  for (const op of EXPECTED_OPERATIONS) {
    assert.ok(Object.prototype.hasOwnProperty.call(opPolicy.OPERATION_POLICY, op), `registry has ${op}`);
  }
  assert.equal(opPolicy.OPERATIONS.length, EXPECTED_OPERATIONS.length, 'registry size matches expected');
  assert.deepEqual([...opPolicy.OPERATIONS].sort(), [...EXPECTED_OPERATIONS].sort());
});

// 2. Every operation has every required field (correct types).
test('C1-2. every operation has all required fields with valid types', () => {
  for (const op of EXPECTED_OPERATIONS) {
    const e = opPolicy.OPERATION_POLICY[op];
    for (const f of REQUIRED_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(e, f), `${op}.${f} present`);
    }
    assert.equal(typeof e.owner, 'string');
    assert.ok(e.owner.length > 0, `${op}.owner non-empty`);
    assert.equal(e.retention, null, `${op}.retention is null (placeholder)`);
    assert.equal(typeof e.pii, 'boolean', `${op}.pii boolean`);
    assert.equal(typeof e.auditRequired, 'boolean', `${op}.auditRequired boolean`);
    assert.equal(typeof e.humanApproval, 'boolean', `${op}.humanApproval boolean`);
    // No entry should have extra/unknown fields.
    assert.deepEqual(Object.keys(e).sort(), [...REQUIRED_FIELDS].sort(), `${op} has exactly the required fields`);
  }
});

// 3. classification values valid.
test('C1-3. classification values are all valid', () => {
  for (const op of EXPECTED_OPERATIONS) {
    assert.ok(ALLOWED.classification.has(opPolicy.OPERATION_POLICY[op].classification), `${op} classification valid`);
  }
});

// 4. approval values valid.
test('C1-4. approval values are all valid', () => {
  for (const op of EXPECTED_OPERATIONS) {
    assert.ok(ALLOWED.approval.has(opPolicy.OPERATION_POLICY[op].approval), `${op} approval valid`);
  }
});

// 5. providerPreference values valid (and businessArea/riskLevel/costProfile).
test('C1-5. provider/businessArea/riskLevel/costProfile values are all valid', () => {
  for (const op of EXPECTED_OPERATIONS) {
    const e = opPolicy.OPERATION_POLICY[op];
    assert.ok(ALLOWED.providerPreference.has(e.providerPreference), `${op} providerPreference valid`);
    assert.ok(ALLOWED.businessArea.has(e.businessArea), `${op} businessArea valid`);
    assert.ok(ALLOWED.riskLevel.has(e.riskLevel), `${op} riskLevel valid`);
    assert.ok(ALLOWED.costProfile.has(e.costProfile), `${op} costProfile valid`);
  }
});

// 6. Unknown operation returns the documented safe default.
test('C1-6. unknown/invalid operation returns the safe default', () => {
  const expectedDefault = {
    classification: 'unclassified', approval: 'not_required', owner: 'Unknown',
    businessArea: 'General', riskLevel: 'low', retention: null, pii: false,
    auditRequired: true, humanApproval: false, costProfile: 'standard',
    providerPreference: 'anthropic',
  };
  for (const bad of ['nope_op', '', undefined, null, 42, {}, [], 'GENERATE_CONTENT']) {
    assert.deepEqual(opPolicy.getOperationPolicy(bad), expectedDefault, `default for ${String(bad)}`);
  }
  // a known operation returns its own entry (by value)
  assert.deepEqual(opPolicy.getOperationPolicy('generate_content'), opPolicy.OPERATION_POLICY.generate_content);
});

// 7. Returned object is a copy — mutating it never affects the registry.
test('C1-7. returned object is not the registry (no mutation leakage)', () => {
  const a = opPolicy.getOperationPolicy('draft_disciplinary');
  assert.notEqual(a, opPolicy.OPERATION_POLICY.draft_disciplinary, 'fresh copy, not the frozen entry');
  a.classification = 'HACKED'; a.pii = false; a.owner = 'attacker';
  const b = opPolicy.getOperationPolicy('draft_disciplinary');
  assert.equal(b.classification, 'hr', 'registry value intact');
  assert.equal(b.pii, true, 'registry value intact');
  assert.equal(b.owner, 'HR', 'registry value intact');
  assert.equal(opPolicy.OPERATION_POLICY.draft_disciplinary.classification, 'hr', 'source entry intact');
  // the safe default is likewise not handed out by reference
  const d = opPolicy.getOperationPolicy('unknown');
  assert.notEqual(d, opPolicy.SAFE_DEFAULT, 'default returned as a copy');
});

// 8. Registry (and its entries) are immutable at runtime.
test('C1-8. registry is immutable', () => {
  assert.ok(Object.isFrozen(opPolicy.OPERATION_POLICY), 'registry frozen');
  assert.ok(Object.isFrozen(opPolicy.OPERATION_POLICY.generate_content), 'entries frozen');
  assert.ok(Object.isFrozen(opPolicy.SAFE_DEFAULT), 'safe default frozen');
  assert.ok(Object.isFrozen(opPolicy.OPERATIONS), 'operations list frozen');
  // Attempts to mutate are ignored (non-strict) — assert nothing changed.
  try { opPolicy.OPERATION_POLICY.generate_content.classification = 'x'; } catch { /* strict throw ok */ }
  try { opPolicy.OPERATION_POLICY.injected = {}; } catch { /* strict throw ok */ }
  assert.equal(opPolicy.OPERATION_POLICY.generate_content.classification, 'training');
  assert.equal(opPolicy.OPERATION_POLICY.injected, undefined);
});

// 9. No duplicate operations — the SOURCE file declares each key exactly once
//    (guards against a silent JS same-key overwrite).
test('C1-9. no duplicate operation keys in the source', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  const registryBlock = src.slice(src.indexOf('const REGISTRY'), src.indexOf('const SAFE_DEFAULT'));
  for (const op of EXPECTED_OPERATIONS) {
    const re = new RegExp(`(^|[^A-Za-z_])${op}\\s*:`, 'g');
    const count = (registryBlock.match(re) || []).length;
    assert.equal(count, 1, `operation ${op} declared exactly once`);
  }
  // runtime keys are unique too
  const keys = Object.keys(opPolicy.OPERATION_POLICY);
  assert.equal(keys.length, new Set(keys).size, 'no duplicate runtime keys');
});

// 10. No duplicate exports; public API is exactly the documented set.
test('C1-10. exports are unique and exactly the public API', () => {
  const keys = Object.keys(opPolicy);
  assert.equal(keys.length, new Set(keys).size, 'no duplicate export keys');
  assert.deepEqual(keys.sort(), ['OPERATIONS', 'OPERATION_POLICY', 'SAFE_DEFAULT', 'getOperationPolicy'].sort());
  assert.equal(typeof opPolicy.getOperationPolicy, 'function');
});

// 11. Safe default shape is exactly as documented and never throws.
test('C1-11. safe default matches the documented contract', () => {
  assert.deepEqual(opPolicy.SAFE_DEFAULT, {
    classification: 'unclassified', approval: 'not_required', owner: 'Unknown',
    businessArea: 'General', riskLevel: 'low', retention: null, pii: false,
    auditRequired: true, humanApproval: false, costProfile: 'standard',
    providerPreference: 'anthropic',
  });
  // never throws for any input type
  for (const bad of [undefined, null, 0, '', NaN, false, {}, [], Symbol('x')]) {
    assert.doesNotThrow(() => opPolicy.getOperationPolicy(bad));
  }
});
