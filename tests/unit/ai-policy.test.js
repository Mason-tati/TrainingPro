// WP-11 · P1 — Enterprise AI Policy Engine (report-only) tests.
// Proves evaluation, registries, token estimation, report metadata, and that the
// gateway integration is behaviour-preserving (no deny/mutation/regression).
require('../helpers/network-guard');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const policy = require(path.join(ROOT, 'lib', 'ai', 'policy.js'));
const gateway = require(path.join(ROOT, 'lib', 'ai-gateway.js'));
const registry = require(path.join(ROOT, 'lib', 'ai', 'providers', 'registry.js'));
const logger = require(path.join(ROOT, 'lib', 'logger.js'));
const { validateLogRecord } = require(path.join(ROOT, 'lib', 'log-schema.js'));

delete process.env.ANTHROPIC_API_KEY;
// WP-11 P3 — all policy env controls default to unset (report-only, no limits).
const POLICY_ENV = [
  'AI_POLICY_MODE', 'AI_POLICY_MAX_ESTIMATED_TOKENS', 'AI_POLICY_ENFORCE_TOKEN_LIMIT',
  'AI_POLICY_ENFORCE_APPROVAL', 'AI_POLICY_ENFORCE_TENANT',
  'AI_POLICY_ENFORCE_CLASSIFICATION', 'AI_POLICY_ENFORCE_COST',
  'AI_POLICY_MAX_COST_USD', 'AI_POLICY_PROFILE',
];
const clearPolicyEnv = () => { for (const k of POLICY_ENV) delete process.env[k]; };
beforeEach(() => { registry.__reset(); clearPolicyEnv(); }); // default = report
afterEach(() => { registry.__reset(); clearPolicyEnv(); logger.__resetSink(); logger.__setLevel('silent'); });

const baseReq = (o = {}) => ({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', system: 'sys', messages: [{ role: 'user', content: 'hello world' }], ...o });

// 1. Default allow + report shape.
test('P1-1. evaluate returns report-only allow with the documented shape', () => {
  const r = policy.evaluate(baseReq());
  assert.equal(r.allow, true);
  assert.equal(r.mode, 'report');
  assert.equal(r.policyVersion, 1);
  assert.ok(Array.isArray(r.ruleResults) && r.ruleResults.length >= 9);
  assert.equal(typeof r.estimatedTokens, 'number');
});

// 2. Policy executes all rules; each rule PASSes with the {rule,status,message} shape.
test('P1-2. all rules evaluate and PASS (report-only)', () => {
  const r = policy.evaluate(baseReq());
  const names = r.ruleResults.map((x) => x.rule);
  for (const expected of ['provider_allowed', 'agent_registered', 'operation_registered', 'model_allowed', 'token_estimate', 'content_classification', 'approval', 'tenant', 'cost']) {
    assert.ok(names.includes(expected), `rule ${expected} evaluated`);
  }
  for (const rr of r.ruleResults) {
    assert.equal(rr.status, 'PASS');
    assert.equal(typeof rr.rule, 'string');
    assert.equal(typeof rr.message, 'string');
  }
});

// 3. Providers / unknown provider (reported, never denied).
test('P1-3. providers recognised; unknown reported but still allowed', () => {
  const known = policy.evaluate(baseReq({ provider: 'openai', operation: 'generate_cover_image', model: 'gpt-image-1' }));
  assert.ok(known.ruleResults.find((x) => x.rule === 'provider_allowed').message.includes('recognised'));
  const unknown = policy.evaluate(baseReq({ provider: 'made-up' }));
  assert.equal(unknown.allow, true, 'still allowed (report-only)');
  assert.ok(unknown.ruleResults.find((x) => x.rule === 'provider_allowed').message.includes('not allowed'));
});

// 4. Agents recognised.
test('P1-4. agents recognised / reported', () => {
  assert.ok(policy.AGENTS.has('AI-DOC-001') && policy.AGENTS.has('AI-FRM-001') && policy.AGENTS.size === 9);
  assert.ok(policy.evaluate(baseReq({ agent: 'AI-DOC-001' })).ruleResults.find((x) => x.rule === 'agent_registered').message.includes('registered'));
  assert.ok(policy.evaluate(baseReq({ agent: 'AI-NOPE' })).ruleResults.find((x) => x.rule === 'agent_registered').message.includes('not registered'));
});

// 5. Operations recognised.
test('P1-5. operations recognised / reported', () => {
  assert.ok(policy.OPERATIONS.has('translate_segments') && policy.OPERATIONS.has('develop_deck'));
  assert.ok(policy.evaluate(baseReq({ operation: 'generate_content' })).ruleResults.find((x) => x.rule === 'operation_registered').message.includes('registered'));
  assert.ok(policy.evaluate(baseReq({ operation: 'unknown_op' })).ruleResults.find((x) => x.rule === 'operation_registered').message.includes('not registered'));
});

// 6. Model registry.
test('P1-6. model registry per provider', () => {
  assert.deepEqual(policy.MODEL_REGISTRY.anthropic, ['claude-sonnet-4-6', 'claude-haiku-4-5']);
  assert.deepEqual(policy.MODEL_REGISTRY.openai, ['gpt-image-1']);
  for (const p of ['gemini', 'ollama', 'azure-openai', 'bedrock', 'vertex']) assert.deepEqual(policy.MODEL_REGISTRY[p], []);
  assert.ok(policy.evaluate(baseReq({ model: 'claude-haiku-4-5' })).ruleResults.find((x) => x.rule === 'model_allowed').message.includes('allowed'));
  assert.ok(policy.evaluate(baseReq({ model: 'gpt-99' })).ruleResults.find((x) => x.rule === 'model_allowed').message.includes('not allowed'));
});

// 7. Token estimation (system + messages + prompt + image blocks).
test('P1-7. token estimation counts text, ~4 chars/token', () => {
  assert.equal(policy.estimateTokens({}), 0);
  const est = policy.estimateTokens({ system: 'x'.repeat(40), messages: [{ role: 'user', content: 'y'.repeat(40) }] });
  assert.equal(est, 20, '80 chars → 20 tokens');
  const withImg = policy.estimateTokens({ prompt: 'a'.repeat(20) });
  assert.equal(withImg, 5);
  // vision blocks (image + text) count the text
  const vision = policy.estimateTokens({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'z'.repeat(12) }] }] });
  assert.equal(vision, 3);
});

