// WP-17 · D4 — Enterprise document metadata-field registry (document-management foundation).
//
// The immutable single source of truth for every document metadata FIELD that future
// builders, workflows, AI agents, and search engines will consume. Each entry declares
// its data type, behaviour flags, default value, a nullable validation block, and a
// reserved `futureReserved` extension block. Deep-frozen, copy-on-read (fresh
// objects/arrays), pure, dependency-free, CommonJS, never throws; unknown ids fall back
// to a most-restrictive UNKNOWN default. UNWIRED — nothing in production consumes it.
//
// NOTE: this is the D4 metadata-FIELD registry. The D2 metadata BUILDER lives in the
// sibling `document-metadata.js`; the two are distinct and both retained (D4 was placed
// here to avoid overwriting the approved D2 module — see the D4 report).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

const DATA_TYPES = Object.freeze(['string', 'number', 'boolean', 'date', 'datetime', 'array', 'object', 'enum']);

// All-null validation template; per-field partials override only the keys they set.
const NULL_VALIDATION = { minLength: null, maxLength: null, min: null, max: null, regex: null, allowedValues: null };

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    indexProfile: null,
    searchWeight: null,
    translationRule: null,
    aiProcessing: null,
    ocrProfile: null,
    integrationMapping: null,
    externalReference: null,
    complianceRule: null,
    retentionOverride: null,
    approvalRule: null,
  };
}

// Build a metadata field. `a` carries the behaviour flags, optional defaultValue, and
// optional `validation` partial. Object.assign safely ignores an undefined validation
// partial, so no per-key defaulting branch is needed.
function field(id, displayName, description, dataType, a) {
  return {
    id,
    displayName,
    description,
    dataType,
    required: !!a.required,
    searchable: !!a.searchable,
    sortable: !!a.sortable,
    filterable: !!a.filterable,
    exportable: !!a.exportable,
    auditable: !!a.auditable,
    editable: !!a.editable,
    systemField: !!a.systemField,
    multiValue: !!a.multiValue,
    defaultValue: a.defaultValue ?? null,
    validation: Object.assign({}, NULL_VALIDATION, a.validation),
    futureReserved: reserved(),
  };
}

// Common flag bundles to keep the registry declarative and consistent.
const TEXT = { searchable: true, exportable: true, auditable: true, editable: true };
const FILTER = { filterable: true, exportable: true, auditable: true, editable: true };

