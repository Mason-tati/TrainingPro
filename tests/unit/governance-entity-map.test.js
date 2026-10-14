// WP-15 · D4 — Entity & event governance resolution tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'governance', 'entity-governance.js'));
const { ENTITY_IDS } = require(path.join(ROOT, 'lib', 'governance', 'entities.js'));
const { CLASSIFICATION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'classifications.js'));
const { RETENTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'retention.js'));
const { SENSITIVE_DATA_IDS } = require(path.join(ROOT, 'lib', 'governance', 'sensitive-data.js'));
const { AUDIT_EVENT_IDS } = require(path.join(ROOT, 'lib', 'governance', 'audit-taxonomy.js'));

const AI_FIELDS = ['aiGenerated', 'aiModel', 'promptVersion', 'policyVersion', 'confidence', 'humanVerified', 'verifiedBy', 'verificationDate'];
const OWN_FIELDS = ['businessOwner', 'technicalOwner', 'responsibleDepartment', 'approvalAuthority'];

function assertValidGov(g) {
  assert.ok(CLASSIFICATION_IDS.includes(g.classification), `classification ${g.classification} known`);
  assert.ok(RETENTION_IDS.includes(g.retention), `retention ${g.retention} known`);
  for (const s of g.sensitiveCategories) assert.ok(SENSITIVE_DATA_IDS.includes(s), `sensitive ${s} known`);
  assert.equal(g.source, 'global');
  assert.deepEqual(Object.keys(g.ownership).sort(), [...OWN_FIELDS].sort());
  assert.deepEqual(Object.keys(g.ai).sort(), [...AI_FIELDS].sort());
}

// 1 + 8 + 9 + 10 + 11. Every D1 entity resolves with valid + placeholder metadata.
test('D4-1/8/9/10/11. every entity resolves; placeholders null; valid refs', () => {
  for (const id of ENTITY_IDS) {
    const g = G.getEntityGovernance(id);
    assert.equal(g.entity, id);
    assertValidGov(g);
    for (const f of OWN_FIELDS) assert.equal(g.ownership[f], null, `${id}.ownership.${f} null`);
    for (const f of ['aiModel', 'promptVersion', 'policyVersion', 'confidence', 'verifiedBy', 'verificationDate']) {
      assert.equal(g.ai[f], null, `${id}.ai.${f} null`);
    }
    assert.equal(typeof g.ai.aiGenerated, 'boolean');
    assert.equal(g.ai.humanVerified, false);
  }
});

// 2. Every D3 event resolves.
test('D4-2. every audit event resolves', () => {
  for (const id of AUDIT_EVENT_IDS) {
    const g = G.getEventGovernance(id);
    assert.equal(g.event, id);
    assert.ok(CLASSIFICATION_IDS.includes(g.classification));
    assert.ok(RETENTION_IDS.includes(g.retention));
    for (const f of ['complianceRelevant', 'lifecycleEvent', 'evidenceEvent']) assert.equal(typeof g[f], 'boolean');
    assert.ok(['low', 'medium', 'high', 'critical'].includes(g.risk));
    assert.equal(g.source, 'global');
  }
});

// 3. Unknown entity → safe default.
test('D4-3. unknown entity → safe default', () => {
  const g = G.getEntityGovernance('definitely_not_an_entity');
  assert.equal(g.entity, 'unknown');
  assert.equal(g.classification, 'CONFIDENTIAL');
  assert.equal(g.retention, 'standard');
  assert.equal(g.source, 'global');
});

// 4. Unknown event → safe default.
test('D4-4. unknown event → safe default', () => {
  const g = G.getEventGovernance('nope.thing');
  assert.equal(g.event, 'unknown');
  assert.equal(g.entity, 'audit');
  assert.equal(g.action, 'view');
  assert.equal(g.classification, 'INTERNAL');
});

// 5. HR entity carries HR_CONFIDENTIAL.
test('D4-5. HR entity carries HR_CONFIDENTIAL', () => {
  assert.equal(G.getEntityGovernance('disciplinary').classification, 'HR_CONFIDENTIAL');
  assert.ok(G.getEntityGovernance('disciplinary').sensitiveCategories.includes('disciplinary_freetext'));
});

// 6. Medical entity carries MEDICAL + medical sensitive category.
test('D4-6. medical entity carries MEDICAL', () => {
  const g = G.getEntityGovernance('medical');
  assert.equal(g.classification, 'MEDICAL');
  assert.ok(g.sensitiveCategories.includes('medical'));
});