// 8. Image + stream rules present.
test('P1-8. image and stream requests are reported', () => {
  const img = policy.evaluate(baseReq({ provider: 'openai', prompt: 'cover' }));
  assert.ok(img.ruleResults.find((x) => x.rule === 'image_generation').message.includes('image generation'));
  const strm = policy.evaluate(baseReq({ stream: true }));
  assert.ok(strm.ruleResults.find((x) => x.rule === 'streaming').message.includes('streaming request'));
});

// 9. No mutation of the request object.
test('P1-9. evaluate never mutates the request', () => {
  const req = baseReq();
  const snap = JSON.parse(JSON.stringify(req));
  policy.evaluate(req);
  assert.deepEqual(req, snap);
});

// 10/11. Gateway: identical result + provider receives same request; policy metadata on AI_CALL.
test('P1-10/11. gateway result unchanged; provider gets same request; AI_CALL carries policy metadata', async () => {
  const result = { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 6, output_tokens: 4 } };
  let received;
  registry.__setProvider('anthropic', { complete: async (req) => { received = req; return result; } });
  const rows = [];
  const restore = logger.__setSink((r) => rows.push(r));
  logger.__setLevel('info');
  const req = baseReq();
  const out = await gateway.complete(req);
  logger.__setSink(restore); logger.__setLevel('silent');
  assert.equal(out, result, 'gateway returns identical result');
  assert.equal(received, req, 'provider received the exact same request object');
  const call = rows.find((r) => r.event === 'AI_CALL');
  assert.equal(validateLogRecord(call).valid, true);
  assert.equal(call.metadata.policyVersion, 1);
  assert.equal(call.metadata.policyMode, 'report');
  assert.equal(typeof call.metadata.estimatedTokens, 'number');
  assert.ok(call.metadata.estimatedTokens > 0, 'estimatedTokens computed');
});

// 12. Report-only: policy never denies, even for unknown provider/agent/model.
test('P1-12. policy never denies (report-only) for any input', () => {
  for (const bad of [{ provider: 'x' }, { agent: 'y' }, { operation: 'z' }, { model: 'q' }, {}]) {
    assert.equal(policy.evaluate(baseReq(bad)).allow, true);
  }
  assert.equal(policy.evaluate(null).allow, true);
  assert.equal(policy.evaluate(undefined).allow, true);
});

// 13. No network; guard active.
test('P1-13. no network occurs', () => {
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true);
});

// ── WP-11 P2 — mode flag + enforce rules ───────────────────────────────────
// P2-1. Default mode is report.
test('P2-1. default mode is report', () => {
  delete process.env.AI_POLICY_MODE;
  assert.equal(policy.resolveMode(), 'report');
  assert.equal(policy.evaluate(baseReq()).mode, 'report');
});

// P2-2. Invalid mode falls back to report.
test('P2-2. invalid mode falls back to report', () => {
  for (const bad of ['ENFORCE!', 'block', 'strict', '', '   ', 'reportx']) {
    process.env.AI_POLICY_MODE = bad;
    assert.equal(policy.resolveMode(), 'report', `"${bad}" → report`);
  }
});

// P2-enforce. enforce mode denies unknown provider/agent/operation/model; valid passes.
test('P2-4..8. enforce mode denies unknown allow-list fields; valid passes', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  assert.equal(policy.evaluate(baseReq({ provider: 'made-up' })).allow, false, 'unknown provider denied');
  assert.equal(policy.evaluate(baseReq({ agent: 'AI-NOPE' })).allow, false, 'unknown agent denied');
  assert.equal(policy.evaluate(baseReq({ operation: 'nope_op' })).allow, false, 'unknown operation denied');
  assert.equal(policy.evaluate(baseReq({ model: 'gpt-99' })).allow, false, 'unknown model denied');
  assert.equal(policy.evaluate(baseReq()).allow, true, 'valid request passes');
  // failing rules carry status FAIL in enforce mode
  const denied = policy.evaluate(baseReq({ agent: 'AI-NOPE' }));
  assert.equal(denied.ruleResults.find((r) => r.rule === 'agent_registered').status, 'FAIL');
});

// P2-14. token/classification/approval/tenant/user/cost remain non-enforcing (PASS) even in enforce mode.
test('P2-14. report-only rules never FAIL in enforce mode', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  const r = policy.evaluate(baseReq({ provider: 'made-up' })); // provider fails, but others must not
  for (const rule of ['token_estimate', 'streaming', 'image_generation', 'content_classification', 'approval', 'tenant', 'actor_context', 'cost']) { // WP-11 P6 — 'user' rule evolved into 'actor_context'
    assert.equal(r.ruleResults.find((x) => x.rule === rule).status, 'PASS', `${rule} stays PASS`);
  }
});

// P2-3. report mode: unknown provider still allows (registry throws downstream, as before).
test('P2-3. report mode allows unknown provider (no policy deny)', () => {
  delete process.env.AI_POLICY_MODE;
  assert.equal(policy.evaluate(baseReq({ provider: 'made-up' })).allow, true);
});

// ── WP-11 P3 — token / cost / approval / tenant / classification controls ───
const ruleOf = (r, name) => r.ruleResults.find((x) => x.rule === name);

// P3-1. Missing env flags keep report-only behaviour (no denials of any kind).
test('P3-1. no policy env flags → report-only; nothing denies', () => {
  clearPolicyEnv();
  const r = policy.evaluate(baseReq());
  assert.equal(r.mode, 'report');
  assert.equal(r.allow, true);
  for (const rr of r.ruleResults) assert.equal(rr.status, 'PASS');
});