const METADATA_FIELDS = deepFreeze({
  title: field('title', 'Title', 'Primary document title', 'string', { ...TEXT, required: true, sortable: true, filterable: true, validation: { minLength: 1, maxLength: 160 } }),
  subtitle: field('subtitle', 'Subtitle', 'Secondary document title', 'string', { ...TEXT, validation: { maxLength: 200 } }),
  documentNumber: field('documentNumber', 'Document Number', 'Controlled document identifier', 'string', { ...TEXT, required: true, sortable: true, filterable: true, editable: false, systemField: true, validation: { regex: '^[A-Z0-9-]+$', maxLength: 64 } }),
  documentType: field('documentType', 'Document Type', 'Governed document type', 'enum', { ...FILTER, required: true, searchable: true }),
  version: field('version', 'Version', 'Document version label', 'string', { ...TEXT, required: true, sortable: true, validation: { maxLength: 32 } }),
  revision: field('revision', 'Revision', 'Revision label within a version', 'string', { ...TEXT, sortable: true }),
  status: field('status', 'Status', 'Lifecycle workflow status', 'enum', { ...FILTER, required: true, searchable: true, sortable: true }),
  workflow: field('workflow', 'Workflow', 'Assigned workflow profile', 'enum', { ...FILTER }),
  classification: field('classification', 'Classification', 'Governance classification', 'enum', { ...FILTER, required: true, searchable: true }),
  retention: field('retention', 'Retention', 'Governance retention policy', 'enum', { ...FILTER }),
  owner: field('owner', 'Owner', 'Accountable document owner', 'string', { ...TEXT, required: true, sortable: true, filterable: true }),
  approver: field('approver', 'Approver', 'Document approver', 'string', { ...TEXT, filterable: true }),
  reviewer: field('reviewer', 'Reviewer', 'Document reviewer', 'string', { ...TEXT, filterable: true }),
  department: field('department', 'Department', 'Owning department', 'string', { ...TEXT, sortable: true, filterable: true }),
  site: field('site', 'Site', 'Owning site / location', 'string', { ...TEXT, sortable: true, filterable: true }),
  company: field('company', 'Company', 'Owning company / entity', 'string', { ...TEXT, filterable: true }),
  project: field('project', 'Project', 'Associated project', 'string', { ...TEXT, filterable: true }),
  equipment: field('equipment', 'Equipment', 'Associated equipment', 'string', { ...TEXT, filterable: true, multiValue: true }),
  plant: field('plant', 'Plant', 'Associated plant', 'string', { ...TEXT, filterable: true }),
  workArea: field('workArea', 'Work Area', 'Associated work area', 'string', { ...TEXT, filterable: true }),
  discipline: field('discipline', 'Discipline', 'Engineering / operational discipline', 'string', { ...TEXT, filterable: true }),
  language: field('language', 'Language', 'Primary document language', 'enum', { ...FILTER, searchable: true }),
  country: field('country', 'Country', 'Applicable country', 'string', { ...FILTER }),
  region: field('region', 'Region', 'Applicable region', 'string', { ...FILTER }),
  author: field('author', 'Author', 'Original author', 'string', { ...TEXT, required: true, sortable: true, filterable: true }),
  createdDate: field('createdDate', 'Created Date', 'Creation timestamp', 'datetime', { ...FILTER, required: true, sortable: true, editable: false, systemField: true }),
  effectiveDate: field('effectiveDate', 'Effective Date', 'Date the document takes effect', 'date', { ...FILTER, sortable: true }),
  reviewDate: field('reviewDate', 'Review Date', 'Next scheduled review date', 'date', { ...FILTER, sortable: true }),
  expiryDate: field('expiryDate', 'Expiry Date', 'Date the document expires', 'date', { ...FILTER, sortable: true }),
  supersedes: field('supersedes', 'Supersedes', 'Document number this supersedes', 'string', { ...TEXT }),
  keywords: field('keywords', 'Keywords', 'Search keywords', 'array', { ...TEXT, multiValue: true }),
  tags: field('tags', 'Tags', 'Classification tags', 'array', { ...TEXT, filterable: true, multiValue: true }),
  hazards: field('hazards', 'Hazards', 'Identified hazards', 'array', { ...TEXT, multiValue: true }),
  controls: field('controls', 'Controls', 'Risk controls', 'array', { ...TEXT, multiValue: true }),
  legislation: field('legislation', 'Legislation', 'Applicable legislation', 'array', { ...TEXT, multiValue: true }),
  standards: field('standards', 'Standards', 'Applicable standards', 'array', { ...TEXT, multiValue: true }),
  trainingRequired: field('trainingRequired', 'Training Required', 'Whether training is required', 'boolean', { ...FILTER, defaultValue: false }),
  readAcknowledgement: field('readAcknowledgement', 'Read Acknowledgement', 'Whether read acknowledgement is required', 'boolean', { ...FILTER, defaultValue: false }),
  electronicSignature: field('electronicSignature', 'Electronic Signature', 'Whether electronic signature is required', 'boolean', { ...FILTER, defaultValue: false }),
  riskLevel: field('riskLevel', 'Risk Level', 'Assessed risk level', 'enum', { ...FILTER, searchable: true, sortable: true, validation: { allowedValues: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] } }),
  aiGenerated: field('aiGenerated', 'AI Generated', 'Whether the content is AI-generated', 'boolean', { ...FILTER, editable: false, systemField: true, defaultValue: false }),
  aiModel: field('aiModel', 'AI Model', 'AI model used, if any', 'string', { exportable: true, auditable: true, editable: false, systemField: true }),
  translationLanguage: field('translationLanguage', 'Translation Language', 'Available translation languages', 'enum', { ...FILTER, multiValue: true }),
  attachments: field('attachments', 'Attachments', 'Attached files', 'array', { exportable: true, auditable: true, editable: true, multiValue: true }),
  images: field('images', 'Images', 'Embedded images', 'array', { exportable: true, auditable: true, editable: true, multiValue: true }),
  videos: field('videos', 'Videos', 'Embedded videos', 'array', { exportable: true, auditable: true, editable: true, multiValue: true }),
  customFields: field('customFields', 'Custom Fields', 'Arbitrary custom metadata', 'object', { exportable: true, auditable: true, editable: true }),
});

const METADATA_FIELD_IDS = Object.freeze(Object.keys(METADATA_FIELDS));

// Most-restrictive fail-safe default for an unrecognised field id.
const SAFE_DEFAULT = deepFreeze(field('UNKNOWN', 'Unknown Field', 'Unrecognised metadata field — most-restrictive safe default', 'string', {}));

// Deep copy — fresh field with fresh validation + futureReserved blocks.
function copyField(f) {
  return Object.assign({}, f, {
    validation: Object.assign({}, f.validation),
    futureReserved: Object.assign({}, f.futureReserved),
  });
}

function getMetadataField(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(METADATA_FIELDS, id);
  return copyField(known ? METADATA_FIELDS[id] : SAFE_DEFAULT);
}

function listMetadataFields() {
  return METADATA_FIELD_IDS.map((k) => copyField(METADATA_FIELDS[k]));
}

function isKnownMetadataField(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(METADATA_FIELDS, id);
}

module.exports = { METADATA_FIELDS, METADATA_FIELD_IDS, getMetadataField, listMetadataFields, isKnownMetadataField };
