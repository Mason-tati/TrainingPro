// WP-17 · D16 — Enterprise document search/index registry (document-management foundation).
//
// The immutable single source of truth describing how future document searching and
// indexing behaves — the query capabilities and index requirements of each search mode
// — plus a reserved `futureReserved` extension block. Deep-frozen, copy-on-read (fresh
// objects), pure, dependency-free, CommonJS, never throws; unknown ids fall back to a
// safe default. UNWIRED — nothing consumes it (no search/index engine, FTS, or vector).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    indexPolicy: null,
    rankingPolicy: null,
    highlightPolicy: null,
    filterPolicy: null,
    facetPolicy: null,
    aiPolicy: null,
    vectorPolicy: null,
    ocrPolicy: null,
    integrationPolicy: null,
    extensionPolicy: null,
  };
}

// Build a search mode. `s` carries the capability flags; category is explicit.
function search(id, displayName, description, category, s) {
  return {
    id,
    displayName,
    description,
    category,
    supportsFuzzySearch: !!s.supportsFuzzySearch,
    supportsPhraseSearch: !!s.supportsPhraseSearch,
    supportsBooleanSearch: !!s.supportsBooleanSearch,
    supportsWildcards: !!s.supportsWildcards,
    supportsFilters: !!s.supportsFilters,
    supportsSorting: !!s.supportsSorting,
    supportsHighlighting: !!s.supportsHighlighting,
    supportsRanking: !!s.supportsRanking,
    supportsFacets: !!s.supportsFacets,
    requiresIndex: !!s.requiresIndex,
    requiresPublishedDocuments: !!s.requiresPublishedDocuments,
    futureReserved: reserved(),
  };
}

// A full-text capability bundle shared by content/advanced/global search.
const FULLTEXT = {
  supportsFuzzySearch: true, supportsPhraseSearch: true, supportsBooleanSearch: true, supportsWildcards: true,
  supportsFilters: true, supportsSorting: true, supportsHighlighting: true, supportsRanking: true, requiresIndex: true,
};
// A metadata field-search bundle.
const FIELD = { supportsWildcards: true, supportsFilters: true, supportsSorting: true, supportsRanking: true };