// P3-2. Invalid token max is ignored safely (no limit).
test('P3-2. invalid/blank token max → no limit', () => {
  for (const bad of ['', '   ', 'abc', '0', '-5', '3.5', 'NaN', '1e9x']) {
    process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = bad;
    assert.equal(policy.resolveMaxTokens(), null, `"${bad}" → null`);
  }
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '1500';
  assert.equal(policy.resolveMaxTokens(), 1500);
});

// P3-3. enforce + token flag denies over max.
test('P3-3. enforce + token flag denies when estimate exceeds max', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TOKEN_LIMIT = 'true';
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '5';
  const big = baseReq({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }); // 100 tokens
  const r = policy.evaluate(big);
  assert.equal(r.allow, false);
  assert.equal(ruleOf(r, 'token_estimate').status, 'FAIL');
});

// P3-4. enforce + token flag allows under max.
test('P3-4. enforce + token flag allows when under max', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TOKEN_LIMIT = 'true';
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '100000';
  const r = policy.evaluate(baseReq());
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'token_estimate').status, 'PASS');
});

// P3-5. report mode + token flag never denies (flag inert without enforce).
test('P3-5. report mode + token flag does not deny', () => {
  delete process.env.AI_POLICY_MODE; // report
  process.env.AI_POLICY_ENFORCE_TOKEN_LIMIT = 'true';
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '1';
  const r = policy.evaluate(baseReq({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }));
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'token_estimate').status, 'PASS');
});

// P3-6/7. approval flag denies unless approved; allows when approved.
test('P3-6/7. enforce + approval flag denies unless approvalStatus==="approved"', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_APPROVAL = 'true';
  const denied = policy.evaluate(baseReq()); // no approvalStatus
  assert.equal(denied.allow, false);
  assert.equal(ruleOf(denied, 'approval').status, 'FAIL');
  const pending = policy.evaluate(baseReq({ approvalStatus: 'pending' }));
  assert.equal(pending.allow, false);
  const approved = policy.evaluate(baseReq({ approvalStatus: 'approved' }));
  assert.equal(approved.allow, true);
  assert.equal(ruleOf(approved, 'approval').status, 'PASS');
});

// P3-8/9. classification flag: an explicit "unclassified" fails; a real
// classification passes. (WP-12 C3 — classification is now operation-derived, so
// a bare mapped request no longer defaults to unclassified; see the C3 tests.)
test('P3-8/9. enforce + classification flag requires a real classification', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true';
  const unclassified = policy.evaluate(baseReq({ classification: 'unclassified' }));
  assert.equal(unclassified.allow, false);
  assert.equal(ruleOf(unclassified, 'content_classification').status, 'FAIL');
  const present = policy.evaluate(baseReq({ classification: 'internal' }));
  assert.equal(present.allow, true);
  assert.equal(ruleOf(present, 'content_classification').status, 'PASS');
});

// P3-10. tenant flag: documented safe design — non-empty tenantId passes; absent/null/'' fails.
test('P3-10. enforce + tenant flag requires a non-empty tenantId', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TENANT = 'true';
  assert.equal(policy.evaluate(baseReq()).allow, false, 'absent tenantId denied');
  assert.equal(policy.evaluate(baseReq({ tenantId: null })).allow, false, 'null tenantId denied');
  assert.equal(policy.evaluate(baseReq({ tenantId: '' })).allow, false, 'empty tenantId denied');
  const ok = policy.evaluate(baseReq({ tenantId: 'akara' }));
  assert.equal(ok.allow, true, 'present tenantId allowed');
  assert.equal(ruleOf(ok, 'tenant').status, 'PASS');
});

// P3-11. cost flag alone (no max ceiling configured) never denies (PASS).
// (P4 note: the cost rule now has real placeholder pricing; without a configured
// AI_POLICY_MAX_COST_USD ceiling it still cannot deny.)
test('P3-11. enforce + cost flag without a ceiling never denies (PASS)', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_COST = 'true';
  const r = policy.evaluate(baseReq());
  assert.equal(r.allow, true);
  const cost = ruleOf(r, 'cost');
  assert.equal(cost.status, 'PASS');
  assert.ok(cost.message.toLowerCase().includes('cost'), 'reports cost without denying');
});

// P3-12. multiple failing rules → allow:false.
test('P3-12. multiple FAIL rules produce allow:false', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_APPROVAL = 'true';
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true';
  const r = policy.evaluate(baseReq({ agent: 'AI-NOPE', classification: 'unclassified' })); // agent + approval + classification all FAIL
  assert.equal(r.allow, false);
  const fails = r.ruleResults.filter((x) => x.status === 'FAIL').map((x) => x.rule).sort();
  assert.deepEqual(fails, ['agent_registered', 'approval', 'content_classification']);
});

// P3-15. only the exact literal "true" enables a flag; variants stay disabled.
test('P3-15. enforcement flags enable only on literal "true"', () => {
  for (const v of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '']) {
    process.env.AI_POLICY_ENFORCE_APPROVAL = v;
    assert.equal(policy.flagEnabled('AI_POLICY_ENFORCE_APPROVAL'), false, `"${v}" stays off`);
  }
  process.env.AI_POLICY_ENFORCE_APPROVAL = 'true';
  assert.equal(policy.flagEnabled('AI_POLICY_ENFORCE_APPROVAL'), true);
});

// ── WP-11 P4 — pricing registry + estimated cost + cost ceiling ─────────────
// P4-1. pricing registry contains the current models and is marked placeholder.
test('P4-1. pricing registry lists current models (governance placeholder)', () => {
  assert.equal(policy.PRICING_PLACEHOLDER, true, 'pricing is flagged as a placeholder');
  assert.equal(typeof policy.PRICING.anthropic['claude-sonnet-4-6'].usdPerMInputTokens, 'number');
  assert.equal(typeof policy.PRICING.anthropic['claude-haiku-4-5'].usdPerMInputTokens, 'number');
  assert.equal(typeof policy.PRICING.openai['gpt-image-1'].usdPerImage, 'number');
});

// P4-2. unknown pricing → estimatedCostUsd null.
test('P4-2. unknown provider/model → estimatedCostUsd null', () => {
  assert.equal(policy.estimateCostUsd({ provider: 'made-up', model: 'x' }, 1000), null);
  assert.equal(policy.estimateCostUsd({ provider: 'anthropic', model: 'gpt-99' }, 1000), null);
  assert.equal(policy.evaluate(baseReq({ provider: 'made-up' })).estimatedCostUsd, null);
});