// 7. AI output entity carries AI_GENERATED + AI governance metadata.
test('D4-7. ai_outputs carries AI_GENERATED and AI metadata', () => {
  const g = G.getEntityGovernance('ai_outputs');
  assert.equal(g.classification, 'AI_GENERATED');
  assert.equal(g.ai.aiGenerated, true);
  // event-level AI provenance carried through as well
  const ev = G.getEventGovernance('ai_outputs.generate_ai');
  assert.equal(ev.category, 'ai');
});

// 12 + 13. Scope normalization works; non-global overrides not applied.
test('D4-12/13. scope normalized; no overrides applied', () => {
  const s = G.resolveGovernanceScope({ tenantId: 't1', company: 'C', site: 'S', department: 'D', project: 'P', extra: 'x' });
  assert.deepEqual(s, { tenantId: 't1', company: 'C', site: 'S', department: 'D', project: 'P' });
  assert.ok(!('extra' in s), 'unknown scope keys dropped');
  // source stays global regardless of scope (no override in D4)
  assert.equal(G.getEntityGovernance('users', s).source, 'global');
  assert.equal(G.getEntityGovernance('users', { company: 'Acme' }).classification, G.getEntityGovernance('users').classification, 'scope does not change resolution');
});

// scope normalization does not preserve objects or arrays.
test('D4-scope-safety. objects/arrays/booleans → null in scope', () => {
  const s = G.resolveGovernanceScope({ tenantId: { a: 1 }, company: [1, 2], site: true, department: () => {}, project: 5 });
  assert.deepEqual(s, { tenantId: null, company: null, site: null, department: null, project: '5' });
  assert.deepEqual(G.resolveGovernanceScope(null), { tenantId: null, company: null, site: null, department: null, project: null });
});

// 14 + 15. Copy-on-read; source registries not mutated via returned values.
test('D4-14/15. copy-on-read; registries immutable via results', () => {
  const g = G.getEntityGovernance('users');
  g.sensitiveCategories.push('hacked'); g.ownership.businessOwner = 'me'; g.ai.aiModel = 'x'; g.evidenceEdges.push('e');
  const again = G.getEntityGovernance('users');
  assert.deepEqual(again.sensitiveCategories, ['pii', 'credentials']);
  assert.equal(again.ownership.businessOwner, null);
  assert.equal(again.ai.aiModel, null);
  assert.equal(again.evidenceEdges.length, 0);
  const list = G.listGovernedEntities();
  list.pop();
  assert.equal(G.listGovernedEntities().length, ENTITY_IDS.length);
});

// 16. Malformed input never throws.
test('D4-16. never throws on malformed input', () => {
  for (const bad of [undefined, null, NaN, {}, [], true, 5, Symbol('x'), () => {}]) {
    assert.doesNotThrow(() => G.getEntityGovernance(bad));
    assert.doesNotThrow(() => G.getEventGovernance(bad));
    assert.doesNotThrow(() => G.resolveGovernanceScope(bad));
  }
  assert.doesNotThrow(() => G.listGovernedEntities());
});

// AI metadata contains no prompt/completion text; exports are exactly the four.
test('D4-ai-safety/exports. no prompt/completion in AI metadata; export surface', () => {
  for (const id of ENTITY_IDS) {
    const g = G.getEntityGovernance(id);
    // AI metadata values are null / boolean placeholders only — so no prompt or
    // completion TEXT can exist in them (the reserved key names like
    // `promptVersion` are metadata, not content).
    for (const [k, v] of Object.entries(g.ai)) {
      assert.ok(v === null || typeof v === 'boolean', `${id}.ai.${k} is a null/boolean placeholder (no text)`);
    }
    assert.deepEqual(Object.keys(g.ai).sort(), [...AI_FIELDS].sort());
  }
  assert.deepEqual(Object.keys(G).sort(), ['getEntityGovernance', 'getEventGovernance', 'listGovernedEntities', 'resolveGovernanceScope'].sort());
});

// 17. No runtime import from server.js / routes / lib/audit.js.
test('D4-17. no runtime imports of entity-governance', () => {
  const files = [path.join(ROOT, 'server.js'), path.join(ROOT, 'lib', 'audit.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) files.push(path.join(routesDir, f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('governance/entity-governance'), `${path.relative(ROOT, f)} must not import it`);
  }
});
