// WP-18 · E8 — Document assembly engine (Enterprise Document Engine).
//
// Assembles complete, deterministic Enterprise Document objects from the foundation layers
// ONLY: the pure builder, the number generator, the metadata engine, the metadata policy
// engine, and the WP-17 registries. It performs NO persistence, calls NO repositories or
// services, and touches NO database. Every public method is deterministic, pure, never
// throws, and returns fresh copies (copy-on-read). UNWIRED — nothing in production consumes it.
'use strict';

const builder = require('./document-builder');
const NumberGenerator = require('./numbering/document-number-generator');
const metadataEngine = require('./metadata/metadata-engine');
const policyEngine = require('./metadata/metadata-policy-engine');
const types = require('../document/document-types');
const statuses = require('../document/document-status');
const workflows = require('../document/document-workflows');
const versioning = require('../document/document-versioning');

const COMPONENTS = [
  { name: 'documentBuilder', kind: 'builder' },
  { name: 'numberGenerator', kind: 'engine' },
  { name: 'metadataEngine', kind: 'engine' },
  { name: 'metadataPolicyEngine', kind: 'engine' },
  { name: 'documentTypes', kind: 'registry' },
  { name: 'documentStatuses', kind: 'registry' },
  { name: 'documentWorkflows', kind: 'registry' },
  { name: 'documentVersioning', kind: 'registry' },
];

const COMPONENT_FIELDS = [
  'id', 'documentNumber', 'title', 'description', 'metadata', 'policy', 'workflow', 'status',
  'version', 'relationships', 'attachments', 'notifications', 'distribution', 'access', 'storage',
  'search', 'compliance', 'validation', 'audit', 'customFields', 'futureReserved',
];
const CRITICAL_COMPONENTS = ['documentNumber', 'title', 'metadata', 'policy', 'status'];

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
    return out;
  }
  return value;
}
function pickString(...args) {
  for (const a of args) if (typeof a === 'string' && a !== '') return a;
  return undefined;
}
function intOr(v, d) { return Number.isInteger(v) ? v : d; }
function isEmptyComponent(v) {
  return v === undefined || v === null || v === ''
    || (Array.isArray(v) && v.length === 0)
    || (isPlainObject(v) && Object.keys(v).length === 0);
}

function resolveNumber(inp, opts) {
  const numbering = obj(opts.numbering);
  if (typeof numbering.template === 'string' && numbering.template !== '') {
    const generator = new NumberGenerator(numbering);
    const res = generator.generate(obj(numbering.context));
    return res.ok ? res.number : '';
  }
  return (typeof inp.documentNumber === 'string') ? inp.documentNumber : '';
}

function resolveVersion(inp, opts) {
  const v = obj(inp.version);
  const schemeId = pickString(v.scheme, opts.versionScheme, opts.defaultVersionScheme);
  const scheme = versioning.getDocumentVersioning(schemeId);
  return {
    scheme: scheme.id,
    schemeName: scheme.displayName,
    major: intOr(v.major, 0),
    minor: intOr(v.minor, 0),
    patch: intOr(v.patch, 0),
    revision: (typeof v.revision === 'string') ? v.revision : String(intOr(v.revision, 0)),
    label: (typeof v.label === 'string') ? v.label : '',
  };
}

function bumpVersion(version, which) {
  const out = deepClone(obj(version));
  if (which === 'major') { out.major = intOr(out.major, 0) + 1; out.minor = 0; out.patch = 0; }
  else if (which === 'patch') { out.patch = intOr(out.patch, 0) + 1; }
  else { out.minor = intOr(out.minor, 0) + 1; out.patch = 0; }
  return out;
}