// P4-2b. a pricing entry with an unrecognised shape returns null safely (defensive).
test('P4-2b. unrecognised pricing shape → null (no cost, no crash)', () => {
  policy.PRICING.anthropic.__malformed = { note: 'no usd fields' };
  try {
    assert.equal(policy.estimateCostUsd({ provider: 'anthropic', model: '__malformed' }, 1000), null);
  } finally {
    delete policy.PRICING.anthropic.__malformed;
  }
});

// P4-3. text cost estimate is finite >= 0.
test('P4-3. text-model cost estimate is finite and non-negative', () => {
  const c = policy.estimateCostUsd({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, 1_000_000);
  assert.ok(Number.isFinite(c) && c >= 0, 'finite >= 0');
  assert.equal(c, 3.0, '1,000,000 tokens × $3/MTok placeholder = $3.00');
  assert.equal(policy.estimateCostUsd({ provider: 'anthropic', model: 'claude-haiku-4-5' }, 0), 0, 'zero tokens → $0');
});

// P4-4. image cost estimate is finite >= 0 and scales with n.
test('P4-4. image-model cost estimate is finite, non-negative, per-image', () => {
  const one = policy.estimateCostUsd({ provider: 'openai', model: 'gpt-image-1' }, 0);
  assert.ok(Number.isFinite(one) && one >= 0);
  assert.equal(one, 0.04, 'default n=1');
  assert.equal(policy.estimateCostUsd({ provider: 'openai', model: 'gpt-image-1', n: 3 }, 0), 0.12, 'n=3');
});

// P4-5. report mode + cost flag never denies.
test('P4-5. report mode + cost flag does not deny', () => {
  delete process.env.AI_POLICY_MODE; // report
  process.env.AI_POLICY_ENFORCE_COST = 'true';
  process.env.AI_POLICY_MAX_COST_USD = '0.0000001'; // tiny ceiling
  const r = policy.evaluate(baseReq());
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'cost').status, 'PASS');
});

// P4-6. enforce + cost flag + over max → deny.
test('P4-6. enforce + cost flag + estimate over max denies', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_COST = 'true';
  process.env.AI_POLICY_MAX_COST_USD = '0.0000001';
  const big = baseReq({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }); // ~1000 tokens → ~$0.003
  const r = policy.evaluate(big);
  assert.equal(r.allow, false);
  assert.equal(ruleOf(r, 'cost').status, 'FAIL');
});

// P4-7. enforce + cost flag + under max → allow.
test('P4-7. enforce + cost flag + estimate under max allows', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_COST = 'true';
  process.env.AI_POLICY_MAX_COST_USD = '100';
  const r = policy.evaluate(baseReq());
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'cost').status, 'PASS');
});

// P4-8. invalid/missing max cost → does not deny.
test('P4-8. invalid or missing max cost does not deny', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_COST = 'true';
  for (const bad of [undefined, '', '   ', 'abc', '0', '-1', 'NaN']) {
    if (bad === undefined) delete process.env.AI_POLICY_MAX_COST_USD;
    else process.env.AI_POLICY_MAX_COST_USD = bad;
    assert.equal(policy.resolveMaxCost(), null, `"${bad}" → null`);
    const r = policy.evaluate(baseReq({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }));
    assert.equal(r.allow, true, `"${bad}" does not deny`);
    assert.equal(ruleOf(r, 'cost').status, 'PASS');
  }
});

// P4-9. missing pricing → does not deny (even with flag + max set).
test('P4-9. missing pricing does not deny', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_COST = 'true';
  process.env.AI_POLICY_MAX_COST_USD = '0.0000001';
  const r = policy.evaluate(baseReq({ provider: 'anthropic', model: 'gpt-99' })); // unpriced model
  // model_allowed will FAIL (unknown model) but the COST rule itself must PASS
  assert.equal(r.estimatedCostUsd, null);
  const cost = ruleOf(r, 'cost');
  assert.equal(cost.status, 'PASS');
  assert.ok(cost.message.toLowerCase().includes('unavailable'), 'says pricing unavailable');
});

// P4-cost-report. evaluate() exposes estimatedCostUsd for priced requests.
test('P4. evaluate exposes estimatedCostUsd for a priced request', () => {
  const r = policy.evaluate(baseReq());
  assert.ok(typeof r.estimatedCostUsd === 'number' && r.estimatedCostUsd >= 0);
});

// ── WP-11 P5 — policy configuration profiles ────────────────────────────────
// P5-1. default profile is standard.
test('P5-1. default profile is standard', () => {
  clearPolicyEnv();
  assert.equal(policy.resolveProfile(), 'standard');
  assert.equal(policy.evaluate(baseReq()).profile, 'standard');
});

// P5-2. invalid/blank profile falls back to standard.
test('P5-2. invalid or blank profile → standard', () => {
  for (const bad of ['STRICT!', 'prod', 'production', 'loose', '', '   ', 'strictx']) {
    process.env.AI_POLICY_PROFILE = bad;
    assert.equal(policy.resolveProfile(), 'standard', `"${bad}" → standard`);
  }
});

// P5-3. strict profile defaults are correct (mode + flags + ceilings).
test('P5-3. strict profile applies enforce mode, all flags, and default ceilings', () => {
  process.env.AI_POLICY_PROFILE = 'strict';
  assert.equal(policy.resolveMode(), 'enforce');
  for (const f of ['AI_POLICY_ENFORCE_TOKEN_LIMIT', 'AI_POLICY_ENFORCE_APPROVAL', 'AI_POLICY_ENFORCE_TENANT', 'AI_POLICY_ENFORCE_CLASSIFICATION', 'AI_POLICY_ENFORCE_COST']) {
    assert.equal(policy.flagEnabled(f), true, `${f} on under strict`);
  }
  assert.equal(policy.resolveMaxTokens(), 20000);
  assert.equal(policy.resolveMaxCost(), 5.0);
});

