// WP-17 · D18 — Enterprise Document Foundation registry sweep + cross-registry validation.
//
// The WP-17 close-out invariant test. Confirms the foundation is exactly 23 immutable
// modules, each exporting its expected API, deep-frozen, copy-on-read, never-throwing,
// with a non-member safe default; that cross-registry references resolve; and that
// NOTHING in production (routes / server.js / top-level lib) imports the foundation.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DOC_DIR = path.join(ROOT, 'lib', 'document');
const req = (f) => require(path.join(DOC_DIR, f));

// ── Manifest of all 23 foundation modules ──────────────────────────────────
// Registries: map + ids + get + list [+ isKnown], with a non-member safe default id.
const REGISTRIES = [
  { file: 'document-types.js', map: 'DOCUMENT_TYPES', ids: 'DOCUMENT_TYPE_IDS', get: 'getDocumentType', list: 'listDocumentTypes', isKnown: null, unknownId: 'unknown', extra: ['CATEGORIES'] },
  { file: 'document-status.js', map: 'DOCUMENT_STATUSES', ids: 'DOCUMENT_STATUS_IDS', get: 'getDocumentStatus', list: 'listDocumentStatuses', isKnown: null, unknownId: 'unknown', extra: [] },
  { file: 'review-frequency.js', map: 'REVIEW_FREQUENCIES', ids: 'REVIEW_FREQUENCY_IDS', get: 'getReviewFrequency', list: 'listReviewFrequencies', isKnown: null, unknownId: 'unknown', extra: [] },
  { file: 'approval-levels.js', map: 'APPROVAL_LEVELS', ids: 'APPROVAL_LEVEL_IDS', get: 'getApprovalLevel', list: 'listApprovalLevels', isKnown: null, unknownId: 'unknown', extra: [] },
  { file: 'document-lifecycle.js', map: 'DOCUMENT_LIFECYCLE', ids: 'DOCUMENT_LIFECYCLE_IDS', get: 'getLifecycleStage', list: 'listLifecycleStages', isKnown: null, unknownId: 'unknown', extra: [] },
  { file: 'document-templates.js', map: 'TEMPLATES', ids: 'TEMPLATE_IDS', get: 'getTemplate', list: 'listTemplates', isKnown: 'isKnownTemplate', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-layout-templates.js', map: 'DOCUMENT_TEMPLATES', ids: 'DOCUMENT_TEMPLATE_IDS', get: 'getDocumentTemplate', list: 'listDocumentTemplates', isKnown: 'isKnownDocumentTemplate', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-metadata-fields.js', map: 'METADATA_FIELDS', ids: 'METADATA_FIELD_IDS', get: 'getMetadataField', list: 'listMetadataFields', isKnown: 'isKnownMetadataField', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-relationships.js', map: 'DOCUMENT_RELATIONSHIPS', ids: 'DOCUMENT_RELATIONSHIP_IDS', get: 'getDocumentRelationship', list: 'listDocumentRelationships', isKnown: 'isKnownDocumentRelationship', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-approval-workflows.js', map: 'DOCUMENT_APPROVAL_WORKFLOWS', ids: 'DOCUMENT_APPROVAL_WORKFLOW_IDS', get: 'getDocumentApprovalWorkflow', list: 'listDocumentApprovalWorkflows', isKnown: 'isKnownDocumentApprovalWorkflow', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-versioning.js', map: 'DOCUMENT_VERSIONING', ids: 'DOCUMENT_VERSIONING_IDS', get: 'getDocumentVersioning', list: 'listDocumentVersioning', isKnown: 'isKnownDocumentVersioning', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-publishing.js', map: 'DOCUMENT_PUBLISHING', ids: 'DOCUMENT_PUBLISHING_IDS', get: 'getDocumentPublishing', list: 'listDocumentPublishing', isKnown: 'isKnownDocumentPublishing', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-distribution.js', map: 'DOCUMENT_DISTRIBUTION', ids: 'DOCUMENT_DISTRIBUTION_IDS', get: 'getDocumentDistribution', list: 'listDocumentDistribution', isKnown: 'isKnownDocumentDistribution', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-access.js', map: 'DOCUMENT_ACCESS', ids: 'DOCUMENT_ACCESS_IDS', get: 'getDocumentAccess', list: 'listDocumentAccess', isKnown: 'isKnownDocumentAccess', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-storage.js', map: 'DOCUMENT_STORAGE', ids: 'DOCUMENT_STORAGE_IDS', get: 'getDocumentStorage', list: 'listDocumentStorage', isKnown: 'isKnownDocumentStorage', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-notifications.js', map: 'DOCUMENT_NOTIFICATIONS', ids: 'DOCUMENT_NOTIFICATION_IDS', get: 'getDocumentNotification', list: 'listDocumentNotifications', isKnown: 'isKnownDocumentNotification', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-workflows.js', map: 'DOCUMENT_WORKFLOWS', ids: 'DOCUMENT_WORKFLOW_IDS', get: 'getDocumentWorkflow', list: 'listDocumentWorkflows', isKnown: 'isKnownDocumentWorkflow', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-validation.js', map: 'DOCUMENT_VALIDATION', ids: 'DOCUMENT_VALIDATION_IDS', get: 'getDocumentValidation', list: 'listDocumentValidations', isKnown: 'isKnownDocumentValidation', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-search.js', map: 'DOCUMENT_SEARCH', ids: 'DOCUMENT_SEARCH_IDS', get: 'getDocumentSearch', list: 'listDocumentSearches', isKnown: 'isKnownDocumentSearch', unknownId: 'UNKNOWN', extra: [] },
  { file: 'document-compliance.js', map: 'DOCUMENT_COMPLIANCE', ids: 'DOCUMENT_COMPLIANCE_IDS', get: 'getDocumentCompliance', list: 'listDocumentCompliance', isKnown: 'isKnownDocumentCompliance', unknownId: 'UNKNOWN', extra: [] },
];
// Pure helpers (no registry map): exact export surface only.
const HELPERS = [
  { file: 'document-numbering.js', fns: ['normalizeDocumentNumber', 'isValidDocumentNumber', 'buildDocumentNumber'] },
  { file: 'document-metadata.js', fns: ['buildDocumentMetadata', 'normalizeDocumentMetadata', 'sanitizeDocumentTitle', 'sanitizeDocumentDescription'] },
  { file: 'document-governance.js', fns: ['getDocumentGovernance', 'listDocumentGovernance', 'resolveDocumentGovernance'] },
];

const GARBAGE = [null, undefined, 5, {}, [], Symbol('x'), () => {}, true, 10n, 'NoSuchId', ''];

test('SWEEP-1. exactly 23 document modules exist; manifest is complete', () => {
  const onDisk = fs.readdirSync(DOC_DIR).filter((f) => f.endsWith('.js')).sort();
  assert.equal(onDisk.length, 23, 'exactly 23 modules on disk');
  const manifest = [...REGISTRIES.map((r) => r.file), ...HELPERS.map((h) => h.file)].sort();
  assert.deepEqual(onDisk, manifest, 'manifest lists every module exactly once');
  assert.equal(REGISTRIES.length + HELPERS.length, 23);
});

test('SWEEP-2. every registry exports exactly its expected API', () => {
  for (const r of REGISTRIES) {
    const m = req(r.file);
    const expected = [r.map, r.ids, r.get, r.list, ...(r.isKnown ? [r.isKnown] : []), ...r.extra].sort();
    assert.deepEqual(Object.keys(m).sort(), expected, `${r.file} export surface`);
    assert.equal(typeof m[r.get], 'function');
    assert.equal(typeof m[r.list], 'function');
    if (r.isKnown) assert.equal(typeof m[r.isKnown], 'function');
  }
});

test('SWEEP-3. every helper exports exactly its expected API', () => {
  for (const h of HELPERS) {
    const m = req(h.file);
    assert.deepEqual(Object.keys(m).sort(), [...h.fns].sort(), `${h.file} export surface`);
    for (const fn of h.fns) assert.equal(typeof m[fn], 'function', `${h.file}.${fn} is a function`);
  }
});

test('SWEEP-4. every registry is deep-frozen; IDS match keys; no duplicate ids; entries frozen', () => {
  for (const r of REGISTRIES) {
    const m = req(r.file);
    const map = m[r.map]; const ids = m[r.ids];
    assert.ok(Object.isFrozen(map) && Object.isFrozen(ids), `${r.file} map + ids frozen`);
    assert.deepEqual([...ids], Object.keys(map), `${r.file} IDS === Object.keys(MAP)`);
    assert.equal(ids.length, new Set(ids).size, `${r.file} no duplicate ids`);
    for (const id of ids) assert.ok(Object.isFrozen(map[id]), `${r.file}.${id} entry frozen`);
  }
});

test('SWEEP-5. no registry mutation possible (frozen map rejects new keys / edits)', () => {
  for (const r of REGISTRIES) {
    const m = req(r.file);
    const map = m[r.map];
    try { map.__HACK__ = {}; } catch { /* ok */ }
    assert.equal(map.__HACK__, undefined, `${r.file} cannot add keys`);
    const id = m[r.ids][0];
    const before = JSON.stringify(map[id]);
    try { map[id].__x = 1; } catch { /* ok */ }
    assert.equal(JSON.stringify(map[id]), before, `${r.file}.${id} entry immutable`);
  }
});

test('SWEEP-6. every accessor returns FRESH copies; mutating them never affects the registry', () => {
  for (const r of REGISTRIES) {
    const m = req(r.file);
    const id = m[r.ids][0];
    const a = m[r.get](id); const b = m[r.get](id);
    assert.equal(a.id, id, `${r.file} get returns the requested id`);
    assert.notEqual(a, b, `${r.file} get returns a fresh object each call`);
    assert.notEqual(a, m[r.map][id], `${r.file} get copy is not the registry entry`);
    const orig = m[r.map][id].id;
    a.id = '__MUTATED__';
    assert.equal(m[r.map][id].id, orig, `${r.file} mutating the copy does not change the registry`);
    // list()
    const l1 = m[r.list](); const l2 = m[r.list]();
    assert.notEqual(l1, l2, `${r.file} list returns a fresh array`);
    assert.equal(l1.length, m[r.ids].length, `${r.file} list length === ids length`);
    for (const item of l2) assert.notEqual(item, m[r.map][item.id], `${r.file} listed item is a copy`);
  }
});

test('SWEEP-7. every registry has a non-member UNKNOWN safe default; garbage → default; never throws', () => {
  for (const r of REGISTRIES) {
    const m = req(r.file);
    assert.ok(!m[r.ids].includes(r.unknownId), `${r.file} '${r.unknownId}' is NOT a valid id`);
    for (const bad of GARBAGE) {
      assert.doesNotThrow(() => m[r.get](bad), `${r.file} get(${String(bad)}) does not throw`);
      assert.equal(m[r.get](bad).id, r.unknownId, `${r.file} get(${String(bad)}) → safe default`);
    }
    assert.doesNotThrow(() => m[r.list]());
  }
});

test('SWEEP-8. isKnown accessors: true for known, false for the safe default and all garbage', () => {
  for (const r of REGISTRIES) {
    if (!r.isKnown) continue;
    const m = req(r.file);
    assert.equal(m[r.isKnown](m[r.ids][0]), true, `${r.file} isKnown(realId) true`);
    assert.equal(m[r.isKnown](r.unknownId), false, `${r.file} isKnown('${r.unknownId}') false`);
    for (const bad of GARBAGE) {
      assert.doesNotThrow(() => m[r.isKnown](bad));
      assert.equal(m[r.isKnown](bad), false, `${r.file} isKnown(${String(bad)}) false`);
    }
  }
});

test('SWEEP-9. helpers never throw on garbage and remain safe', () => {
  const num = req('document-numbering.js');
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => num.normalizeDocumentNumber(bad));
    assert.doesNotThrow(() => num.isValidDocumentNumber(bad));
    assert.doesNotThrow(() => num.buildDocumentNumber(bad));
  }
  assert.ok(num.isValidDocumentNumber(num.buildDocumentNumber({ site: 'A', dept: 'B', type: 'C', sequence: 1 })));

  const md = req('document-metadata.js');
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => md.buildDocumentMetadata(bad));
    assert.doesNotThrow(() => md.normalizeDocumentMetadata(bad));
    assert.doesNotThrow(() => md.sanitizeDocumentTitle(bad));
    assert.doesNotThrow(() => md.sanitizeDocumentDescription(bad));
  }

  const gov = req('document-governance.js');
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => gov.getDocumentGovernance(bad));
    assert.doesNotThrow(() => gov.resolveDocumentGovernance(bad));
    assert.equal(gov.getDocumentGovernance(bad).type, 'unknown', 'governance garbage → unknown');
  }
  assert.notEqual(gov.listDocumentGovernance(), gov.listDocumentGovernance(), 'governance list fresh');
});

