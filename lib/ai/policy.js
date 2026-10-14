// WP-11 · P1 — Enterprise AI Policy Engine (REPORT-ONLY foundation).
//
// Plugs into the AI Gateway policy seam. In P1 it EVALUATES every request and
// emits report metadata, but NEVER denies, modifies, delays, or retries a
// request — `allow` is always true and the request object is never mutated.
// Future phases will flip individual rules to enforcing mode.
'use strict';

const requestContext = require('../request-context'); // WP-11 P6 — ambient tenant/actor context
const { getOperationPolicy } = require('./operation-policy'); // WP-12 C3 — per-operation governance metadata

const POLICY_VERSION = 1;
const POLICY_MODE = 'report'; // default mode

// ── Policy profiles (WP-11 P5) ──────────────────────────────────────────────
// A profile is a set of DEFAULTS only. Explicit environment variables always
// override the profile value (see the resolvers below). The default profile is
// `standard`, which is byte-for-byte the pre-P5 production default (report mode,
// every enforcement flag off, no ceilings). `development` is an alias of that
// permissive baseline; `strict` turns on full enforcement with default ceilings.
const DEFAULT_PROFILE = 'standard';
const PERMISSIVE = {
  mode: 'report',
  enforceToken: false, enforceApproval: false, enforceTenant: false,
  enforceClassification: false, enforceCost: false,
  maxTokens: null, maxCost: null,
};
const PROFILES = {
  development: { ...PERMISSIVE },
  standard: { ...PERMISSIVE },
  strict: {
    mode: 'enforce',
    // provider/agent/operation/model already enforce in enforce mode; these
    // per-rule flags turn on the remaining conditional rules.
    enforceToken: true, enforceApproval: true, enforceTenant: true,
    enforceClassification: true, enforceCost: true,
    maxTokens: 20000, maxCost: 5.0,
  },
};

// Resolve the active profile name from AI_POLICY_PROFILE. Missing/blank/unknown
// → the default profile (`standard`).
function resolveProfile() {
  const p = String(process.env.AI_POLICY_PROFILE || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFILES, p) ? p : DEFAULT_PROFILE;
}
function profileConfig() { return PROFILES[resolveProfile()]; }

// An env var counts as "explicitly set" only when present and non-blank; a
// missing/blank var falls through to the profile default.
function envSet(name) {
  const v = process.env[name];
  return v !== undefined && String(v).trim() !== '';
}

// Map each per-rule enforcement env var to its profile-config key.
const FLAG_PROFILE_KEY = {
  AI_POLICY_ENFORCE_TOKEN_LIMIT: 'enforceToken',
  AI_POLICY_ENFORCE_APPROVAL: 'enforceApproval',
  AI_POLICY_ENFORCE_TENANT: 'enforceTenant',
  AI_POLICY_ENFORCE_CLASSIFICATION: 'enforceClassification',
  AI_POLICY_ENFORCE_COST: 'enforceCost',
};

// Resolve the active mode: explicit AI_POLICY_MODE wins (only 'enforce' enables
// enforcement; any other explicit value → report); otherwise the profile default.
function resolveMode() {
  if (envSet('AI_POLICY_MODE')) {
    return String(process.env.AI_POLICY_MODE).trim().toLowerCase() === 'enforce' ? 'enforce' : 'report';
  }
  return profileConfig().mode;
}