// P5-4. development profile defaults are correct (permissive).
test('P5-4. development profile is permissive (report, no flags, no ceilings)', () => {
  process.env.AI_POLICY_PROFILE = 'development';
  assert.equal(policy.resolveMode(), 'report');
  for (const f of ['AI_POLICY_ENFORCE_TOKEN_LIMIT', 'AI_POLICY_ENFORCE_APPROVAL', 'AI_POLICY_ENFORCE_TENANT', 'AI_POLICY_ENFORCE_CLASSIFICATION', 'AI_POLICY_ENFORCE_COST']) {
    assert.equal(policy.flagEnabled(f), false, `${f} off under development`);
  }
  assert.equal(policy.resolveMaxTokens(), null);
  assert.equal(policy.resolveMaxCost(), null);
});

// P5-5/6-override. explicit env overrides the profile default.
test('P5-5. explicit env vars override profile defaults', () => {
  process.env.AI_POLICY_PROFILE = 'strict';
  // explicit report beats strict's enforce
  process.env.AI_POLICY_MODE = 'report';
  assert.equal(policy.resolveMode(), 'report', 'explicit mode wins');
  // explicit flag off beats strict's on
  process.env.AI_POLICY_ENFORCE_COST = 'false';
  assert.equal(policy.flagEnabled('AI_POLICY_ENFORCE_COST'), false, 'explicit flag wins');
  // explicit ceilings override
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '999';
  process.env.AI_POLICY_MAX_COST_USD = '1.25';
  assert.equal(policy.resolveMaxTokens(), 999);
  assert.equal(policy.resolveMaxCost(), 1.25);
});

// P5-6. strict profile denies an oversized token request (token rule FAIL).
test('P5-6. strict profile denies an oversized token request', () => {
  process.env.AI_POLICY_PROFILE = 'strict';
  const big = baseReq({ approvalStatus: 'approved', tenantId: 'akara', classification: 'internal', messages: [{ role: 'user', content: 'x'.repeat(200000) }] }); // ~50000 tokens > 20000
  const r = policy.evaluate(big);
  assert.equal(r.allow, false);
  assert.equal(ruleOf(r, 'token_estimate').status, 'FAIL');
});

// P5-7. standard profile does not deny.
test('P5-7. standard profile does not deny', () => {
  process.env.AI_POLICY_PROFILE = 'standard';
  const r = policy.evaluate(baseReq({ messages: [{ role: 'user', content: 'x'.repeat(200000) }] }));
  assert.equal(r.mode, 'report');
  assert.equal(r.allow, true);
});

// P5-8. report override on strict disables denial.
test('P5-8. AI_POLICY_MODE=report on a strict profile disables all denial', () => {
  process.env.AI_POLICY_PROFILE = 'strict';
  process.env.AI_POLICY_MODE = 'report';
  const r = policy.evaluate(baseReq({ agent: 'AI-NOPE', messages: [{ role: 'user', content: 'x'.repeat(200000) }] }));
  assert.equal(r.mode, 'report');
  assert.equal(r.allow, true, 'report mode never denies even under strict flags');
});

// P5-9. estimatedCost still calculated under profiles.
test('P5-9. estimatedCostUsd is still computed under a profile', () => {
  process.env.AI_POLICY_PROFILE = 'strict';
  const r = policy.evaluate(baseReq({ approvalStatus: 'approved', tenantId: 't', classification: 'c' }));
  assert.ok(typeof r.estimatedCostUsd === 'number' && r.estimatedCostUsd >= 0);
  assert.equal(r.profile, 'strict');
});

// ── WP-11 P6 — tenant / actor / classification context ──────────────────────
// P6-1. tenantId from request wins over context.
test('P6-1. tenantId from request wins', () => {
  const r = policy.evaluate(baseReq({ tenantId: 'req-tenant' }), { tenantId: 'ctx-tenant' });
  assert.equal(r.tenantId, 'req-tenant');
});

// P6-2. tenantId from context used when request has none.
test('P6-2. tenantId from context used when request missing', () => {
  const r = policy.evaluate(baseReq(), { tenantId: 'ctx-tenant' });
  assert.equal(r.tenantId, 'ctx-tenant');
});

// P6-3. tenantId defaults to null.
test('P6-3. tenantId defaults to null', () => {
  assert.equal(policy.evaluate(baseReq()).tenantId, null);
  assert.equal(policy.evaluate(baseReq({ tenantId: '' }), {}).tenantId, null);
});

// P6-4. actor from request wins.
test('P6-4. actor from request wins', () => {
  const r = policy.evaluate(baseReq({ actor: 'req-user' }), { actor: 'ctx-user' });
  assert.equal(r.actor, 'req-user');
});

// P6-5. actor from context used when request missing.
test('P6-5. actor from context used when request missing', () => {
  const r = policy.evaluate(baseReq(), { actor: 'ctx-user' });
  assert.equal(r.actor, 'ctx-user');
});

// P6-6. actor defaults to anonymous.
test('P6-6. actor defaults to anonymous', () => {
  assert.equal(policy.evaluate(baseReq()).actor, 'anonymous');
});

// P6-7. classification from request is returned.
test('P6-7. classification from request is returned', () => {
  assert.equal(policy.evaluate(baseReq({ classification: 'confidential' })).classification, 'confidential');
});

// P6-8. classification derives from the operation registry (WP-12 C3); an
// unmapped/absent operation still defaults to unclassified.
test('P6-8. classification derives from the operation registry (default unclassified)', () => {
  assert.equal(policy.evaluate(baseReq()).classification, 'training', 'generate_content → training');
  assert.equal(policy.evaluate(baseReq({ operation: 'unknown_op' })).classification, 'unclassified');
  assert.equal(policy.evaluate(baseReq({ operation: undefined })).classification, 'unclassified');
});

// P6-9. tenant enforce denies null/missing tenant.
test('P6-9. tenant enforce denies missing tenant', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TENANT = 'true';
  const r = policy.evaluate(baseReq());
  assert.equal(r.allow, false);
  assert.equal(ruleOf(r, 'tenant').status, 'FAIL');
});

