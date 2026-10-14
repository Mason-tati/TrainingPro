// WP-10 · A1 — Enterprise AI Gateway (foundation).
//
//   Routes (future) → AI Gateway → Policy → Provider Registry → Provider Adapter → SDK
//
// The gateway is the single central AI boundary: it owns orchestration; providers
// own SDK calls; routes must never know providers. A1 is architectural only —
// NOTHING in production calls the gateway yet, and there is ZERO behaviour change.
//
// Passthrough guarantee: the request object is forwarded to the provider adapter
// unchanged (same reference), and the adapter's response / stream / error is
// returned to the caller unchanged. No wrapping, no metadata, no logging.
// The policy stage is a placeholder that currently ALWAYS allows and performs no
// enforcement (approval / cost / token / classification / tenant / model
// allow-list are future work).
'use strict';
const registry = require('./ai/providers/registry');
const logger = require('./logger');
const requestContext = require('./request-context');
const policy = require('./ai/policy');
const { performance } = require('node:perf_hooks');

const DEFAULT_TEXT_PROVIDER = 'anthropic';
const DEFAULT_IMAGE_PROVIDER = 'openai';

// Extract token usage from a provider response. Anthropic returns
// { usage: { input_tokens, output_tokens } }; absent/partial → 0.
function extractUsage(result) {
  const u = result && typeof result === 'object' ? result.usage : null;
  const inputTokens = u && Number.isFinite(u.input_tokens) ? u.input_tokens : 0;
  const outputTokens = u && Number.isFinite(u.output_tokens) ? u.output_tokens : 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

// Emit exactly one metadata-only AI_CALL audit event (module=AI via logger.aiEvent).
// Only allow-listed operational metadata is passed — never prompts, messages,
// system, responses, or image prompts. Fully fenced: auditing must never affect
// the provider result.
function auditAiCall(request, providerName, usage, durationMs, report) {
  try {
    logger.aiEvent('AI_CALL', {
      provider: providerName,
      model: request.model || null,
      agent: request.agent || null,
      operation: request.operation || null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      // WP-11 P4 — estimated cost from the policy pricing registry when available
      // (a positive estimate); a null/zero estimate stays null. Estimate only.
      costUsd: report && report.estimatedCostUsd ? report.estimatedCostUsd : null,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
      status: 'ok',
      decisionStatus: 'draft',
      // WP-11 P1 — report-only policy metadata (never denies/modifies the request).
      policyVersion: report ? report.policyVersion : null,
      policyMode: report ? report.mode : null,
      estimatedTokens: report ? report.estimatedTokens : null,
    });
  } catch { /* logging must never affect the provider result */ }
}

// Emit exactly one metadata-only AI_CALL error event (module=AI). Token counts
// are zeroed; errorName + errorMessage only (the message is masked by the L6/L1
// redactor) — never stacks, prompts, responses, request bodies, or keys. Fully
// fenced: auditing must never change the thrown error.
function auditAiError(request, providerName, err, durationMs, report) {
  try {
    logger.aiEvent('AI_CALL', {
      provider: providerName,
      model: request.model || null,
      agent: request.agent || null,
      operation: request.operation || null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: null,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
      status: 'error',
      decisionStatus: 'draft',
      errorName: err && err.name ? String(err.name) : 'Error',
      errorMessage: err && err.message ? String(err.message) : String(err), // redactor masks patterns
      // WP-11 P1 — report-only policy metadata.
      policyVersion: report ? report.policyVersion : null,
      policyMode: report ? report.mode : null,
      estimatedTokens: report ? report.estimatedTokens : null,
    });
  } catch { /* logging must never change the thrown error */ }
}

function validate(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('AI gateway: request must be an object');
  }
}

// Placeholder policy — always ALLOW, no enforcement. Future WPs return
// { allow:false, reason } to gate approval/cost/tokens/classification/tenant.
function defaultPolicy(request) { // eslint-disable-line no-unused-vars
  return { allow: true };
}
let _policy = defaultPolicy;

function runPolicy(request) {
  const decision = _policy(request);
  if (!decision || !decision.allow) {
    const err = new Error('AI gateway: request denied by policy' + (decision && decision.reason ? ` (${decision.reason})` : ''));
    err.policyDenied = true;
    throw err;
  }
  return decision;
}