// Optional positive-integer token ceiling. Explicit env wins (invalid/≤0 → null,
// no limit); otherwise the profile default (null or a number).
function resolveMaxTokens() {
  if (envSet('AI_POLICY_MAX_ESTIMATED_TOKENS')) {
    const n = Number(process.env.AI_POLICY_MAX_ESTIMATED_TOKENS);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return profileConfig().maxTokens;
}

// A per-rule enforcement flag: explicit env wins (ON only on the exact literal
// "true"); otherwise the profile default for that flag. Unknown names → off.
function flagEnabled(name) {
  if (envSet(name)) return process.env[name] === 'true';
  const key = FLAG_PROFILE_KEY[name];
  return key ? !!profileConfig()[key] : false;
}

// Optional positive cost ceiling in USD (may be fractional). Explicit env wins
// (invalid/≤0 → null, no ceiling); otherwise the profile default. WP-11 P4/P5.
function resolveMaxCost() {
  if (envSet('AI_POLICY_MAX_COST_USD')) {
    const n = Number(process.env.AI_POLICY_MAX_COST_USD);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return profileConfig().maxCost;
}

// ── Model registry (per provider) ──────────────────────────────────────────
const MODEL_REGISTRY = {
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-image-1'],
  // Reserved providers — empty until an adapter is implemented.
  gemini: [],
  ollama: [],
  'azure-openai': [],
  bedrock: [],
  vertex: [],
};

// ── Approved agent registry (moved from the gateway/docs) ───────────────────
const AGENTS = new Set([
  'AI-DOC-001', 'AI-DOC-002', 'AI-DOC-003', 'AI-DOC-004',
  'AI-ADM-001',
  'AI-WKF-001', 'AI-WKF-002',
  'AI-LRN-001',
  'AI-FRM-001',
]);

// ── Approved operation registry ─────────────────────────────────────────────
const OPERATIONS = new Set([
  'generate_content', 'translate_segments', 'ocr_translate_visual', 'generate_cover_svg',
  'generate_cover_image', 'develop_deck', 'draft_description', 'draft_disciplinary',
  'role_description', 'question_extract', 'generate_answers', 'form_fields',
  'kb_article', 'glossary_notes',
]);

// ── AI pricing registry (WP-11 P4) ──────────────────────────────────────────
// GOVERNANCE PLACEHOLDER PRICING. These USD figures are NON-AUTHORITATIVE and
// exist only to exercise the cost-policy path. They MUST be replaced with a
// verified pricing source before any real cost gating is relied upon in
// production. Shape: text models → usdPerMInputTokens (USD per 1,000,000 input
// tokens); image models → usdPerImage (USD per generated image).
const PRICING_PLACEHOLDER = true;
const PRICING = {
  anthropic: {
    'claude-sonnet-4-6': { usdPerMInputTokens: 3.0 }, // placeholder
    'claude-haiku-4-5': { usdPerMInputTokens: 1.0 }, // placeholder
  },
  openai: {
    'gpt-image-1': { usdPerImage: 0.04 }, // placeholder
  },
};

// Round a USD figure to 6 dp to avoid binary-float noise (never negative).
function roundUsd(n) { return Math.round(n * 1e6) / 1e6; }

// Estimate USD cost from the pricing registry. Text models cost from the input
// token estimate; image models cost per image count `n` (default 1). Unknown /
// unpriced provider+model → null. Reads only; never mutates the request.
function estimateCostUsd(request, estimatedTokens) {
  const req = request || {};
  const perProvider = PRICING[req.provider];
  const price = perProvider ? perProvider[req.model] : undefined;
  if (!price) return null;
  if (typeof price.usdPerImage === 'number') {
    const n = Number.isInteger(req.n) && req.n > 0 ? req.n : 1;
    return roundUsd(price.usdPerImage * n);
  }
  if (typeof price.usdPerMInputTokens === 'number') {
    const tokens = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 0;
    return roundUsd((tokens / 1e6) * price.usdPerMInputTokens);
  }
  return null;
}

// ── Token estimation (estimate only — never rejects) ────────────────────────
// Sums text length across system + prompt (image) + message text blocks and
// approximates tokens at ~4 chars/token. Reads only; never mutates the request.
function estimateTokens(request) {
  const req = request || {};
  let chars = 0;
  const add = (s) => { if (typeof s === 'string') chars += s.length; };
  add(req.system);
  add(req.prompt); // image prompt / free-text prompt
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  for (const m of msgs) {
    if (!m) continue;
    if (typeof m.content === 'string') add(m.content);
    else if (Array.isArray(m.content)) for (const b of m.content) { if (b && typeof b.text === 'string') add(b.text); }
  }
  return Math.ceil(chars / 4);
}

// ── Governance context resolution (WP-11 P6) ────────────────────────────────
// Resolve tenant / actor / classification from (in priority order) the request,
// the ambient request context (ALS), then a safe default. Reads only; never
// mutates the request or the context. `context` may be passed explicitly (the
// gateway does this); otherwise the active request context is read.
function resolveContext(request, context) {
  const req = request || {};
  const ctx = context || requestContext.get() || {};
  // "present" = a non-blank string (whitespace-only is treated as absent). WP-12 C2.
  const has = (v) => typeof v === 'string' && v.trim().length > 0;

  const tenantId = has(req.tenantId) ? req.tenantId : (has(ctx.tenantId) ? ctx.tenantId : null);

  let actor = 'anonymous';
  let actorSource = 'default';
  if (has(req.actor)) { actor = req.actor; actorSource = 'request'; }
  else if (has(ctx.actor)) { actor = ctx.actor; actorSource = 'context'; }

  // WP-12 C3 — request classification wins; else the operation registry's
  // classification (which is "unclassified" for unknown/missing operations).
  const classification = has(req.classification)
    ? req.classification
    : getOperationPolicy(req.operation).classification;

  // WP-12 C4 — request approvalStatus wins; else the operation registry's
  // approval (which is "not_required" for unknown/missing operations).
  const approvalStatus = has(req.approvalStatus)
    ? req.approvalStatus
    : getOperationPolicy(req.operation).approval;

  return { tenantId, actor, actorSource, classification, approvalStatus };
}

// Every rule returns { rule, status, message }. P1 status is ALWAYS 'PASS'.
function pass(rule, message) { return { rule, status: 'PASS', message }; }

// Enforcing allow-list rule: PASS when `ok`; otherwise FAIL in enforce mode, or
// a reporting PASS in report mode (so report mode never denies).
function allowListRule(rule, ok, okMsg, badMsg, mode) {
  if (ok) return { rule, status: 'PASS', message: okMsg };
  if (mode === 'enforce') return { rule, status: 'FAIL', message: badMsg };
  return { rule, status: 'PASS', message: `${badMsg} (report-only)` };
}
// WP-11 P3 — a conditionally-enforcing rule. PASS when `ok`. When not `ok`: FAIL
// only in enforce mode AND when its per-rule flag is enabled; otherwise a
// reporting PASS. So report mode (and any rule whose flag is off) never denies.
function condRule(rule, ok, okMsg, badMsg, mode, enforced) {
  if (ok) return { rule, status: 'PASS', message: okMsg };
  if (mode === 'enforce' && enforced) return { rule, status: 'FAIL', message: badMsg };
  return { rule, status: 'PASS', message: `${badMsg} (report-only)` };
}

// Token ceiling — always estimates; FAILs only in enforce mode with the flag on
// AND a valid positive max that is exceeded. Missing/invalid max → no limit → PASS.
function ruleTokenEstimate(req, est, mode) {
  const max = resolveMaxTokens();
  const enforced = flagEnabled('AI_POLICY_ENFORCE_TOKEN_LIMIT');
  const ok = max === null || est <= max;
  const okMsg = max === null ? `estimated ${est} input tokens (no limit)` : `estimated ${est} input tokens (limit ${max})`;
  const badMsg = `estimated ${est} input tokens exceeds limit ${max}`;
  return condRule('token_estimate', ok, okMsg, badMsg, mode, enforced);
}
function ruleStreaming(req) {
  return pass('streaming', req.stream ? 'streaming request' : 'non-streaming request');
}
function ruleImage(req) {
  return pass('image_generation', req.provider === 'openai' ? 'image generation request' : 'not an image request');
}
// Classification rule (WP-11 P6) — operates on the resolved classification
// (defaults to "unclassified"). Enforced FAIL unless it is a non-empty string
// other than "unclassified". Off by default (flag + enforce required).
function ruleContentClassification(classification, mode) {
  const enforced = flagEnabled('AI_POLICY_ENFORCE_CLASSIFICATION');
  const ok = typeof classification === 'string' && classification.length > 0 && classification !== 'unclassified';
  return condRule('content_classification', ok, `classification "${classification}"`, `content classification required (${classification})`, mode, enforced);
}
// Approval placeholder (WP-12 C4) — operates on the resolved approvalStatus.
// Enforced FAIL unless it is exactly "approved". "draft"/"not_required" are NOT
// treated as approved (that belongs to a future approval-workflow WP).
function ruleApproval(approvalStatus, mode) {
  const enforced = flagEnabled('AI_POLICY_ENFORCE_APPROVAL');
  const ok = approvalStatus === 'approved';
  return condRule('approval', ok, 'human approval: approved', `human approval required (${approvalStatus})`, mode, enforced);
}
// Tenant rule (WP-11 P6) — operates on the resolved tenantId (request → context
// → null). Enforced FAIL unless it is a non-empty string. Absent / null / '' →
// FAIL when enforced. Safe because enforcement is opt-in and OFF by default.
function ruleTenant(tenantId, mode) {
  const enforced = flagEnabled('AI_POLICY_ENFORCE_TENANT');
  const ok = typeof tenantId === 'string' && tenantId.length > 0;
  return condRule('tenant', ok, `tenant "${tenantId}"`, 'tenant scope required (no tenantId)', mode, enforced);
}
// Actor context rule (WP-11 P6) — always PASS; records the resolved actor and
// whether it came from the request, the ambient context, or the default.
function ruleActorContext(actor, actorSource) {
  return pass('actor_context', `actor "${actor}" (source: ${actorSource})`);
}
// Cost ceiling (WP-11 P4). Denies ONLY when: enforce mode AND ENFORCE_COST=true
// AND a valid positive AI_POLICY_MAX_COST_USD AND a non-null estimate that
// exceeds it. Missing pricing → PASS (pricing unavailable). Missing/invalid max
// → PASS. Pricing is a governance placeholder (see PRICING).
function ruleCost(mode, estimatedCostUsd) {
  const enforced = flagEnabled('AI_POLICY_ENFORCE_COST');
  if (estimatedCostUsd === null) {
    return pass('cost', 'cost pricing unavailable for this model (not enforced)');
  }
  const max = resolveMaxCost();
  if (max === null) {
    return pass('cost', `estimated cost $${estimatedCostUsd} USD (no cost ceiling configured)`);
  }
  const ok = estimatedCostUsd <= max;
  const okMsg = `estimated cost $${estimatedCostUsd} USD within ceiling $${max}`;
  const badMsg = `estimated cost $${estimatedCostUsd} USD exceeds ceiling $${max}`;
  return condRule('cost', ok, okMsg, badMsg, mode, enforced);
}

// Public API. `context` is optional — the gateway passes the active request
// context so tenant/actor resolve without routes threading them through. Never
// mutates the request or the context.
function evaluate(request, context) {
  const req = (request && typeof request === 'object' && !Array.isArray(request)) ? request : {};
  const mode = resolveMode();
  const profile = resolveProfile(); // WP-11 P5
  const ctx = resolveContext(req, context); // WP-11 P6 — { tenantId, actor, actorSource, classification }
  const estimatedTokens = estimateTokens(req);
  const estimatedCostUsd = estimateCostUsd(req, estimatedTokens); // WP-11 P4

  const providerKnown = Object.prototype.hasOwnProperty.call(MODEL_REGISTRY, req.provider);
  const agentKnown = AGENTS.has(req.agent);
  const operationKnown = OPERATIONS.has(req.operation);
  const modelKnown = (MODEL_REGISTRY[req.provider] || []).includes(req.model);

  const ruleResults = [
    // Enforcing allow-list rules (may FAIL in enforce mode).
    allowListRule('provider_allowed', providerKnown, `provider "${req.provider}" recognised`, `provider "${req.provider}" not allowed`, mode),
    allowListRule('agent_registered', agentKnown, `agent "${req.agent}" registered`, `agent "${req.agent}" not registered`, mode),
    allowListRule('operation_registered', operationKnown, `operation "${req.operation}" registered`, `operation "${req.operation}" not registered`, mode),
    allowListRule('model_allowed', modelKnown, `model "${req.model}" allowed`, `model "${req.model}" not allowed`, mode),
    // Conditionally-enforcing rules (WP-11 P3) — FAIL only in enforce mode with
    // the matching per-rule flag enabled; otherwise report-only PASS.
    ruleTokenEstimate(req, estimatedTokens, mode),
    ruleStreaming(req),
    ruleImage(req),
    ruleContentClassification(ctx.classification, mode),
    ruleApproval(ctx.approvalStatus, mode),
    ruleTenant(ctx.tenantId, mode),
    ruleActorContext(ctx.actor, ctx.actorSource),
    ruleCost(mode, estimatedCostUsd),
  ];

  // report mode: always allow. enforce mode: deny if any rule FAILed.
  const allow = mode === 'enforce' ? !ruleResults.some((r) => r.status === 'FAIL') : true;
  return {
    allow, mode, profile,
    tenantId: ctx.tenantId, actor: ctx.actor, actorSource: ctx.actorSource, // WP-11 P6 / WP-12 C2
    classification: ctx.classification, approvalStatus: ctx.approvalStatus, // WP-12 C3 / C4
    ruleResults, policyVersion: POLICY_VERSION, estimatedTokens, estimatedCostUsd,
  };
}

module.exports = {
  evaluate,
  estimateTokens,
  estimateCostUsd,
  resolveContext,
  resolveMode,
  resolveMaxTokens,
  resolveMaxCost,
  resolveProfile,
  flagEnabled,
  PROFILES,
  DEFAULT_PROFILE,
  POLICY_VERSION,
  POLICY_MODE,
  MODEL_REGISTRY,
  AGENTS,
  OPERATIONS,
  PRICING,
  PRICING_PLACEHOLDER,
};