test('SWEEP-10. NO production consumer imports the document foundation (routes/server.js/top-level lib)', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/require\(['"][^'"]*\/document\/[^'"]+['"]\)/.test(src), `${path.relative(ROOT, f)} must not import lib/document/*`);
    assert.ok(!src.includes("lib/document/"), `${path.relative(ROOT, f)} contains no lib/document reference`);
  }
});

// ── Cross-registry validation ───────────────────────────────────────────────

test('SWEEP-11. cross-registry references resolve against the shared vocabulary', () => {
  const STATUS = req('document-status.js').DOCUMENT_STATUS_IDS;
  const TYPES = req('document-types.js').DOCUMENT_TYPE_IDS;
  const FREQ = req('review-frequency.js').REVIEW_FREQUENCY_IDS;
  const APPROVAL = req('approval-levels.js').APPROVAL_LEVEL_IDS;

  // document-templates (D3) → document-types / document-status / review-frequency / approval-levels
  const T = req('document-templates.js');
  for (const id of T.TEMPLATE_IDS) {
    const t = T.TEMPLATES[id];
    assert.ok(TYPES.includes(t.documentType), `template ${id} documentType known`);
    assert.ok(STATUS.includes(t.defaultStatus), `template ${id} defaultStatus known`);
    assert.ok(FREQ.includes(t.defaultReviewFrequency), `template ${id} reviewFrequency known`);
    assert.ok(APPROVAL.includes(t.defaultApprovalLevel), `template ${id} approvalLevel known`);
  }
  // document-approval-workflows → approval-levels + document-status
  const AW = req('document-approval-workflows.js');
  for (const id of AW.DOCUMENT_APPROVAL_WORKFLOW_IDS) {
    const w = AW.DOCUMENT_APPROVAL_WORKFLOWS[id];
    assert.ok(APPROVAL.includes(w.requiredApprovalLevel), `approval-workflow ${id} level known`);
    assert.ok(STATUS.includes(w.defaultStatusBefore) && STATUS.includes(w.defaultStatusAfter), `approval-workflow ${id} statuses known`);
  }
  // document-workflows → document-status
  const W = req('document-workflows.js');
  for (const id of W.DOCUMENT_WORKFLOW_IDS) {
    const w = W.DOCUMENT_WORKFLOWS[id];
    assert.ok(STATUS.includes(w.initialStatus) && STATUS.includes(w.finalStatus), `workflow ${id} statuses known`);
  }
  // document-publishing → document-status
  const P = req('document-publishing.js');
  for (const id of P.DOCUMENT_PUBLISHING_IDS) {
    assert.ok(STATUS.includes(P.DOCUMENT_PUBLISHING[id].defaultStatusAfterPublish), `publishing ${id} status known`);
  }
});

test('SWEEP-12. no duplicate identifiers within any registry; every id is a non-empty string', () => {
  for (const r of REGISTRIES) {
    const ids = req(r.file)[r.ids];
    assert.equal(ids.length, new Set(ids).size, `${r.file} unique ids`);
    for (const id of ids) assert.ok(typeof id === 'string' && id.length > 0, `${r.file} id is a non-empty string`);
  }
});