// WP-11 P2 — build a safe, content-free deny error and audit one AI_CALL error
// event. No provider is called. The message is generic (no prompts/keys/request).
function policyDeny(request, providerName, report) {
  const err = new Error('This AI request was blocked by policy.');
  err.name = 'PolicyDeniedError';
  err.code = 'AI_POLICY_DENIED';
  err.status = 403;
  err.userError = true;
  auditAiError(request, providerName, err, 0, report);
  return err;
}

async function complete(request = {}) {
  validate(request);
  runPolicy(request);
  const report = policy.evaluate(request, requestContext.get()); // WP-11 P1/P2/P6 — report/enforce + ambient context
  const providerName = request.provider || DEFAULT_TEXT_PROVIDER;
  if (!report.allow) throw policyDeny(request, providerName, report); // enforce deny — before provider lookup
  const provider = registry.getProvider(providerName);
  const t0 = performance.now();
  let result;
  try {
    result = await provider.complete(request); // EXACT provider response
  } catch (err) {
    auditAiError(request, providerName, err, performance.now() - t0, report);
    throw err; // rethrow the ORIGINAL error object, unchanged
  }
  auditAiCall(request, providerName, extractUsage(result), performance.now() - t0, report);
  return result;
}

async function stream(request = {}) {
  validate(request);
  runPolicy(request);
  const report = policy.evaluate(request, requestContext.get()); // WP-11 P1/P2/P6 — report/enforce + ambient context
  const providerName = request.provider || DEFAULT_TEXT_PROVIDER;
  if (!report.allow) throw policyDeny(request, providerName, report); // enforce deny — before provider lookup
  const provider = registry.getProvider(providerName);
  const t0 = performance.now();
  let streamObj;
  try {
    streamObj = await provider.stream(request); // EXACT provider stream object
  } catch (err) {
    // Provider failed before returning a stream → one error audit, rethrow.
    auditAiError(request, providerName, err, performance.now() - t0, report);
    throw err;
  }
  try {
    // Audit AFTER the stream completes, when usage is available. finalMessage()
    // is memoised on the SDK's MessageStream, so calling it here is safe and does
    // not interfere with the caller's own consumption. The stream object is
    // returned unchanged. finalMessage resolves off the request's ALS context, so
    // re-enter the captured context to keep requestId/actor/tenantId on the event.
    if (streamObj && typeof streamObj.finalMessage === 'function') {
      const ctx = requestContext.get();
      const inCtx = (fn) => (ctx ? requestContext.run(ctx, fn) : fn());
      Promise.resolve(streamObj.finalMessage())
        .then((finalMsg) => inCtx(() => auditAiCall(request, providerName, extractUsage(finalMsg), performance.now() - t0, report)))
        .catch((err) => inCtx(() => auditAiError(request, providerName, err, performance.now() - t0, report)));
    }
  } catch { /* auditing must never affect the returned stream */ }
  return streamObj;
}

async function generateImage(request = {}) {
  validate(request);
  runPolicy(request);
  const report = policy.evaluate(request, requestContext.get()); // WP-11 P1/P2/P6 — report/enforce + ambient context
  const providerName = request.provider || DEFAULT_IMAGE_PROVIDER;
  if (!report.allow) throw policyDeny(request, providerName, report); // enforce deny — before provider lookup
  const provider = registry.getProvider(providerName);
  const t0 = performance.now();
  let result;
  try {
    result = await provider.generateImage(request); // EXACT provider result
  } catch (err) {
    auditAiError(request, providerName, err, performance.now() - t0, report);
    throw err; // rethrow the ORIGINAL error object, unchanged
  }
  auditAiCall(request, providerName, extractUsage(result), performance.now() - t0, report); // image usage typically absent → 0
  return result;
}

// Forward client reset to the text provider (mirrors lib/ai.resetClient today).
function resetClient() {
  const provider = registry.getProvider(DEFAULT_TEXT_PROVIDER);
  if (typeof provider.resetClient === 'function') return provider.resetClient();
}

module.exports = { complete, stream, generateImage, resetClient };

// ── test-only seams (not part of the public API; underscore-prefixed, mirroring
// the codebase convention) — let suites prove the policy stage executes/allows. ──
module.exports.__defaultPolicy = defaultPolicy;
module.exports.__setPolicy = (fn) => { _policy = typeof fn === 'function' ? fn : defaultPolicy; };
module.exports.__resetPolicy = () => { _policy = defaultPolicy; };
