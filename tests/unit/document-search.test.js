// WP-17 · D16 — Document search/index registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-search.js'));

const EXPECTED = ['NONE', 'BASIC', 'FULL_TEXT', 'METADATA', 'TITLE', 'DOCUMENT_NUMBER', 'KEYWORD', 'TAG', 'CATEGORY', 'TYPE', 'AUTHOR', 'OWNER', 'REVIEWER', 'APPROVER', 'STATUS', 'WORKFLOW', 'VERSION', 'RELATIONSHIP', 'CONTENT', 'TRANSLATION', 'AI_CONTENT', 'OCR_CONTENT', 'IMAGE_TEXT', 'ATTACHMENT', 'FILE_NAME', 'DATE_RANGE', 'ADVANCED', 'GLOBAL'];
const VALID_CATEGORIES = ['none', 'basic', 'metadata', 'content', 'workflow', 'relationship', 'translation', 'ai', 'advanced', 'global'];
const BOOL_KEYS = ['supportsFuzzySearch', 'supportsPhraseSearch', 'supportsBooleanSearch', 'supportsWildcards', 'supportsFilters', 'supportsSorting', 'supportsHighlighting', 'supportsRanking', 'supportsFacets', 'requiresIndex', 'requiresPublishedDocuments'];
const RESERVED_KEYS = ['indexPolicy', 'rankingPolicy', 'highlightPolicy', 'filterPolicy', 'facetPolicy', 'aiPolicy', 'vectorPolicy', 'ocrPolicy', 'integrationPolicy', 'extensionPolicy'];

test('DSR-1. registry has all expected modes with the full shape', () => {
  assert.deepEqual([...S.DOCUMENT_SEARCH_IDS].sort(), [...EXPECTED].sort());
  for (const id of S.DOCUMENT_SEARCH_IDS) {
    const s = S.DOCUMENT_SEARCH[id];
    assert.equal(s.id, id);
    assert.equal(typeof s.displayName, 'string');
    assert.equal(typeof s.description, 'string');
    assert.equal(typeof s.category, 'string');
    for (const k of BOOL_KEYS) assert.equal(typeof s[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof s.futureReserved, 'object');
  }
});

test('DSR-2. unique ids, no duplicates', () => {
  assert.equal(S.DOCUMENT_SEARCH_IDS.length, new Set(S.DOCUMENT_SEARCH_IDS).size);
  assert.equal(S.DOCUMENT_SEARCH_IDS.length, EXPECTED.length);
});

test('DSR-3. cross-validation: every category is one of VALID_CATEGORIES', () => {
  for (const id of S.DOCUMENT_SEARCH_IDS) {
    assert.ok(VALID_CATEGORIES.includes(S.DOCUMENT_SEARCH[id].category), `${id} category valid`);
  }
});

test('DSR-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of S.DOCUMENT_SEARCH_IDS) {
    const fr = S.DOCUMENT_SEARCH[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DSR-5. deep frozen / immutable (registry, ids, each mode, futureReserved)', () => {
  assert.ok(Object.isFrozen(S.DOCUMENT_SEARCH) && Object.isFrozen(S.DOCUMENT_SEARCH_IDS));
  for (const id of S.DOCUMENT_SEARCH_IDS) {
    assert.ok(Object.isFrozen(S.DOCUMENT_SEARCH[id]));
    assert.ok(Object.isFrozen(S.DOCUMENT_SEARCH[id].futureReserved));
  }
  try { S.DOCUMENT_SEARCH.HACK = {}; } catch { /* ok */ }
  try { S.DOCUMENT_SEARCH.FULL_TEXT.supportsFuzzySearch = false; } catch { /* ok */ }
  try { S.DOCUMENT_SEARCH.FULL_TEXT.futureReserved.indexPolicy = 'x'; } catch { /* ok */ }
  assert.equal(S.DOCUMENT_SEARCH.HACK, undefined);
  assert.equal(S.DOCUMENT_SEARCH.FULL_TEXT.supportsFuzzySearch, true);
  assert.equal(S.DOCUMENT_SEARCH.FULL_TEXT.futureReserved.indexPolicy, null);
});

test('DSR-6. getDocumentSearch: known + unknown → safe default (exact spec)', () => {
  assert.equal(S.getDocumentSearch('FULL_TEXT').id, 'FULL_TEXT');
  const d = S.getDocumentSearch('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Search');
  assert.equal(d.category, 'advanced');
  const EXPECT = {
    supportsFuzzySearch: false, supportsPhraseSearch: false, supportsBooleanSearch: false, supportsWildcards: false,
    supportsFilters: true, supportsSorting: true, supportsHighlighting: false, supportsRanking: true, supportsFacets: false,
    requiresIndex: true, requiresPublishedDocuments: false,
  };
  for (const k of BOOL_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(S.getDocumentSearch(bad).id, 'UNKNOWN');
});

test('DSR-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = S.getDocumentSearch('FULL_TEXT');
  c.supportsFuzzySearch = false; c.category = 'none'; c.futureReserved.indexPolicy = 'y';
  const c2 = S.getDocumentSearch('FULL_TEXT');
  assert.equal(c2.supportsFuzzySearch, true);
  assert.equal(c2.category, 'content');
  assert.equal(c2.futureReserved.indexPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DSR-8. listDocumentSearches: fresh array + fresh objects; never exposes the registry', () => {
  const a = S.listDocumentSearches();
  const b = S.listDocumentSearches();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.indexPolicy = 'z';
  assert.equal(S.listDocumentSearches().length, EXPECTED.length);
  assert.notEqual(S.getDocumentSearch('NONE').id, 'mutated');
  for (const s of b) assert.notEqual(s, S.DOCUMENT_SEARCH[s.id], 'listed object is a copy');
});

test('DSR-9. isKnownDocumentSearch: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(S.isKnownDocumentSearch('FULL_TEXT'), true);
  assert.equal(S.isKnownDocumentSearch('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(S.isKnownDocumentSearch(bad), false);
});

test('DSR-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => S.getDocumentSearch(bad));
    assert.doesNotThrow(() => S.isKnownDocumentSearch(bad));
  }
  assert.doesNotThrow(() => S.listDocumentSearches());
});

test('DSR-11. registry integrity: every boolean varies; all categories represented; NONE deny-all', () => {
  for (const k of BOOL_KEYS) {
    const vals = S.DOCUMENT_SEARCH_IDS.map((id) => S.DOCUMENT_SEARCH[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const cats = new Set(S.DOCUMENT_SEARCH_IDS.map((id) => S.DOCUMENT_SEARCH[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  for (const k of BOOL_KEYS) assert.equal(S.DOCUMENT_SEARCH.NONE[k], false, `NONE.${k} false`);
  assert.equal(S.DOCUMENT_SEARCH.GLOBAL.requiresPublishedDocuments, true);
  assert.equal(S.DOCUMENT_SEARCH.FULL_TEXT.supportsHighlighting, true);
});

test('DSR-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(S).sort(), ['DOCUMENT_SEARCH', 'DOCUMENT_SEARCH_IDS', 'getDocumentSearch', 'isKnownDocumentSearch', 'listDocumentSearches'].sort());
});