// P6-10. tenant enforce allows a request tenant.
test('P6-10. tenant enforce allows request tenant', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TENANT = 'true';
  const r = policy.evaluate(baseReq({ tenantId: 'akara' }));
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'tenant').status, 'PASS');
});

// P6-11. tenant enforce allows a context tenant (request has none).
test('P6-11. tenant enforce allows context tenant', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TENANT = 'true';
  const r = policy.evaluate(baseReq(), { tenantId: 'ctx-tenant' });
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'tenant').status, 'PASS');
});

// P6-12. classification enforce denies an unclassified request (explicit, or an
// unmapped operation that resolves to unclassified).
test('P6-12. classification enforce denies unclassified', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true';
  const explicit = policy.evaluate(baseReq({ classification: 'unclassified' }));
  assert.equal(explicit.allow, false);
  assert.equal(ruleOf(explicit, 'content_classification').status, 'FAIL');
  // an unmapped operation resolves to unclassified → the classification rule FAILs too
  assert.equal(ruleOf(policy.evaluate(baseReq({ operation: 'unmapped_op' })), 'content_classification').status, 'FAIL');
});

// P6-13. classification enforce allows a classified request.
test('P6-13. classification enforce allows classified request', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true';
  const r = policy.evaluate(baseReq({ classification: 'internal' }));
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'content_classification').status, 'PASS');
});

// P6-14. actor_context rule exists, always PASSes, and reports the source.
test('P6-14. actor_context rule exists and PASSes with a source', () => {
  const fromReq = policy.evaluate(baseReq({ actor: 'u1' }));
  const rr = ruleOf(fromReq, 'actor_context');
  assert.ok(rr, 'actor_context rule present');
  assert.equal(rr.status, 'PASS');
  assert.ok(rr.message.includes('request'), 'source: request');
  assert.ok(ruleOf(policy.evaluate(baseReq(), { actor: 'u2' }), 'actor_context').message.includes('context'), 'source: context');
  assert.ok(ruleOf(policy.evaluate(baseReq()), 'actor_context').message.includes('default'), 'source: default');
  // even in enforce mode it never FAILs
  process.env.AI_POLICY_MODE = 'enforce';
  assert.equal(ruleOf(policy.evaluate(baseReq()), 'actor_context').status, 'PASS');
});

// ── WP-12 C2 — actor context verification & hardening ───────────────────────
// C2-1. request.actor wins → actor + actorSource "request".
test('C2-1. request.actor wins (actorSource=request)', () => {
  const r = policy.evaluate(baseReq({ actor: 'req-user' }), { actor: 'ctx-user' });
  assert.equal(r.actor, 'req-user');
  assert.equal(r.actorSource, 'request');
});

// C2-2. context actor used when request.actor missing → actorSource "context".
test('C2-2. context actor used when request.actor missing (actorSource=context)', () => {
  const r = policy.evaluate(baseReq(), { actor: 'ctx-user' });
  assert.equal(r.actor, 'ctx-user');
  assert.equal(r.actorSource, 'context');
});

// C2-3. empty request.actor falls back to context.
test('C2-3. empty request.actor falls back to context', () => {
  for (const empty of ['', '   ', null, undefined, 42]) {
    const r = policy.evaluate(baseReq({ actor: empty }), { actor: 'ctx-user' });
    assert.equal(r.actor, 'ctx-user', `request.actor=${String(empty)} → context`);
    assert.equal(r.actorSource, 'context');
  }
});

// C2-4. empty context actor falls back to anonymous/default.
test('C2-4. empty context actor falls back to anonymous (actorSource=default)', () => {
  for (const empty of [{}, { actor: '' }, { actor: '   ' }, { actor: null }]) {
    const r = policy.evaluate(baseReq(), empty);
    assert.equal(r.actor, 'anonymous');
    assert.equal(r.actorSource, 'default');
  }
});

// C2-5. outside any request context, actor is anonymous/default.
test('C2-5. no request context → actor anonymous/default', () => {
  const r = policy.evaluate(baseReq()); // no context arg, no active ALS
  assert.equal(r.actor, 'anonymous');
  assert.equal(r.actorSource, 'default');
});

// C2-6/7. actorSource returned + actor_context rule message reports the source.
test('C2-6/7. actorSource on evaluate() and in the actor_context rule message', () => {
  const cases = [
    [baseReq({ actor: 'u' }), undefined, 'request'],
    [baseReq(), { actor: 'c' }, 'context'],
    [baseReq(), undefined, 'default'],
  ];
  for (const [req, ctx, expected] of cases) {
    const r = policy.evaluate(req, ctx);
    assert.equal(r.actorSource, expected, `evaluate actorSource=${expected}`);
    const rule = ruleOf(r, 'actor_context');
    assert.equal(rule.status, 'PASS');
    assert.ok(rule.message.includes(`source: ${expected}`), `rule message reports source ${expected}`);
  }
});

// ── WP-12 C3 — classification derived from the operation registry ───────────
const opPolicy = require(path.join(ROOT, 'lib', 'ai', 'operation-policy.js'));

// C3-1. request.classification wins over the operation registry.
test('C3-1. request.classification wins over the operation registry', () => {
  const r = policy.evaluate(baseReq({ operation: 'generate_content', classification: 'confidential' }));
  assert.equal(r.classification, 'confidential', 'request value used, not registry "training"');
});

// C3-2. operation registry classification used when request.classification missing.
test('C3-2. operation registry classification used when request missing', () => {
  assert.equal(policy.evaluate(baseReq({ operation: 'draft_disciplinary' })).classification, 'hr');
  assert.equal(policy.evaluate(baseReq({ operation: 'translate_segments' })).classification, 'translation');
  assert.equal(policy.evaluate(baseReq({ operation: 'generate_cover_image' })).classification, 'image_generation');
});

// C3-3. unknown operation defaults to unclassified.
test('C3-3. unknown operation → unclassified', () => {
  assert.equal(policy.evaluate(baseReq({ operation: 'not_a_real_op' })).classification, 'unclassified');
});