const DOCUMENT_SEARCH = deepFreeze({
  NONE: search('NONE', 'None', 'No search', 'none', {}),
  BASIC: search('BASIC', 'Basic', 'Basic keyword search', 'basic', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true,
  }),
  FULL_TEXT: search('FULL_TEXT', 'Full Text', 'Full-text content search', 'content', { ...FULLTEXT, supportsFacets: true }),
  METADATA: search('METADATA', 'Metadata', 'Metadata field search', 'metadata', { ...FIELD, supportsFacets: true, requiresIndex: true }),
  TITLE: search('TITLE', 'Title', 'Title search', 'metadata', {
    supportsPhraseSearch: true, supportsWildcards: true, supportsFilters: true, supportsSorting: true, supportsHighlighting: true, supportsRanking: true, requiresIndex: true,
  }),
  DOCUMENT_NUMBER: search('DOCUMENT_NUMBER', 'Document Number', 'Document-number search', 'metadata', {
    supportsWildcards: true, supportsFilters: true, supportsSorting: true, supportsRanking: true,
  }),
  KEYWORD: search('KEYWORD', 'Keyword', 'Keyword search', 'metadata', {
    supportsFuzzySearch: true, supportsWildcards: true, supportsFilters: true, supportsSorting: true, supportsRanking: true, requiresIndex: true,
  }),
  TAG: search('TAG', 'Tag', 'Tag search', 'metadata', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true, supportsFacets: true, requiresIndex: true,
  }),
  CATEGORY: search('CATEGORY', 'Category', 'Category search', 'metadata', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true, supportsFacets: true,
  }),
  TYPE: search('TYPE', 'Type', 'Document-type search', 'metadata', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true, supportsFacets: true,
  }),
  AUTHOR: search('AUTHOR', 'Author', 'Author search', 'metadata', { ...FIELD }),
  OWNER: search('OWNER', 'Owner', 'Owner search', 'metadata', { ...FIELD }),
  REVIEWER: search('REVIEWER', 'Reviewer', 'Reviewer search', 'workflow', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true,
  }),
  APPROVER: search('APPROVER', 'Approver', 'Approver search', 'workflow', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true,
  }),
  STATUS: search('STATUS', 'Status', 'Status search', 'workflow', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true, supportsFacets: true,
  }),
  WORKFLOW: search('WORKFLOW', 'Workflow', 'Workflow search', 'workflow', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true, supportsFacets: true,
  }),
  VERSION: search('VERSION', 'Version', 'Version search', 'workflow', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true,
  }),
  RELATIONSHIP: search('RELATIONSHIP', 'Relationship', 'Relationship search', 'relationship', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true, requiresIndex: true,
  }),
  CONTENT: search('CONTENT', 'Content', 'Document content search', 'content', { ...FULLTEXT }),
  TRANSLATION: search('TRANSLATION', 'Translation', 'Translated content search', 'translation', {
    supportsFuzzySearch: true, supportsFilters: true, supportsSorting: true, supportsRanking: true, requiresIndex: true,
  }),
  AI_CONTENT: search('AI_CONTENT', 'AI Content', 'AI-generated content search', 'ai', {
    supportsFuzzySearch: true, supportsFilters: true, supportsSorting: true, supportsRanking: true, requiresIndex: true,
  }),
  OCR_CONTENT: search('OCR_CONTENT', 'OCR Content', 'OCR-extracted content search', 'content', {
    supportsFuzzySearch: true, supportsFilters: true, supportsSorting: true, supportsHighlighting: true, supportsRanking: true, requiresIndex: true,
  }),
  IMAGE_TEXT: search('IMAGE_TEXT', 'Image Text', 'Text-in-image search', 'content', {
    supportsFuzzySearch: true, supportsFilters: true, supportsSorting: true, supportsHighlighting: true, supportsRanking: true, requiresIndex: true,
  }),
  ATTACHMENT: search('ATTACHMENT', 'Attachment', 'Attachment content search', 'content', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true, requiresIndex: true,
  }),
  FILE_NAME: search('FILE_NAME', 'File Name', 'File-name search', 'metadata', {
    supportsWildcards: true, supportsFilters: true, supportsSorting: true, supportsRanking: true,
  }),
  DATE_RANGE: search('DATE_RANGE', 'Date Range', 'Date-range search', 'metadata', {
    supportsFilters: true, supportsSorting: true, supportsRanking: true,
  }),
  ADVANCED: search('ADVANCED', 'Advanced', 'Advanced query search', 'advanced', { ...FULLTEXT, supportsFacets: true }),
  GLOBAL: search('GLOBAL', 'Global', 'Global search across all indexes', 'global', {
    ...FULLTEXT, supportsFacets: true, requiresPublishedDocuments: true,
  }),
});

const DOCUMENT_SEARCH_IDS = Object.freeze(Object.keys(DOCUMENT_SEARCH));

// Safe default for an unrecognised search id (per D16 specification).
const SAFE_DEFAULT = deepFreeze(search('UNKNOWN', 'Unknown Search', 'Unrecognised search mode — safe default', 'advanced', {
  supportsFuzzySearch: false, supportsPhraseSearch: false, supportsBooleanSearch: false, supportsWildcards: false,
  supportsFilters: true, supportsSorting: true, supportsHighlighting: false, supportsRanking: true, supportsFacets: false,
  requiresIndex: true, requiresPublishedDocuments: false,
}));

// Deep copy — a fresh search object with a fresh futureReserved block.
function copySearch(s) {
  return Object.assign({}, s, { futureReserved: Object.assign({}, s.futureReserved) });
}

function getDocumentSearch(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_SEARCH, id);
  return copySearch(known ? DOCUMENT_SEARCH[id] : SAFE_DEFAULT);
}

function listDocumentSearches() {
  return DOCUMENT_SEARCH_IDS.map((k) => copySearch(DOCUMENT_SEARCH[k]));
}

function isKnownDocumentSearch(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_SEARCH, id);
}

module.exports = {
  DOCUMENT_SEARCH,
  DOCUMENT_SEARCH_IDS,
  getDocumentSearch,
  listDocumentSearches,
  isKnownDocumentSearch,
};
