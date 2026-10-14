// WP-17 · D2 — Document-governance mapping tests (pure, immutable, 100% coverage).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'document', 'document-governance.js'));
const { DOCUMENT_TYPE_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-types.js'));
const { CLASSIFICATION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'classifications.js'));
const { RETENTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'retention.js'));
const { ENTITY_IDS } = require(path.join(ROOT, 'lib', 'governance', 'entities.js'));
const { SENSITIVE_DATA_IDS } = require(path.join(ROOT, 'lib', 'governance', 'sensitive-data.js'));

const SHAPE = ['type', 'classification', 'retention', 'entity', 'sensitiveCategories', 'requiresApproval', 'requiresVersioning', 'requiresReview', 'supportsTranslation', 'supportsTraining', 'supportsRiskAssessment', 'supportsAI', 'supportsAttachments', 'supportsWorkflow', 'supportsReadAcknowledgement', 'supportsElectronicSignoff', 'ownership', 'ai', 'source'];

test('DG-1. every document type resolves with the full shape + known governance values', () => {
  for (const id of DOCUMENT_TYPE_IDS) {
    const g = G.getDocumentGovernance(id);
    assert.equal(g.type, id);
    for (const k of SHAPE) assert.ok(k in g, `${id}.${k} present`);
    assert.ok(CLASSIFICATION_IDS.includes(g.classification), `${id} classification known`); // 3
    assert.ok(RETENTION_IDS.includes(g.retention), `${id} retention known`);                 // 4
    assert.ok(ENTITY_IDS.includes(g.entity), `${id} entity known`);                          // 5
    for (const s of g.sensitiveCategories) assert.ok(SENSITIVE_DATA_IDS.includes(s), `${id} sensitive ${s} known`); // 6
    assert.equal(g.source, 'global');
  }
});

test('DG-2. unknown / garbage type → safe default (documents/CONFIDENTIAL/standard)', () => {
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) {
    const g = G.getDocumentGovernance(bad);
    assert.equal(g.type, 'unknown');
    assert.equal(g.entity, 'documents');
    assert.equal(g.classification, 'CONFIDENTIAL');
    assert.equal(g.retention, 'standard');
    assert.deepEqual(g.sensitiveCategories, []);
    assert.equal(g.ai.aiGenerated, false);
    // unknown default is restrictive
    assert.equal(g.requiresApproval, true);
  }
});

test('DG-7. AI_CONTENT → ai_outputs / AI_GENERATED / ai_content / aiGenerated true', () => {
  const g = G.getDocumentGovernance('AI_CONTENT');
  assert.equal(g.entity, 'ai_outputs');
  assert.equal(g.classification, 'AI_GENERATED');
  assert.deepEqual(g.sensitiveCategories, ['ai_content']);
  assert.equal(g.ai.aiGenerated, true);
  assert.equal(g.supportsAI, true);
});

test('DG-8. risk documents (RISK_ASSESSMENT/JSA/SWMS) → risk_assessments / SAFETY_CRITICAL', () => {
  for (const id of ['RISK_ASSESSMENT', 'JSA', 'SWMS']) {
    const g = G.getDocumentGovernance(id);
    assert.equal(g.entity, 'risk_assessments', `${id} entity`);
    assert.equal(g.classification, 'SAFETY_CRITICAL', `${id} classification`);
    assert.equal(g.retention, 'extended');
  }
});

test('DG-9. ASSESSMENT → assessments / CONFIDENTIAL / pii', () => {
  const g = G.getDocumentGovernance('ASSESSMENT');
  assert.equal(g.entity, 'assessments');
  assert.equal(g.classification, 'CONFIDENTIAL');
  assert.deepEqual(g.sensitiveCategories, ['pii']);
});

test('DG-10/11. copy-on-read: mutating a returned record never affects later reads', () => {
  const a = G.getDocumentGovernance('SOP');
  a.classification = 'HACKED';
  a.sensitiveCategories.push('x');
  a.ownership.businessOwner = 'me';
  a.ai.aiGenerated = true;
  const b = G.getDocumentGovernance('SOP');
  assert.equal(b.classification, 'SAFETY_CRITICAL');
  assert.deepEqual(b.sensitiveCategories, []);
  assert.equal(b.ownership.businessOwner, null);
  assert.equal(b.ai.aiGenerated, false);
  assert.notEqual(a, b);
  assert.notEqual(a.ownership, b.ownership);
});

test('DG-12. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => G.getDocumentGovernance(bad));
  }
});

test('DG-list. listDocumentGovernance: fresh array, one record per type', () => {
  const a = G.listDocumentGovernance();
  const b = G.listDocumentGovernance();
  assert.notEqual(a, b);
  assert.equal(a.length, DOCUMENT_TYPE_IDS.length);
  a.pop(); a[0].classification = 'X';
  assert.equal(G.listDocumentGovernance().length, DOCUMENT_TYPE_IDS.length);
  assert.notEqual(G.getDocumentGovernance('SOP').classification, 'X');
});

test('DG-resolve. resolveDocumentGovernance: string | object(+source) | garbage', () => {
  assert.equal(G.resolveDocumentGovernance('SOP').type, 'SOP');                       // string
  assert.equal(G.resolveDocumentGovernance({ type: 'SOP' }).source, 'global');        // object, no source
  assert.equal(G.resolveDocumentGovernance({ type: 'SOP', source: ' site-A ' }).source, 'site-A'); // trimmed override
  assert.equal(G.resolveDocumentGovernance({ type: 'SOP', source: '   ' }).source, 'global'); // blank → keep global
  assert.equal(G.resolveDocumentGovernance({ type: 'SOP', source: 5 }).source, 'global'); // non-string → keep global
  assert.equal(G.resolveDocumentGovernance({ type: 'NOPE' }).type, 'unknown');         // object, unknown type
  for (const bad of [null, undefined, [], 5, Symbol('x')]) {
    assert.equal(G.resolveDocumentGovernance(bad).type, 'unknown');                    // garbage → default
  }
});

test('DG-13. no runtime imports of lib/document/governance from routes/server/top-level lib', () => {
  const fs = require('node:fs');
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!src.includes('document/document-governance') && !src.includes('document/document-metadata'), `${path.relative(ROOT, f)} must not import the D2 modules`);
  }
});