// C3-4. missing operation defaults to unclassified.
test('C3-4. missing operation → unclassified', () => {
  assert.equal(policy.evaluate(baseReq({ operation: undefined })).classification, 'unclassified');
  assert.equal(policy.evaluate(baseReq({ operation: '' })).classification, 'unclassified');
  assert.equal(policy.evaluate({}).classification, 'unclassified');
});

// C3-5. every approved operation resolves to its registry classification.
test('C3-5. all approved operations resolve to their registry classification', () => {
  for (const op of opPolicy.OPERATIONS) {
    const expected = opPolicy.getOperationPolicy(op).classification;
    assert.equal(policy.evaluate(baseReq({ operation: op })).classification, expected, `${op} → ${expected}`);
  }
});

// C3-6. classification enforcement passes for a mapped operation.
test('C3-6. classification enforce passes for a mapped operation', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true';
  const r = policy.evaluate(baseReq({ operation: 'generate_content' })); // → training
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'content_classification').status, 'PASS');
});

// C3-7. classification enforcement fails for an unknown operation (→ unclassified).
test('C3-7. classification enforce fails for an unknown operation', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true';
  const r = policy.evaluate(baseReq({ operation: 'unknown_op' }));
  assert.equal(ruleOf(r, 'content_classification').status, 'FAIL');
});

// C3-8. classification enforcement fails for an explicit "unclassified".
test('C3-8. classification enforce fails for explicit unclassified', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true';
  const r = policy.evaluate(baseReq({ classification: 'unclassified' }));
  assert.equal(r.allow, false);
  assert.equal(ruleOf(r, 'content_classification').status, 'FAIL');
});

// C3-9. report mode never denies classification (even unclassified).
test('C3-9. report mode never denies classification', () => {
  delete process.env.AI_POLICY_MODE; // report
  process.env.AI_POLICY_ENFORCE_CLASSIFICATION = 'true'; // inert without enforce
  const r = policy.evaluate(baseReq({ classification: 'unclassified' }));
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'content_classification').status, 'PASS');
});

// C3-10. operation-derived classification is NOT in AI_CALL metadata (gateway).
test('C3-10. classification is not logged in AI_CALL metadata', async () => {
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 3, output_tokens: 2 } }) });
  const rows = [];
  const restore = logger.__setSink((r) => rows.push(r));
  logger.__setLevel('info');
  await gateway.complete(baseReq({ operation: 'draft_disciplinary' })); // registry classification "hr"
  logger.__setSink(restore); logger.__setLevel('silent');
  const call = rows.find((r) => r.event === 'AI_CALL');
  assert.equal(validateLogRecord(call).valid, true);
  assert.ok(!('classification' in call.metadata), 'no classification field in AI_CALL metadata');
  assert.ok(!JSON.stringify(call).includes('"hr"'), 'classification label absent from the record');
});

// C3-11. evaluate does not mutate the request during classification resolution.
test('C3-11. classification resolution does not mutate the request', () => {
  const req = baseReq({ operation: 'draft_disciplinary' });
  const snap = JSON.parse(JSON.stringify(req));
  policy.evaluate(req);
  assert.deepEqual(req, snap, 'request unchanged (no classification injected)');
});

// ── WP-12 C4 — approvalStatus derived from the operation registry ───────────
// C4-1. request.approvalStatus wins over the operation registry.
test('C4-1. request.approvalStatus wins over the operation registry', () => {
  const r = policy.evaluate(baseReq({ operation: 'draft_disciplinary', approvalStatus: 'approved' }));
  assert.equal(r.approvalStatus, 'approved', 'request value used, not registry "draft"');
});

// C4-2. operation registry approval used when request.approvalStatus missing.
test('C4-2. operation registry approval used when request missing', () => {
  assert.equal(policy.evaluate(baseReq({ operation: 'draft_disciplinary' })).approvalStatus, 'draft');
  assert.equal(policy.evaluate(baseReq({ operation: 'generate_content' })).approvalStatus, 'not_required');
  assert.equal(policy.evaluate(baseReq({ operation: 'question_extract' })).approvalStatus, 'draft');
});

// C4-3. unknown operation defaults to not_required.
test('C4-3. unknown operation → not_required', () => {
  assert.equal(policy.evaluate(baseReq({ operation: 'not_a_real_op' })).approvalStatus, 'not_required');
});

// C4-4. missing operation defaults to not_required.
test('C4-4. missing operation → not_required', () => {
  assert.equal(policy.evaluate(baseReq({ operation: undefined })).approvalStatus, 'not_required');
  assert.equal(policy.evaluate(baseReq({ operation: '' })).approvalStatus, 'not_required');
  assert.equal(policy.evaluate({}).approvalStatus, 'not_required');
});

// C4-5. every approved operation resolves to its registry approval.
test('C4-5. all approved operations resolve to their registry approval', () => {
  for (const op of opPolicy.OPERATIONS) {
    const expected = opPolicy.getOperationPolicy(op).approval;
    assert.equal(policy.evaluate(baseReq({ operation: op })).approvalStatus, expected, `${op} → ${expected}`);
  }
});

// C4-6. approval enforcement passes when approvalStatus is "approved".
test('C4-6. approval enforce passes when approved', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_APPROVAL = 'true';
  const r = policy.evaluate(baseReq({ approvalStatus: 'approved' }));
  assert.equal(r.allow, true);
  assert.equal(ruleOf(r, 'approval').status, 'PASS');
});

// C4-7. approval enforcement fails for "draft".
test('C4-7. approval enforce fails for draft', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_APPROVAL = 'true';
  const r = policy.evaluate(baseReq({ operation: 'draft_disciplinary' })); // registry draft
  assert.equal(r.allow, false);
  assert.equal(ruleOf(r, 'approval').status, 'FAIL');
});

// C4-8. approval enforcement fails for "not_required" (NOT treated as approved).
test('C4-8. approval enforce fails for not_required', () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_APPROVAL = 'true';
  const r = policy.evaluate(baseReq({ operation: 'generate_content' })); // registry not_required
  assert.equal(r.approvalStatus, 'not_required');
  assert.equal(r.allow, false);
  assert.equal(ruleOf(r, 'approval').status, 'FAIL');
});

