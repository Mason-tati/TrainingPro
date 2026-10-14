// WP-12 · C1 — Enterprise Operation Policy Registry (foundation).
//
// The single source of GOVERNANCE METADATA for every approved AI operation.
// This commit is ARCHITECTURAL ONLY: nothing imports this module yet, so it
// changes no policy decision, prompt, provider, AI result, route response, or
// log record. It is the foundation that later WP-12 commits will consult when
// resolving classification / approval / ownership context.
//
// Every value here is governance metadata, not content — no prompts, document
// text, PII, or secrets ever live in this registry.
'use strict';

// ── Allowed value sets (documentation + the contract the tests enforce) ──────
// classification : general | training | document | translation | assessment | hr | image_generation
// approval       : draft | not_required
// businessArea   : Training | Learning | HR | Safety | Documentation | General
// riskLevel      : low | medium | high | critical
// costProfile    : standard | large | vision | image
// providerPreference : anthropic | openai
// retention      : placeholder — null everywhere for now
// pii / auditRequired / humanApproval : booleans

// One entry per approved AI operation currently in TrainingPro.
const REGISTRY = {
  generate_content: {
    classification: 'training', approval: 'not_required',
    owner: 'Training', businessArea: 'Training', riskLevel: 'medium',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  extract_flowchart: {
    classification: 'document', approval: 'not_required',
    owner: 'Documentation', businessArea: 'Documentation', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  translate_section: {
    classification: 'translation', approval: 'not_required',
    owner: 'Documentation', businessArea: 'Documentation', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  translate_segments: {
    classification: 'translation', approval: 'not_required',
    owner: 'Documentation', businessArea: 'Documentation', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  ocr_translate_visual: {
    classification: 'translation', approval: 'not_required',
    owner: 'Documentation', businessArea: 'Documentation', riskLevel: 'medium',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'vision', providerPreference: 'anthropic',
  },
  generate_cover_svg: {
    classification: 'document', approval: 'not_required',
    owner: 'Training', businessArea: 'Training', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  generate_cover_image: {
    classification: 'image_generation', approval: 'not_required',
    owner: 'Training', businessArea: 'Training', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'image', providerPreference: 'openai',
  },
  develop_deck: {
    classification: 'training', approval: 'not_required',
    owner: 'Learning', businessArea: 'Learning', riskLevel: 'medium',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'large', providerPreference: 'anthropic',
  },
  draft_description: {
    classification: 'general', approval: 'not_required',
    owner: 'Documentation', businessArea: 'General', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  draft_disciplinary: {
    classification: 'hr', approval: 'draft',
    owner: 'HR', businessArea: 'HR', riskLevel: 'high',
    retention: null, pii: true, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  role_description: {
    classification: 'hr', approval: 'not_required',
    owner: 'HR', businessArea: 'HR', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  question_extract: {
    classification: 'assessment', approval: 'draft',
    owner: 'Learning', businessArea: 'Learning', riskLevel: 'medium',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  generate_answers: {
    classification: 'assessment', approval: 'draft',
    owner: 'Learning', businessArea: 'Learning', riskLevel: 'medium',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  form_fields: {
    classification: 'assessment', approval: 'not_required',
    owner: 'Learning', businessArea: 'Learning', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  ai_form_fields: {
    classification: 'hr', approval: 'draft',
    owner: 'HR', businessArea: 'HR', riskLevel: 'medium',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  kb_article: {
    classification: 'document', approval: 'not_required',
    owner: 'Documentation', businessArea: 'Documentation', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  glossary_notes: {
    classification: 'translation', approval: 'not_required',
    owner: 'Documentation', businessArea: 'Documentation', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
  doc_check: {
    classification: 'document', approval: 'not_required',
    owner: 'Documentation', businessArea: 'Documentation', riskLevel: 'low',
    retention: null, pii: false, auditRequired: true, humanApproval: false,
    costProfile: 'standard', providerPreference: 'anthropic',
  },
};

// Safe default returned for any unknown / missing operation. Deliberately uses
// classification "unclassified" (the neutral fallback, not a registry label).
const SAFE_DEFAULT = {
  classification: 'unclassified', approval: 'not_required',
  owner: 'Unknown', businessArea: 'General', riskLevel: 'low',
  retention: null, pii: false, auditRequired: true, humanApproval: false,
  costProfile: 'standard', providerPreference: 'anthropic',
};

// Deep-freeze so the registry is immutable at runtime (belt-and-braces on top of
// getOperationPolicy always returning a fresh copy).
function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') Object.freeze(v);
  }
  return Object.freeze(obj);
}
deepFreeze(REGISTRY);
Object.freeze(SAFE_DEFAULT);

// Look up governance metadata for an operation. Returns a FRESH shallow copy of
// the registry entry, or a fresh copy of the safe default for unknown/invalid
// input. Never throws; never mutates the registry or its argument.
function getOperationPolicy(operation) {
  const known = typeof operation === 'string'
    && Object.prototype.hasOwnProperty.call(REGISTRY, operation);
  return { ...(known ? REGISTRY[operation] : SAFE_DEFAULT) };
}

module.exports = {
  OPERATION_POLICY: REGISTRY,
  OPERATIONS: Object.freeze(Object.keys(REGISTRY)),
  SAFE_DEFAULT,
  getOperationPolicy,
};