// Core composition (no normalize/freeze). Deterministic; never throws.
function build(input, opts) {
  const inp = obj(input);
  const doc = builder.createDocument(inp);

  const md = metadataEngine.createMetadata(inp.metadata, { normalize: true });
  const typeId = pickString(inp.documentType, obj(inp.metadata).DocumentType, opts.documentType);
  if (typeId !== undefined) {
    const typeObj = types.getDocumentType(typeId);
    md.DocumentType = typeId;
    md.DocumentTypeName = typeObj.displayName;
  }
  doc.metadata = md;

  doc.policy = policyEngine.getPolicy(pickString(opts.policyId, inp.policyId, obj(inp.policy).id, opts.defaultPolicy));
  doc.documentNumber = resolveNumber(inp, opts);
  doc.status = statuses.getDocumentStatus(pickString(inp.status, opts.status, opts.defaultStatus));
  doc.workflow = workflows.getDocumentWorkflow(pickString(obj(inp.workflow).id, inp.workflowId, opts.workflow, opts.defaultWorkflow));
  doc.version = resolveVersion(inp, opts);
  doc.audit = doc.audit.concat([{ event: 'assembled', kind: opts.kind }]);
  return doc;
}

function finalize(doc, opts) {
  let out = doc;
  if (opts.normalize === true) out = builder.normalizeDocument(out);
  if (opts.freeze === true) out = builder.freezeDocument(out);
  return out;
}

function compose(input, options, presets, transform) {
  const opts = Object.assign({}, presets, obj(options));
  const doc = build(input, opts);
  if (transform) transform(doc, opts, obj(input));
  return finalize(doc, opts);
}

// ---- public ----

function assembleDocument(input, options) {
  return compose(input, options, { kind: 'document' }, null);
}

function assembleDraft(input, options) {
  return compose(input, options, { kind: 'draft', defaultStatus: 'DRAFT', defaultPolicy: 'NONE' }, null);
}

function assembleTemplate(input, options) {
  return compose(input, options, { kind: 'template', defaultStatus: 'DRAFT', defaultPolicy: 'TEMPLATE' }, null);
}

function assembleRevision(input, options) {
  return compose(input, options, { kind: 'revision', defaultStatus: 'DRAFT' }, (doc, opts) => {
    doc.version = bumpVersion(doc.version, pickString(opts.bump) || 'minor');
    doc.audit = doc.audit.concat([{ event: 'revised' }]);
  });
}

function assembleTranslation(input, options) {
  return compose(input, options, { kind: 'translation', defaultPolicy: 'TRANSLATION' }, (doc, opts, inp) => {
    const language = pickString(inp.language, obj(inp.metadata).Language);
    if (language !== undefined) doc.metadata.Language = language;
    doc.relationships = doc.relationships.concat([{ type: 'translationOf', target: pickString(inp.sourceId) || null }]);
  });
}

function assembleArchive(input, options) {
  return compose(input, options, { kind: 'archive', defaultStatus: 'ARCHIVED', defaultPolicy: 'ARCHIVE' }, (doc) => {
    doc.audit = doc.audit.concat([{ event: 'archived' }]);
  });
}

// Validate an assembled document. Never throws.
function validateAssembly(document) {
  const result = { valid: true, errors: [], warnings: [], completeness: 0, missingComponents: [] };
  const structure = builder.validateStructure(document);
  for (const e of structure.errors) result.errors.push(e);
  for (const w of structure.warnings) result.warnings.push(w);
  for (const m of structure.missingComponents) result.missingComponents.push(m);
  if (!isPlainObject(document)) {
    result.valid = false;
    return result;
  }
  for (const c of CRITICAL_COMPONENTS) {
    if (isEmptyComponent(document[c])) {
      if (!result.missingComponents.includes(c)) result.missingComponents.push(c);
      result.errors.push({ component: c, code: 'MISSING_COMPONENT', message: `${c} is required` });
    }
  }
  let filled = 0;
  for (const f of COMPONENT_FIELDS) if (!isEmptyComponent(document[f])) filled += 1;
  result.completeness = Math.round((filled / COMPONENT_FIELDS.length) * 100) / 100;
  result.missingComponents.sort();
  result.valid = result.errors.length === 0;
  return result;
}

function listAssemblyComponents() {
  return deepClone(COMPONENTS);
}

module.exports = {
  assembleDocument,
  assembleDraft,
  assembleTemplate,
  assembleRevision,
  assembleTranslation,
  assembleArchive,
  validateAssembly,
  listAssemblyComponents,
};