// C4-9. report mode never denies for draft/not_required.
test('C4-9. report mode never denies approvalStatus draft/not_required', () => {
  delete process.env.AI_POLICY_MODE; // report
  process.env.AI_POLICY_ENFORCE_APPROVAL = 'true'; // inert without enforce
  for (const op of ['draft_disciplinary', 'generate_content']) {
    const r = policy.evaluate(baseReq({ operation: op }));
    assert.equal(r.allow, true, `${op} allowed in report mode`);
    assert.equal(ruleOf(r, 'approval').status, 'PASS');
  }
});

// C4-10. operation-derived approvalStatus is NOT in AI_CALL metadata (gateway).
test('C4-10. approvalStatus is not logged in AI_CALL metadata', async () => {
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 3, output_tokens: 2 } }) });
  const rows = [];
  const restore = logger.__setSink((r) => rows.push(r));
  logger.__setLevel('info');
  await gateway.complete(baseReq({ operation: 'draft_disciplinary' })); // registry approval "draft"
  logger.__setSink(restore); logger.__setLevel('silent');
  const call = rows.find((r) => r.event === 'AI_CALL');
  assert.equal(validateLogRecord(call).valid, true);
  assert.ok(!('approvalStatus' in call.metadata), 'no approvalStatus field in AI_CALL metadata');
  assert.equal(call.metadata.decisionStatus, 'draft', 'existing decisionStatus field unchanged');
});

// C4-11. approval resolution does not mutate the request.
test('C4-11. approval resolution does not mutate the request', () => {
  const req = baseReq({ operation: 'draft_disciplinary' });
  const snap = JSON.parse(JSON.stringify(req));
  policy.evaluate(req);
  assert.deepEqual(req, snap, 'request unchanged (no approvalStatus injected)');
});

// ── WP-12 C5 — policy.evaluate() return safety sweep ────────────────────────
// evaluate() must not mutate the request and must never copy prompt / message /
// document / medical / disciplinary / SQL text into its returned context fields
// or rule messages. Governance context fields carry only the identifiers passed.
test('C5. evaluate() returns safe context and never leaks content', () => {
  const C5 = {
    actor: 'C5P-ACTOR', tenant: 'C5P-TENANT-SECRET', classification: 'C5P-CLASS-ID', approval: 'C5P-APPROVAL-ID',
    system: 'C5P-SYSTEM-PROMPT-body', message: 'C5P-MESSAGE-body', document: 'C5P-DOCUMENT-body',
    medical: 'C5P-MEDICAL-body', disciplinary: 'C5P-DISCIPLINARY-body',
    sql: "SELECT HashPass FROM tblPswd", apiKey: 'sk-C5Papikey0123456789', email: 'c5p@example.com',
  };
  const req = baseReq({
    operation: 'draft_disciplinary',
    actor: C5.actor, tenantId: C5.tenant, classification: C5.classification, approvalStatus: C5.approval,
    system: `${C5.system} ${C5.document} ${C5.apiKey}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${C5.message} ${C5.medical} ${C5.disciplinary} ${C5.email} ${C5.sql}` }] }],
  });
  const snapshot = JSON.parse(JSON.stringify(req));
  const r = policy.evaluate(req);

  // no mutation
  assert.deepEqual(req, snapshot, 'evaluate did not mutate the request');

  // context fields carry only the identifiers the caller passed
  assert.equal(r.actor, C5.actor);
  assert.equal(r.actorSource, 'request');
  assert.equal(r.tenantId, C5.tenant);
  assert.equal(r.classification, C5.classification);
  assert.equal(r.approvalStatus, C5.approval);

  // prompt / message / document / medical / disciplinary / SQL / key text must
  // NOT appear in the returned context fields …
  const contextJson = JSON.stringify({
    tenantId: r.tenantId, actor: r.actor, actorSource: r.actorSource,
    classification: r.classification, approvalStatus: r.approvalStatus,
  });
  const CONTENT = [C5.system, C5.message, C5.document, C5.medical, C5.disciplinary, C5.sql, C5.apiKey, C5.email];
  for (const leak of CONTENT) assert.ok(!contextJson.includes(leak), `context field leaked: ${leak.slice(0, 18)}…`);

  // … nor in any rule message (ruleResults are not logged, but prove it anyway)
  const ruleJson = JSON.stringify(r.ruleResults);
  for (const leak of CONTENT) assert.ok(!ruleJson.includes(leak), `rule message leaked: ${leak.slice(0, 18)}…`);

  // returned governance values are simple enums/identifiers (no whitespace/among safe shapes)
  assert.equal(typeof r.classification, 'string');
  assert.equal(typeof r.approvalStatus, 'string');
});

// ── WP-12 C6 — close-out ────────────────────────────────────────────────────
test('C6. WP-12 close-out: registry coverage, context fields, safe defaults', () => {
  clearPolicyEnv();
  // the operation registry covers every approved policy operation (it is a
  // superset — it also carries governance metadata for a few extra operations).
  for (const op of policy.OPERATIONS) {
    assert.ok(opPolicy.OPERATIONS.includes(op), `registry covers approved operation ${op}`);
  }
  assert.ok(opPolicy.OPERATIONS.length >= policy.OPERATIONS.size, 'registry ⊇ approved operations');

  // evaluate() returns the full context field-set and does not mutate the request
  const req = baseReq({ operation: 'draft_disciplinary' });
  const snap = JSON.parse(JSON.stringify(req));
  const r = policy.evaluate(req);
  for (const f of ['actor', 'actorSource', 'tenantId', 'classification', 'approvalStatus']) {
    assert.ok(f in r, `evaluate returns ${f}`);
  }
  assert.deepEqual(req, snap, 'no request mutation');

  // safe production defaults: report mode, standard profile, nothing denies
  assert.equal(policy.resolveMode(), 'report');
  assert.equal(policy.resolveProfile(), 'standard');
  assert.equal(policy.evaluate(baseReq()).allow, true, 'no denial by default');
});
