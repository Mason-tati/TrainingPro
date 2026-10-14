// WP-10 · A1 — Enterprise AI Gateway foundation tests.
// Deterministic, offline, no API key, no SDK instantiation, no logging.
// Providers are stubbed via the registry seam so the gateway's orchestration
// and passthrough guarantees are proven without touching Anthropic/OpenAI.
require('../helpers/network-guard');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const GATEWAY = path.join(ROOT, 'lib', 'ai-gateway.js');
const REGISTRY = path.join(ROOT, 'lib', 'ai', 'providers', 'registry.js');
const SDK_PATH = require.resolve('@anthropic-ai/sdk');

// No API key anywhere in this process.
delete process.env.ANTHROPIC_API_KEY;

const gateway = require(GATEWAY);
const registry = require(REGISTRY);

// WP-11 P3 — clear every policy env control between tests (default = report, no limits).
const POLICY_ENV = [
  'AI_POLICY_MODE', 'AI_POLICY_MAX_ESTIMATED_TOKENS', 'AI_POLICY_ENFORCE_TOKEN_LIMIT',
  'AI_POLICY_ENFORCE_APPROVAL', 'AI_POLICY_ENFORCE_TENANT',
  'AI_POLICY_ENFORCE_CLASSIFICATION', 'AI_POLICY_ENFORCE_COST',
  'AI_POLICY_MAX_COST_USD', 'AI_POLICY_PROFILE',
];
const clearPolicyEnv = () => { for (const k of POLICY_ENV) delete process.env[k]; };
beforeEach(() => { registry.__reset(); gateway.__resetPolicy(); clearPolicyEnv(); }); // default = report
afterEach(() => { registry.__reset(); gateway.__resetPolicy(); clearPolicyEnv(); });

// 1. complete() forwards arguments exactly (same reference, unmodified).
test('1. complete() forwards the request to the provider unchanged', async () => {
  let received;
  registry.__setProvider('anthropic', { complete: async (req) => { received = req; return { ok: 1 }; } });
  const request = { provider: 'anthropic', agent: 'AI-DOC-001', operation: 'gen', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 };
  await gateway.complete(request);
  assert.equal(received, request, 'provider received the exact same request object');
});

// 2. complete() returns the provider result unchanged.
test('2. complete() returns the provider result unchanged', async () => {
  const result = { id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5 } };
  registry.__setProvider('anthropic', { complete: async () => result });
  assert.equal(await gateway.complete({ provider: 'anthropic' }), result, 'exact result reference');
});

// 3. stream() returns the identical stream object.
test('3. stream() returns the identical provider stream object', async () => {
  const fakeStream = { __marker: 'stream', on() {}, finalMessage: async () => ({}) };
  let received;
  registry.__setProvider('anthropic', { stream: async (req) => { received = req; return fakeStream; } });
  const req = { provider: 'anthropic', stream: true };
  const out = await gateway.stream(req);
  assert.equal(out, fakeStream, 'exact stream object');
  assert.equal(received, req, 'request forwarded unchanged');
});

// 4. generateImage() returns the identical result.
test('4. generateImage() returns the provider result unchanged', async () => {
  const img = { b64: 'AAAA', format: 'png' };
  let received;
  registry.__setProvider('openai', { generateImage: async (req) => { received = req; return img; } });
  const req = { provider: 'openai', prompt: 'a cover' };
  assert.equal(await gateway.generateImage(req), img);
  assert.equal(received, req);
});

// 5. Errors propagate unchanged (same error object + properties).
test('5. provider errors propagate unchanged', async () => {
  const boom = Object.assign(new Error('provider failed'), { status: 429, userError: true });
  registry.__setProvider('anthropic', { complete: async () => { throw boom; } });
  await assert.rejects(() => gateway.complete({ provider: 'anthropic' }), (e) => {
    assert.equal(e, boom, 'same error object');
    assert.equal(e.status, 429);
    assert.equal(e.userError, true);
    return true;
  });
});

// 6. resetClient() forwards to the provider.
test('6. resetClient() forwards to the provider', () => {
  let called = 0;
  registry.__setProvider('anthropic', { resetClient: () => { called++; } });
  gateway.resetClient();
  assert.equal(called, 1);
});

// 7/8. Registry resolves the real anthropic and openai adapters.
test('7/8. registry resolves anthropic and openai adapters', () => {
  const a = registry.getProvider('anthropic');
  assert.equal(a.name, 'anthropic');
  assert.equal(typeof a.complete, 'function');
  assert.equal(typeof a.stream, 'function');
  const o = registry.getProvider('openai');
  assert.equal(o.name, 'openai');
  assert.equal(typeof o.generateImage, 'function');
});

// 9. Unknown provider throws a deterministic error; reserved providers too.
test('9. unknown/reserved providers throw deterministic errors', () => {
  assert.throws(() => registry.getProvider('nope'), /unknown provider "nope"/);
  assert.throws(() => registry.getProvider('gemini'), /"gemini" is registered but not implemented/);
});

// 10. Policy executes (the gateway invokes it on the request).
test('10. policy executes on every request', async () => {
  let seen = null;
  gateway.__setPolicy((req) => { seen = req; return { allow: true }; });
  registry.__setProvider('anthropic', { complete: async () => ({}) });
  const req = { provider: 'anthropic', agent: 'AI-DOC-001' };
  await gateway.complete(req);
  assert.equal(seen, req, 'policy received the request');
  // wiring proof: a denying policy blocks the call (default never denies)
  gateway.__setPolicy(() => ({ allow: false, reason: 'test' }));
  await assert.rejects(() => gateway.complete({ provider: 'anthropic' }), /denied by policy/);
});

// 11. The default policy currently ALLOWS with no enforcement.
test('11. default policy allows', () => {
  assert.deepEqual(gateway.__defaultPolicy({ anything: true }), { allow: true });
});

// 12. Gateway logging is metadata-only (A3): a complete() emits exactly one
// AI_CALL and nothing else — no prompts/messages leak.
test('12. gateway emits only a metadata AI_CALL (no content)', async () => {
  const logger = require(path.join(ROOT, 'lib', 'logger.js'));
  const captured = [];
  const restore = logger.__setSink((rec) => captured.push(rec));
  logger.__setLevel('debug');
  registry.__setProvider('anthropic', { complete: async () => ({ ok: 1 }) });
  await gateway.complete({ provider: 'anthropic', messages: [{ role: 'user', content: 'SENTINEL-PROMPT' }] });
  logger.__setSink(restore);
  logger.__setLevel('silent');
  assert.equal(captured.length, 1, 'exactly one record');
  assert.equal(captured[0].event, 'AI_CALL');
  assert.ok(!JSON.stringify(captured[0]).includes('SENTINEL-PROMPT'), 'no prompt content in the record');
});

// 13. No network (guard active for this process).
test('13. outbound network guard is active', () => {
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true);
});

// 14. No AI SDK is instantiated by loading/using the gateway (providers stubbed).
test('14. no Anthropic SDK client is instantiated', async () => {
  let news = 0;
  const realSdk = require.cache[SDK_PATH];
  class FakeAnthropic { constructor() { news++; } }
  require.cache[SDK_PATH] = { id: SDK_PATH, filename: SDK_PATH, loaded: true, exports: FakeAnthropic };
  registry.__reset();
  registry.__setProvider('anthropic', { complete: async () => ({}) });
  await gateway.complete({ provider: 'anthropic' });
  registry.getProvider('anthropic'); // resolve override, not the real adapter
  if (realSdk) require.cache[SDK_PATH] = realSdk; else delete require.cache[SDK_PATH];
  assert.equal(news, 0, 'no new Anthropic() during gateway use');
});

// 15. Gateway loads and exposes exactly its public API without an API key.
test('15. gateway loads without an API key and exposes the public API', () => {
  delete process.env.ANTHROPIC_API_KEY;
  const fresh = require(GATEWAY);
  for (const fn of ['complete', 'stream', 'generateImage', 'resetClient']) {
    assert.equal(typeof fresh[fn], 'function', `${fn} exported`);
  }
});

// ── WP-10 · A2 — passthrough hardening ─────────────────────────────────────
const AI_PATH = require.resolve(path.join(ROOT, 'lib', 'ai.js'));
const ANTHROPIC_PATH = require.resolve(path.join(ROOT, 'lib', 'ai', 'providers', 'anthropic.js'));

const RICH_COMPLETE = () => ({
  provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate',
  model: 'claude-sonnet-4-6', max_tokens: 4000, temperature: 0.4,
  system: 'you are a helper',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] }],
  tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
  tool_choice: { type: 'auto' },
  metadata: { user_id: 'u1' },
  thinking: { type: 'enabled', budget_tokens: 2000 },
  extra_future_option: { nested: { deep: [1, 2, 3] } },
});

// A2-1/4/5/8. Deep passthrough of complete options + nested identity to the adapter.
test('A2-1/4/5/8. complete() forwards every SDK option (nested identity)', async () => {
  const req = RICH_COMPLETE();
  let received;
  registry.__setProvider('anthropic', { complete: async (r) => { received = r; return { ok: 1 }; } });
  await gateway.complete(req);
  assert.equal(received, req, 'adapter received the exact request object');
  assert.equal(received.tools, req.tools, 'tools kept by identity');
  assert.equal(received.messages[0].content, req.messages[0].content, 'nested content kept by identity');
  assert.equal(received.thinking, req.thinking);
  assert.deepEqual(received.extra_future_option, req.extra_future_option, 'unknown option preserved');
});

// A2-2. Deep passthrough of stream options + identical stream object.
test('A2-2. stream() forwards every SDK option and returns the exact stream', async () => {
  const req = { ...RICH_COMPLETE(), stream: true };
  const fakeStream = { __marker: 'S', on() {}, finalMessage: async () => ({}) };
  let received;
  registry.__setProvider('anthropic', { stream: async (r) => { received = r; return fakeStream; } });
  const out = await gateway.stream(req);
  assert.equal(out, fakeStream);
  assert.equal(received, req);
  assert.equal(received.tools, req.tools);
});

// A2-3. Deep passthrough of OpenAI image options.
test('A2-3. generateImage() forwards every image option', async () => {
  const req = {
    provider: 'openai', agent: 'AI-DOC-cover', operation: 'cover-image',
    model: 'gpt-image-1', prompt: 'a safety poster', size: '1536x1024',
    quality: 'medium', background: 'opaque', n: 1, response_format: 'b64_json',
    extra_provider_option: true,
  };
  let received;
  registry.__setProvider('openai', { generateImage: async (r) => { received = r; return { b64: 'AAAA' }; } });
  await gateway.generateImage(req);
  assert.equal(received, req, 'adapter received the exact request');
  for (const k of ['model', 'prompt', 'size', 'quality', 'background', 'n', 'response_format', 'extra_provider_option']) {
    assert.deepEqual(received[k], req[k], `${k} forwarded`);
  }
});

// A2-6/7. Request is not mutated; policy receives the same object.
test('A2-6/7. request is not mutated and policy sees the same object', async () => {
  const req = RICH_COMPLETE();
  const snapshot = JSON.parse(JSON.stringify(req));
  let policySaw;
  gateway.__setPolicy((r) => { policySaw = r; return { allow: true }; });
  registry.__setProvider('anthropic', { complete: async () => ({}) });
  await gateway.complete(req);
  assert.equal(policySaw, req, 'policy received the same request object');
  assert.deepEqual(req, snapshot, 'request object not mutated by the gateway');
});

// A2 adapter mapping: the anthropic adapter forwards all SDK options and strips
// ONLY the gateway-control keys — proven against a stubbed lib/ai client (no net).
test('A2 adapter: anthropic strips control keys, forwards SDK options', async () => {
  const sink = {};
  const savedAi = require.cache[AI_PATH];
  require.cache[AI_PATH] = {
    id: AI_PATH, filename: AI_PATH, loaded: true,
    exports: {
      // The adapter streams under the hood: complete() calls messages.stream(args).finalMessage(),
      // and stream() returns messages.stream(args). Record the forwarded args for assertions.
      getClient: async () => ({ messages: {
        stream: (a) => { sink.streamArgs = a; return { finalMessage: async () => ({ result: 'C' }) }; },
      } }),
      resetClient: () => { sink.reset = (sink.reset || 0) + 1; },
    },
  };
  delete require.cache[ANTHROPIC_PATH];
  try {
    const anthropic = require(ANTHROPIC_PATH);
    const req = RICH_COMPLETE();
    const res = await anthropic.complete(req);
    assert.deepEqual(res, { result: 'C' }, 'adapter returns assembled finalMessage unchanged');
    for (const k of ['model', 'max_tokens', 'system', 'messages', 'temperature', 'tools', 'tool_choice', 'metadata', 'thinking', 'extra_future_option']) {
      assert.ok(k in sink.streamArgs, `SDK received ${k}`);
    }
    for (const k of ['provider', 'agent', 'operation', 'stream']) {
      assert.ok(!(k in sink.streamArgs), `control key ${k} stripped`);
    }
    assert.equal(sink.streamArgs.tools, req.tools, 'nested tools kept by reference');

    await anthropic.stream({ ...req, stream: true });
    assert.ok('messages' in sink.streamArgs && !('stream' in sink.streamArgs), 'stream() maps args + strips control');

    anthropic.resetClient();
    assert.equal(sink.reset, 1, 'resetClient forwards exactly once');
  } finally {
    if (savedAi) require.cache[AI_PATH] = savedAi; else delete require.cache[AI_PATH];
    delete require.cache[ANTHROPIC_PATH]; // force the real adapter to reload for later tests
  }
});

// A2-9. Error identity preserved through the gateway (re-proven for A2).
test('A2-9. error object identity preserved', async () => {
  const boom = Object.assign(new Error('down'), { status: 503, cause: { code: 'ECONN' } });
  registry.__setProvider('anthropic', { complete: async () => { throw boom; } });
  await assert.rejects(() => gateway.complete({ provider: 'anthropic' }), (e) => e === boom && e.status === 503);
});

// A2-10. reset forwards exactly once (gateway level).
test('A2-10. gateway.resetClient forwards exactly once', () => {
  let n = 0;
  registry.__setProvider('anthropic', { resetClient: () => { n++; } });
  gateway.resetClient();
  assert.equal(n, 1);
});

// A2-11/12. Unknown + reserved provider errors remain deterministic.
test('A2-11/12. unknown and reserved provider errors are deterministic', () => {
  assert.throws(() => registry.getProvider('does-not-exist'), /unknown provider "does-not-exist"/);
  for (const reserved of ['gemini', 'ollama', 'azure-openai', 'bedrock', 'vertex']) {
    assert.throws(() => registry.getProvider(reserved), new RegExp(`"${reserved}" is registered but not implemented`));
  }
});

// A2-13/14/15. No SDK instantiation, no logging, network guard active.
test('A2-13/14/15. no SDK instantiation, no logging, guard active', async () => {
  const logger = require(path.join(ROOT, 'lib', 'logger.js'));
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('debug');
  let news = 0;
  const savedSdk = require.cache[SDK_PATH];
  require.cache[SDK_PATH] = { id: SDK_PATH, filename: SDK_PATH, loaded: true, exports: class { constructor() { news++; } } };
  registry.__setProvider('anthropic', { complete: async () => ({ ok: 1 }), stream: async () => ({ __marker: 'S' }) });
  await gateway.complete(RICH_COMPLETE());
  await gateway.stream({ provider: 'anthropic', stream: true });
  if (savedSdk) require.cache[SDK_PATH] = savedSdk; else delete require.cache[SDK_PATH];
  logger.__setSink(restore); logger.__setLevel('silent');
  assert.equal(news, 0, 'no SDK instantiated');
  // A3: the complete() call emits one metadata AI_CALL (the stub stream has no
  // finalMessage, so no stream event). Records are metadata-only.
  assert.ok(captured.every((r) => r.event === 'AI_CALL'), 'only AI_CALL events');
  assert.ok(!JSON.stringify(captured).includes('extra_future_option'), 'no request content in records');
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true, 'network guard active');
});

// ── WP-10 · A3 — AI metadata logging (logger.aiEvent → AI_CALL) ─────────────
const logger = require(path.join(ROOT, 'lib', 'logger.js'));
const rc = require(path.join(ROOT, 'lib', 'request-context.js'));
let aiLogs;
function captureAiLogs() { aiLogs = []; return logger.__setSink((r) => aiLogs.push(r)); }
const settle = () => new Promise((r) => setTimeout(r, 15));

test('A3-1/2. complete success emits one schema-valid AI_CALL with usage tokens', async () => {
  const restore = captureAiLogs(); logger.__setLevel('debug');
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 120, output_tokens: 45 } }) });
  await gateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate', model: 'claude-sonnet-4-6' });
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1, 'exactly one AI_CALL');
  const rec = calls[0];
  const { validateLogRecord } = require(path.join(ROOT, 'lib', 'log-schema.js'));
  assert.equal(validateLogRecord(rec).valid, true, 'schema-valid');
  assert.equal(rec.module, 'AI');
  assert.equal(rec.metadata.provider, 'anthropic');
  assert.equal(rec.metadata.model, 'claude-sonnet-4-6');
  assert.equal(rec.metadata.agent, 'AI-DOC-001');
  assert.equal(rec.metadata.operation, 'generate');
  assert.equal(rec.metadata.inputTokens, 120);
  assert.equal(rec.metadata.outputTokens, 45);
  assert.equal(rec.metadata.totalTokens, 165);
  assert.equal(rec.metadata.costUsd, null);
  assert.equal(rec.metadata.status, 'ok');
  assert.equal(rec.metadata.decisionStatus, 'draft');
});

test('A3-3/7. missing usage defaults tokens to 0; durationMs finite >= 0', async () => {
  const restore = captureAiLogs(); logger.__setLevel('debug');
  registry.__setProvider('anthropic', { complete: async () => ({ content: [] }) }); // no usage
  await gateway.complete({ provider: 'anthropic' });
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs.find((r) => r.event === 'AI_CALL');
  assert.equal(rec.metadata.inputTokens, 0);
  assert.equal(rec.metadata.outputTokens, 0);
  assert.equal(rec.metadata.totalTokens, 0);
  assert.ok(Number.isFinite(rec.metadata.durationMs) && rec.metadata.durationMs >= 0, 'durationMs finite >= 0');
});

test('A3-4/5. stream finalMessage emits one AI_CALL; stream object unchanged', async () => {
  const restore = captureAiLogs(); logger.__setLevel('debug');
  const fakeStream = { __marker: 'S', on() {}, finalMessage: async () => ({ usage: { input_tokens: 10, output_tokens: 90 } }) };
  registry.__setProvider('anthropic', { stream: async () => fakeStream });
  const out = await gateway.stream({ provider: 'anthropic', agent: 'AI-DOC-003', operation: 'develop', model: 'claude-sonnet-4-6', stream: true });
  assert.equal(out, fakeStream, 'exact stream object returned');
  await settle(); // let finalMessage-driven audit fire
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1, 'exactly one AI_CALL after finalMessage');
  assert.equal(calls[0].metadata.totalTokens, 100);
  assert.equal(calls[0].metadata.operation, 'develop');
});

test('A3-6. generateImage emits one AI_CALL (openai, zero tokens)', async () => {
  const restore = captureAiLogs(); logger.__setLevel('debug');
  registry.__setProvider('openai', { generateImage: async () => ({ b64: 'AAAA' }) });
  await gateway.generateImage({ provider: 'openai', agent: 'AI-DOC-cover', operation: 'cover-image', model: 'gpt-image-1', prompt: 'SENTINEL-IMAGE-PROMPT' });
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.provider, 'openai');
  assert.equal(calls[0].metadata.totalTokens, 0);
});

test('A3-8. request context (requestId/actor/tenantId) attaches automatically', async () => {
  const restore = captureAiLogs(); logger.__setLevel('debug');
  registry.__setProvider('anthropic', { complete: async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }) });
  await rc.run({ requestId: 'req-ai-1', actor: 'admin', tenantId: 't-9', module: 'System' }, async () => {
    await gateway.complete({ provider: 'anthropic' });
  });
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs.find((r) => r.event === 'AI_CALL');
  assert.equal(rec.requestId, 'req-ai-1');
  assert.equal(rec.actor, 'admin');
  assert.equal(rec.tenantId, 't-9');
  assert.equal(rec.module, 'AI', 'aiEvent forces module=AI while keeping correlation');
});

test('A3-9/10/11. no prompt/system/messages/response/image-prompt in any AI_CALL', async () => {
  const restore = captureAiLogs(); logger.__setLevel('debug');
  registry.__setProvider('anthropic', { complete: async () => ({ content: [{ type: 'text', text: 'RAW-RESPONSE-SENTINEL' }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  registry.__setProvider('openai', { generateImage: async () => ({ b64: 'IMG' }) });
  await gateway.complete({ provider: 'anthropic', system: 'SYS-SENTINEL', messages: [{ role: 'user', content: 'MSG-SENTINEL' }] });
  await gateway.generateImage({ provider: 'openai', prompt: 'IMG-PROMPT-SENTINEL' });
  logger.__setSink(restore); logger.__setLevel('silent');
  const s = JSON.stringify(aiLogs);
  for (const sentinel of ['SYS-SENTINEL', 'MSG-SENTINEL', 'RAW-RESPONSE-SENTINEL', 'IMG-PROMPT-SENTINEL']) {
    assert.ok(!s.includes(sentinel), `${sentinel} absent from logs`);
  }
});

test('A3-12/13. logger failure does not affect result; no duplicate AI_CALL', async () => {
  const result = { usage: { input_tokens: 2, output_tokens: 2 }, id: 'msg_x' };
  registry.__setProvider('anthropic', { complete: async () => result });
  const restore = logger.__setSink(() => { throw new Error('sink boom'); });
  logger.__setLevel('debug');
  const out = await gateway.complete({ provider: 'anthropic' });
  assert.equal(out, result, 'provider result returned unchanged despite logger failure');
  // no-duplicate: one call → count via a working sink
  const captured = [];
  logger.__setSink((r) => captured.push(r));
  await gateway.complete({ provider: 'anthropic' });
  logger.__setSink(restore); logger.__setLevel('silent');
  assert.equal(captured.filter((r) => r.event === 'AI_CALL').length, 1, 'exactly one AI_CALL per call');
});

// ── WP-10 · A4 — AI failure handling & error normalization ─────────────────
const { validateLogRecord } = require(path.join(ROOT, 'lib', 'log-schema.js'));

function assertErrorRecord(rec, req) {
  assert.equal(validateLogRecord(rec).valid, true, 'schema-valid');
  assert.equal(rec.event, 'AI_CALL');
  assert.equal(rec.module, 'AI');
  assert.equal(rec.metadata.status, 'error');
  assert.equal(rec.metadata.decisionStatus, 'draft');
  assert.equal(rec.metadata.inputTokens, 0);
  assert.equal(rec.metadata.outputTokens, 0);
  assert.equal(rec.metadata.totalTokens, 0);
  assert.equal(rec.metadata.costUsd, null);
  assert.ok(Number.isFinite(rec.metadata.durationMs) && rec.metadata.durationMs >= 0);
  assert.equal(typeof rec.metadata.errorName, 'string');
  assert.equal(typeof rec.metadata.errorMessage, 'string');
  assert.ok(!('stack' in rec.metadata), 'no stack in metadata');
}

// A4-1/5/6/7. complete failure: one error AI_CALL; original error identity + props preserved.
test('A4-1/5/6/7. complete failure emits one error AI_CALL and rethrows unchanged', async () => {
  const boom = Object.assign(new Error('rate limited'), { status: 429, userError: true, cause: { code: 'ETIMEDOUT' } });
  registry.__setProvider('anthropic', { complete: async () => { throw boom; } });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await assert.rejects(() => gateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'gen', model: 'claude-sonnet-4-6' }), (e) => {
    assert.equal(e, boom, 'same error object');
    assert.equal(e.status, 429);
    assert.equal(e.userError, true);
    assert.deepEqual(e.cause, { code: 'ETIMEDOUT' });
    return true;
  });
  logger.__setSink(restore); logger.__setLevel('silent');
  const errs = aiLogs.filter((r) => r.event === 'AI_CALL' && r.metadata.status === 'error');
  assert.equal(errs.length, 1, 'exactly one error AI_CALL');
  assertErrorRecord(errs[0]);
  assert.equal(errs[0].metadata.errorName, 'Error');
  assert.equal(errs[0].metadata.provider, 'anthropic');
});

// A4-2. stream provider failure (before returning a stream).
test('A4-2. stream provider failure emits one error AI_CALL and rethrows', async () => {
  const boom = Object.assign(new Error('stream init failed'), { status: 500 });
  registry.__setProvider('anthropic', { stream: async () => { throw boom; } });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await assert.rejects(() => gateway.stream({ provider: 'anthropic', operation: 'develop' }), (e) => e === boom && e.status === 500);
  logger.__setSink(restore); logger.__setLevel('silent');
  const errs = aiLogs.filter((r) => r.metadata && r.metadata.status === 'error');
  assert.equal(errs.length, 1);
  assertErrorRecord(errs[0]);
});

// A4-3. stream finalMessage rejection.
test('A4-3. stream finalMessage rejection emits one error AI_CALL', async () => {
  const boom = new Error('mid-stream failure');
  const fakeStream = { on() {}, finalMessage: async () => { throw boom; } };
  registry.__setProvider('anthropic', { stream: async () => fakeStream });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  const out = await gateway.stream({ provider: 'anthropic', operation: 'develop' });
  assert.equal(out, fakeStream, 'stream object returned unchanged even though it will fail');
  await settle();
  logger.__setSink(restore); logger.__setLevel('silent');
  const errs = aiLogs.filter((r) => r.metadata && r.metadata.status === 'error');
  assert.equal(errs.length, 1, 'one error event from finalMessage rejection');
  assertErrorRecord(errs[0]);
});

// A4-4. generateImage failure.
test('A4-4. generateImage failure emits one error AI_CALL and rethrows', async () => {
  const boom = Object.assign(new Error('image gen failed'), { userError: true });
  registry.__setProvider('openai', { generateImage: async () => { throw boom; } });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await assert.rejects(() => gateway.generateImage({ provider: 'openai', operation: 'cover' }), (e) => e === boom && e.userError === true);
  logger.__setSink(restore); logger.__setLevel('silent');
  const errs = aiLogs.filter((r) => r.metadata && r.metadata.status === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].metadata.provider, 'openai');
});

// A4-8/9/10. errorMessage redacted; no stack/prompt/system/messages/image prompt.
test('A4-8/9/10. error records are redacted and content-free', async () => {
  const boom = new Error('auth failed for sk-abcdEFGH12345 (a.person@example.com) query SELECT * FROM tblPswd');
  registry.__setProvider('anthropic', { complete: async () => { throw boom; } });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await assert.rejects(() => gateway.complete({ provider: 'anthropic', system: 'SYS-SENTINEL', messages: [{ role: 'user', content: 'MSG-SENTINEL' }] }));
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs.find((r) => r.metadata && r.metadata.status === 'error');
  const msg = rec.metadata.errorMessage;
  assert.ok(!msg.includes('sk-abcdEFGH12345'), 'API key masked');
  assert.ok(!msg.includes('a.person@example.com') && msg.includes('a***@example.com'), 'email masked');
  const s = JSON.stringify(rec);
  assert.ok(!s.includes('SYS-SENTINEL') && !s.includes('MSG-SENTINEL'), 'no prompt/system content');
  assert.ok(!s.includes('at Object.') && !('stack' in rec.metadata), 'no stack');
});

// A4-11/12. Logger failure does not change the thrown error; no duplicate error events.
test('A4-11/12. logger failure preserves thrown error; single error event', async () => {
  const boom = Object.assign(new Error('boom'), { status: 418 });
  registry.__setProvider('anthropic', { complete: async () => { throw boom; } });
  // throwing sink → error still rethrown unchanged
  const restore = logger.__setSink(() => { throw new Error('sink boom'); });
  logger.__setLevel('debug');
  await assert.rejects(() => gateway.complete({ provider: 'anthropic' }), (e) => e === boom && e.status === 418);
  // count with a working sink: exactly one error event per failed call
  const captured = [];
  logger.__setSink((r) => captured.push(r));
  await assert.rejects(() => gateway.complete({ provider: 'anthropic' }), (e) => e === boom);
  logger.__setSink(restore); logger.__setLevel('silent');
  assert.equal(captured.filter((r) => r.metadata && r.metadata.status === 'error').length, 1, 'one error AI_CALL per failure');
});

// ── WP-10 · A5 — adversarial redaction & prompt-safety ─────────────────────
// Sentinels: unique, greppable tokens for every category that must never leak.
// (Note: the error-message sentinels are the ones we EXPECT to appear only in a
//  masked form in errorMessage; all others must be entirely absent.)
const S = {
  apiKey: 'sk-A5SENTINELapikey0123456789',
  bearer: 'Bearer A5SENTINELbearertoken',
  jwt: 'eyJA5SENThdr.eyJA5SENTpayload.A5SENTsig',
  email: 'a5.sentinel.person@example.com',
  phone: '0455123987',
  medical: 'A5-MEDICAL: asthma, fit for work with lifting restriction',
  disciplinary: 'A5-DISCIPLINARY: final written warning for absenteeism',
  documentText: 'A5-DOCUMENT-BODY confidential procedure section 4.2',
  prompt: 'A5-PROMPT translate this document',
  completion: 'A5-COMPLETION model generated answer text',
  rawResponse: 'A5-RAW-RESPONSE provider payload body',
  sql: "SELECT HashPass FROM tblPswd WHERE UserName='admin'",
  sqlParam: 'A5-SQL-PARAM-value',
};
// All the "must NEVER appear anywhere" sentinels (content, not error messages).
const CONTENT_SENTINELS = [S.medical, S.disciplinary, S.documentText, S.prompt, S.completion, S.rawResponse, S.sqlParam];

// A rich request whose every content field is stuffed with sentinels.
function sentinelRequest(extra = {}) {
  return {
    provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate', model: 'claude-sonnet-4-6',
    system: `${S.documentText} ${S.medical} ${S.apiKey}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${S.prompt} ${S.disciplinary} ${S.email} ${S.phone}` }] }],
    tools: [{ name: 'lookup', description: S.sql }],
    metadata: { note: S.sqlParam },
    ...extra,
  };
}
// A provider response stuffed with sentinels (must never be logged).
const sentinelResponse = () => ({
  content: [{ type: 'text', text: `${S.completion} ${S.rawResponse} ${S.email}` }],
  usage: { input_tokens: 7, output_tokens: 3 },
});
function assertNoContent(records) {
  const s = JSON.stringify(records);
  for (const sentinel of CONTENT_SENTINELS) {
    assert.ok(!s.includes(sentinel), `content sentinel leaked: ${sentinel.slice(0, 24)}…`);
  }
  // hard secrets/PII must not appear in raw form anywhere
  assert.ok(!s.includes(S.apiKey), 'API key leaked');
  assert.ok(!s.includes(S.bearer.split(' ')[1]), 'bearer token leaked');
  assert.ok(!s.includes(S.jwt), 'JWT leaked');
  assert.ok(!s.includes(S.email), 'raw email leaked');
  assert.ok(!s.includes(S.sql), 'SQL statement leaked');
  // every record is schema-valid AI_CALL
  for (const r of records) {
    assert.equal(r.event, 'AI_CALL');
    assert.equal(validateLogRecord(r).valid, true);
    assert.ok(!('stack' in r.metadata), 'no stack');
  }
}

test('A5-1/8. complete() success leaks no sentinels; records valid', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  registry.__setProvider('anthropic', { complete: async () => sentinelResponse() });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await gateway.complete(sentinelRequest());
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assertNoContent(calls);
});

test('A5-2. complete() failure leaks nothing but a masked errorMessage', async () => {
  // A realistic provider error mentions a key + email (both redactor-maskable);
  // the SQL/content sentinels live in the REQUEST and are proven never logged.
  const boom = new Error(`provider failure key=${S.apiKey} user=${S.email}`);
  registry.__setProvider('anthropic', { complete: async () => { throw boom; } });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await assert.rejects(() => gateway.complete(sentinelRequest()));
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assertNoContent(calls); // content/secrets absent (errorMessage is masked)
  const msg = calls[0].metadata.errorMessage;
  assert.ok(msg.includes('[REDACTED]'), 'api key masked in errorMessage');
  assert.ok(msg.includes('a5.sentinel***@example.com') || !msg.includes(S.email), 'email masked in errorMessage');
});

test('A5-3. stream() success leaks no sentinels', async () => {
  const fakeStream = { on() {}, finalMessage: async () => sentinelResponse() };
  registry.__setProvider('anthropic', { stream: async () => fakeStream });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  const out = await gateway.stream(sentinelRequest({ stream: true }));
  assert.equal(out, fakeStream);
  await settle();
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assertNoContent(calls);
});

test('A5-4. stream finalMessage rejection leaks nothing but masked errorMessage', async () => {
  const boom = new Error(`stream failed for key ${S.apiKey}`);
  const fakeStream = { on() {}, finalMessage: async () => { throw boom; } };
  registry.__setProvider('anthropic', { stream: async () => fakeStream });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await gateway.stream(sentinelRequest({ stream: true }));
  await settle();
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.status, 'error');
  assertNoContent(calls);
  assert.ok(calls[0].metadata.errorMessage.includes('[REDACTED]'), 'key masked in errorMessage');
});

test('A5-5. generateImage() success leaks no image-prompt sentinel', async () => {
  registry.__setProvider('openai', { generateImage: async () => ({ b64: 'AAAA' }) });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await gateway.generateImage({ provider: 'openai', agent: 'AI-DOC-cover', operation: 'cover', model: 'gpt-image-1', prompt: S.documentText, size: '1536x1024' });
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes(S.documentText), 'image prompt absent');
  assert.equal(validateLogRecord(calls[0]).valid, true);
});

test('A5-6. generateImage() failure leaks no image-prompt sentinel', async () => {
  registry.__setProvider('openai', { generateImage: async () => { throw new Error('image failed'); } });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await assert.rejects(() => gateway.generateImage({ provider: 'openai', operation: 'cover', prompt: S.documentText }));
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = aiLogs.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.status, 'error');
  assert.ok(!JSON.stringify(calls).includes(S.documentText), 'image prompt absent even on failure');
});

test('A5-7. aiEvent allow-list discards forbidden fields even if passed directly', () => {
  const restore = captureAiLogs(); logger.__setLevel('debug');
  logger.aiEvent('AI_CALL', {
    provider: 'anthropic', model: 'm', // allowed
    prompt: S.prompt, completion: S.completion, messages: [S.documentText],
    system: S.medical, rawResponse: S.rawResponse, apiKey: S.apiKey, sql: S.sql,
  });
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs[0];
  for (const forbidden of ['prompt', 'completion', 'messages', 'system', 'rawResponse', 'apiKey', 'sql']) {
    assert.ok(!(forbidden in rec.metadata), `${forbidden} discarded by allow-list`);
  }
  assert.equal(rec.metadata.model, 'm', 'allowed field kept');
  assertNoContent([rec]);
});

test('A5-9/10/11. network guard active; no API key needed; A1–A4 intact', () => {
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true, 'network guard active');
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined, 'no API key required in this suite');
});

// ── WP-11 P2 — enforce-mode deny path ──────────────────────────────────────
const policyMod = require(path.join(ROOT, 'lib', 'ai', 'policy.js'));
const { validateLogRecord: validateRec } = require(path.join(ROOT, 'lib', 'log-schema.js'));
const validReq = () => ({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', system: 'sys', messages: [{ role: 'user', content: 'SENTINEL-PROMPT-P2' }] });

// P2-4/9. enforce deny happens BEFORE provider lookup; provider never called.
test('P2-4/9. enforce mode denies before provider lookup; provider not called', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  let providerCalled = false;
  registry.__setProvider('anthropic', { complete: async () => { providerCalled = true; return {}; } });
  await assert.rejects(() => gateway.complete({ ...validReq(), model: 'gpt-99' }), (e) => e.code === 'AI_POLICY_DENIED');
  // unknown provider: registry.getProvider must NOT be reached (would throw a different error)
  await assert.rejects(() => gateway.complete({ ...validReq(), provider: 'made-up' }), (e) => e.name === 'PolicyDeniedError');
  assert.equal(providerCalled, false, 'provider was never called on deny');
  delete process.env.AI_POLICY_MODE;
});

// P2-8. enforce mode valid request passes through to the provider.
test('P2-8. enforce mode valid request executes normally', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  registry.__setProvider('anthropic', { complete: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  const out = await gateway.complete(validReq());
  assert.ok(out.content, 'valid enforce request returns provider result');
  delete process.env.AI_POLICY_MODE;
});

// P2-11/12/13. PolicyDeniedError shape is safe; denied AI_CALL validates & is content-free.
test('P2-11/12/13. deny error shape + denied AI_CALL is safe and content-free', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  registry.__setProvider('anthropic', { complete: async () => ({}) });
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('info');
  let thrown;
  try { await gateway.complete({ ...validReq(), model: 'gpt-99' }); } catch (e) { thrown = e; }
  logger.__setSink(restore); logger.__setLevel('silent');
  // error shape
  assert.equal(thrown.name, 'PolicyDeniedError');
  assert.equal(thrown.code, 'AI_POLICY_DENIED');
  assert.equal(thrown.status, 403);
  assert.equal(thrown.userError, true);
  assert.ok(!/SENTINEL-PROMPT-P2/.test(thrown.message), 'no prompt in error message');
  // exactly one AI_CALL error event
  const calls = captured.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1, 'one AI_CALL on deny');
  const rec = calls[0];
  assert.equal(validateRec(rec).valid, true);
  assert.equal(rec.metadata.status, 'error');
  assert.equal(rec.metadata.policyMode, 'enforce');
  assert.equal(rec.metadata.policyVersion, 1);
  assert.equal(rec.metadata.errorName, 'PolicyDeniedError');
  assert.equal(typeof rec.metadata.estimatedTokens, 'number');
  assert.ok(!JSON.stringify(rec).includes('SENTINEL-PROMPT-P2'), 'no prompt/content in the denied event');
  delete process.env.AI_POLICY_MODE;
});

// P2-16. Provider failure (A4) still behaves unchanged in enforce mode with a valid request.
test('P2-16. provider failure behaviour unchanged (A4) under enforce mode', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  const boom = Object.assign(new Error('provider down'), { status: 502, userError: true });
  registry.__setProvider('anthropic', { complete: async () => { throw boom; } });
  await assert.rejects(() => gateway.complete(validReq()), (e) => e === boom && e.status === 502 && e.userError === true);
  delete process.env.AI_POLICY_MODE;
});

// ── WP-11 P3 — token-limit deny path through the gateway ────────────────────
// P3-13. enforce + token flag denies over max BEFORE provider lookup; not called.
test('P3-13. gateway denies a token-limit breach before calling the provider', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TOKEN_LIMIT = 'true';
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '5';
  let providerCalled = false;
  registry.__setProvider('anthropic', { complete: async () => { providerCalled = true; return {}; } });
  const big = { ...validReq(), messages: [{ role: 'user', content: 'x'.repeat(400) }] }; // ~100 tokens
  await assert.rejects(() => gateway.complete(big), (e) => e.name === 'PolicyDeniedError' && e.code === 'AI_POLICY_DENIED');
  assert.equal(providerCalled, false, 'provider never called on a token-limit deny');
  // under the limit the same request executes normally
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '100000';
  const out = await gateway.complete({ ...validReq(), messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(out, 'under-limit request passes through');
});

// P3-14. denied token-limit AI_CALL is schema-valid and content-free.
test('P3-14. token-limit deny emits one safe, schema-valid AI_CALL (no content)', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TOKEN_LIMIT = 'true';
  process.env.AI_POLICY_MAX_ESTIMATED_TOKENS = '5';
  registry.__setProvider('anthropic', { complete: async () => ({}) });
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('info');
  const big = { ...validReq(), messages: [{ role: 'user', content: 'SENTINEL-PROMPT-P3 ' + 'x'.repeat(400) }] };
  await assert.rejects(() => gateway.complete(big));
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = captured.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1, 'exactly one AI_CALL on token deny');
  const rec = calls[0];
  assert.equal(validateRec(rec).valid, true);
  assert.equal(rec.metadata.status, 'error');
  assert.equal(rec.metadata.policyMode, 'enforce');
  assert.equal(rec.metadata.errorName, 'PolicyDeniedError');
  assert.ok(!JSON.stringify(rec).includes('SENTINEL-PROMPT-P3'), 'no prompt content in the denied event');
});

// ── WP-11 P4 — cost ceiling deny path + costUsd metadata ───────────────────
// P4-10. cost-ceiling deny before provider lookup; one safe, content-free AI_CALL.
test('P4-10. cost-ceiling deny is safe, schema-valid and content-free; provider not called', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_COST = 'true';
  process.env.AI_POLICY_MAX_COST_USD = '0.0000001';
  let providerCalled = false;
  registry.__setProvider('anthropic', { complete: async () => { providerCalled = true; return {}; } });
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('info');
  const big = { ...validReq(), messages: [{ role: 'user', content: 'SENTINEL-PROMPT-P4 ' + 'x'.repeat(4000) }] };
  let thrown;
  try { await gateway.complete(big); } catch (e) { thrown = e; }
  logger.__setSink(restore); logger.__setLevel('silent');
  assert.equal(thrown.code, 'AI_POLICY_DENIED');
  assert.equal(providerCalled, false, 'provider never called on cost deny');
  const calls = captured.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1, 'exactly one AI_CALL on cost deny');
  const rec = calls[0];
  assert.equal(validateRec(rec).valid, true);
  assert.equal(rec.metadata.status, 'error');
  assert.equal(rec.metadata.errorName, 'PolicyDeniedError');
  assert.ok(!JSON.stringify(rec).includes('SENTINEL-PROMPT-P4'), 'no prompt content in the denied event');
});

// P4-11. AI_CALL costUsd is populated when pricing exists (success path).
test('P4-11. AI_CALL costUsd is populated for a priced request', async () => {
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 10, output_tokens: 5 } }) });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await gateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs.find((r) => r.event === 'AI_CALL');
  assert.equal(typeof rec.metadata.costUsd, 'number');
  assert.ok(rec.metadata.costUsd > 0, 'estimated cost populated from pricing registry');
});

// P4-12. AI_CALL costUsd stays null when pricing is missing (unknown model).
test('P4-12. AI_CALL costUsd is null when pricing is missing', async () => {
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 10, output_tokens: 5 } }) });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await gateway.complete({ provider: 'anthropic', model: 'gpt-99', messages: [{ role: 'user', content: 'x'.repeat(4000) }] }); // report mode → allowed
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs.find((r) => r.event === 'AI_CALL');
  assert.equal(rec.metadata.costUsd, null, 'no pricing → costUsd null');
});

// ── WP-11 P5 — profiles through the gateway ────────────────────────────────
// P5-10. AI_CALL metadata is unchanged by profiles (no new/leaked fields; keys stable).
test('P5-10. AI_CALL metadata unchanged under a profile (no `profile` key leaks in)', async () => {
  process.env.AI_POLICY_PROFILE = 'strict';
  // valid, fully-satisfying request so strict does not deny
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 10, output_tokens: 5 } }) });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await gateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', approvalStatus: 'approved', tenantId: 'akara', classification: 'internal', messages: [{ role: 'user', content: 'hi' }] });
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs.find((r) => r.event === 'AI_CALL');
  assert.equal(validateRec(rec).valid, true);
  const keys = Object.keys(rec.metadata).sort();
  assert.deepEqual(keys, [
    'agent', 'costUsd', 'decisionStatus', 'durationMs', 'estimatedTokens',
    'inputTokens', 'model', 'operation', 'outputTokens', 'policyMode',
    'policyVersion', 'provider', 'status', 'totalTokens',
  ], 'AI_CALL metadata keys unchanged (no `profile` field)');
  assert.equal(rec.metadata.policyMode, 'enforce', 'strict profile reflected in existing policyMode field');
});

// P5-11. strict profile denies at the gateway before the provider is called.
test('P5-11. strict profile deny happens before provider lookup; provider not called', async () => {
  process.env.AI_POLICY_PROFILE = 'strict';
  let providerCalled = false;
  registry.__setProvider('anthropic', { complete: async () => { providerCalled = true; return {}; } });
  // missing approval/tenant/classification under strict → deny
  await assert.rejects(
    () => gateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e.name === 'PolicyDeniedError' && e.code === 'AI_POLICY_DENIED',
  );
  assert.equal(providerCalled, false, 'provider never called on a strict-profile deny');
});

// ── WP-11 P6 — gateway passes ambient context into policy ───────────────────
// P6-15. Gateway supplies the request context to policy (tenant from context
// satisfies enforce-tenant) WITHOUT mutating the request object.
test('P6-15. gateway passes context to policy without mutating the request', async () => {
  process.env.AI_POLICY_MODE = 'enforce';
  process.env.AI_POLICY_ENFORCE_TENANT = 'true';
  let providerCalled = false;
  registry.__setProvider('anthropic', { complete: async () => { providerCalled = true; return { content: [], usage: { input_tokens: 1, output_tokens: 1 } }; } });
  // request carries NO tenantId — only the ambient context does.
  const req = { provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
  const snapshot = JSON.parse(JSON.stringify(req));
  await rc.run({ tenantId: 'ctx-tenant', actor: 'ctx-user', module: 'System' }, () => gateway.complete(req));
  assert.equal(providerCalled, true, 'context tenant satisfied enforce-tenant → provider called');
  assert.deepEqual(req, snapshot, 'gateway did not mutate the request (no tenantId/actor injected)');
});

// P6-16. AI_CALL still gets actor/tenantId from the logger request context.
test('P6-16. AI_CALL correlation (actor/tenantId) still comes from request context', async () => {
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  await rc.run({ requestId: 'req-p6', actor: 'admin', tenantId: 't-p6', module: 'System' }, async () => {
    await gateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] });
  });
  logger.__setSink(restore); logger.__setLevel('silent');
  const rec = aiLogs.find((r) => r.event === 'AI_CALL');
  assert.equal(rec.requestId, 'req-p6');
  assert.equal(rec.actor, 'admin');
  assert.equal(rec.tenantId, 't-p6');
  assert.equal(rec.module, 'AI');
});

// ── WP-12 C2 — actor context through the gateway ────────────────────────────
// C2. Gateway forwards the ambient context (actor) into policy without mutating
// the request; the AI_CALL top-level actor still comes from request-context.
test('C2. gateway forwards context actor to policy without mutating the request', async () => {
  registry.__setProvider('anthropic', { complete: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) });
  const restore = captureAiLogs(); logger.__setLevel('debug');
  const req = { provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };
  const snapshot = JSON.parse(JSON.stringify(req));
  await rc.run({ requestId: 'req-c2', actor: 'session-user', tenantId: null, module: 'System' }, async () => {
    await gateway.complete(req);
  });
  logger.__setSink(restore); logger.__setLevel('silent');
  assert.deepEqual(req, snapshot, 'gateway did not inject actor onto the request');
  const rec = aiLogs.find((r) => r.event === 'AI_CALL');
  assert.equal(rec.actor, 'session-user', 'AI_CALL top-level actor from request-context');
  assert.equal(rec.module, 'AI');
  // no new AI_CALL metadata field for actor/actorSource
  assert.ok(!('actor' in rec.metadata), 'no actor field added to AI_CALL metadata');
  assert.ok(!('actorSource' in rec.metadata), 'no actorSource field added to AI_CALL metadata');
});

// ── WP-11 P7 — consolidated policy safety sweep ─────────────────────────────
// One end-to-end proof of the whole engine's safety contract: safe defaults,
// strict can deny, report override neutralises strict, deny does not call the
// provider, deny log is schema-valid and content-free (incl. tenant secret +
// classification body), and evaluation never mutates the request.
test('P7. policy safety sweep — defaults safe, strict denies, deny content-free & non-mutating', async () => {
  const baseValid = () => ({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] });

  // (a) Safe defaults: no policy env → report mode, standard profile, nothing denies.
  let calls = 0;
  registry.__setProvider('anthropic', { complete: async () => { calls++; return { content: [], usage: { input_tokens: 1, output_tokens: 1 } }; } });
  assert.equal(policyMod.resolveMode(), 'report', 'default mode is report');
  assert.equal(policyMod.resolveProfile(), 'standard', 'default profile is standard');
  assert.ok(await gateway.complete(baseValid()), 'report/standard executes the provider');
  const r0 = policyMod.evaluate(baseValid());
  assert.equal(r0.allow, true, 'no enforcement when env vars unset');

  // (b) Strict can deny; a report override on strict disables denial.
  process.env.AI_POLICY_PROFILE = 'strict';
  process.env.AI_POLICY_MODE = 'report';
  assert.ok(await gateway.complete(baseValid()), 'report override on strict does not deny');
  delete process.env.AI_POLICY_MODE; // strict → enforce

  // (c) Plant sentinels across every content-bearing + governance field; strict
  //     denies (missing approval), provider not called, deny log content-free,
  //     request not mutated.
  const S7 = {
    prompt: 'P7-PROMPT-SENTINEL translate this document',
    system: 'P7-SYSTEM-SENTINEL confidential body',
    tenant: 'P7-TENANT-SECRET-abc123',
    classification: 'P7-CLASSIFICATION-BODY-topsecret',
    apiKey: 'sk-P7SENTINELapikey0123456789',
  };
  const req = {
    provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6',
    system: `${S7.system} ${S7.apiKey}`, tenantId: S7.tenant, classification: S7.classification,
    messages: [{ role: 'user', content: S7.prompt }],
  };
  const snapshot = JSON.parse(JSON.stringify(req));
  const before = calls;
  const captured = [];
  const restore = logger.__setSink((rec) => captured.push(rec));
  logger.__setLevel('info');
  let thrown;
  try { await gateway.complete(req); } catch (e) { thrown = e; }
  logger.__setSink(restore); logger.__setLevel('silent');

  assert.equal(thrown && thrown.name, 'PolicyDeniedError');
  assert.equal(thrown.code, 'AI_POLICY_DENIED');
  assert.equal(thrown.status, 403);
  assert.equal(thrown.userError, true);
  assert.equal(calls, before, 'provider NOT called on deny');
  assert.deepEqual(req, snapshot, 'evaluation/deny did not mutate the request');

  const aicalls = captured.filter((r) => r.event === 'AI_CALL');
  assert.equal(aicalls.length, 1, 'exactly one AI_CALL on deny');
  const rec = aicalls[0];
  assert.equal(validateRec(rec).valid, true, 'deny log schema-valid');
  assert.equal(rec.metadata.status, 'error');
  assert.equal(rec.metadata.policyMode, 'enforce');
  assert.equal(rec.metadata.errorName, 'PolicyDeniedError');
  const haystack = JSON.stringify([rec, thrown.message]);
  for (const sentinel of [S7.prompt, S7.system, S7.tenant, S7.classification, S7.apiKey]) {
    assert.ok(!haystack.includes(sentinel), `deny log/error leaked: ${sentinel.slice(0, 20)}…`);
  }
});

// ── WP-12 C5 — policy-context safety sweep (all gateway paths) ───────────────
// Sentinels planted in EVERY context + content field, exercised across success,
// deny, stream, stream-rejection, and image paths. Every AI_CALL and deny error
// is proven free of prompts/messages/documents/secrets and of the governance
// identifiers (actor/tenant/classification/approval); AI_CALL metadata keys and
// count are proven unchanged.
const C5 = {
  actor: 'C5-ACTOR-SENTINEL', tenant: 'C5-TENANT-SECRET-abc',
  classification: 'C5-CLASSIFICATION-BODY-xyz', approval: 'C5-APPROVAL-SECRET-qrs',
  system: 'C5-SYSTEM-PROMPT-sentinel', message: 'C5-MESSAGE-sentinel translate',
  document: 'C5-DOCUMENT-BODY-sentinel section 4.2', imagePrompt: 'C5-IMAGE-PROMPT-sentinel poster',
  apiKey: 'sk-C5SENTINELapikey0123456789', bearerTok: 'C5SENTINELbearertoken',
  jwt: 'eyJC5SENThdr.eyJC5SENTpayload.C5SENTsig', email: 'c5.sentinel@example.com',
  medical: 'C5-MEDICAL-sentinel asthma restriction', disciplinary: 'C5-DISCIPLINARY-sentinel warning',
  sql: "SELECT HashPass FROM tblPswd WHERE UserName='c5admin'", sqlParam: 'C5-SQL-PARAM-sentinel',
  response: 'C5-RESPONSE-BODY-sentinel',
};
// text request stuffed with every sentinel
const c5TextReq = (extra = {}) => ({
  provider: 'anthropic', agent: 'AI-DOC-001', operation: 'generate_content', model: 'claude-sonnet-4-6',
  actor: C5.actor, tenantId: C5.tenant, classification: C5.classification, approvalStatus: C5.approval,
  system: `${C5.system} ${C5.document} ${C5.apiKey} Bearer ${C5.bearerTok}`,
  messages: [{ role: 'user', content: [{ type: 'text', text: `${C5.message} ${C5.medical} ${C5.disciplinary} ${C5.email} ${C5.jwt}` }] }],
  tools: [{ name: 'lookup', description: C5.sql }], metadata: { note: C5.sqlParam }, ...extra,
});
const c5ImageReq = (extra = {}) => ({
  provider: 'openai', agent: 'AI-DOC-001', operation: 'generate_cover_image', model: 'gpt-image-1',
  actor: C5.actor, tenantId: C5.tenant, classification: C5.classification, approvalStatus: C5.approval,
  prompt: `${C5.imagePrompt} ${C5.document} ${C5.apiKey}`, ...extra,
});
const c5Response = () => ({ content: [{ type: 'text', text: `${C5.response} ${C5.email}` }], usage: { input_tokens: 7, output_tokens: 3 } });

// values that must NEVER appear anywhere in a record (content + governance ids)
const C5_MUST_BE_ABSENT = [
  C5.actor, C5.tenant, C5.classification, C5.approval, C5.system, C5.message,
  C5.document, C5.imagePrompt, C5.medical, C5.disciplinary, C5.sqlParam, C5.response,
  C5.apiKey, C5.bearerTok, C5.jwt, C5.email, C5.sql,
];
// the only allowed AI_CALL metadata keys (success set; error adds errorName/errorMessage)
const C5_META_KEYS = new Set([
  'agent', 'costUsd', 'decisionStatus', 'durationMs', 'estimatedTokens', 'inputTokens',
  'model', 'operation', 'outputTokens', 'policyMode', 'policyVersion', 'provider',
  'status', 'totalTokens', 'errorName', 'errorMessage',
]);
const C5_FORBIDDEN_META = ['actor', 'actorSource', 'tenantId', 'classification', 'approvalStatus'];

function c5AssertRecordSafe(rec) {
  assert.equal(validateRec(rec).valid, true, 'AI_CALL schema-valid');
  assert.equal(rec.event, 'AI_CALL');
  // metadata keys are a subset of the allowed set — no new / leaked fields
  for (const k of Object.keys(rec.metadata)) assert.ok(C5_META_KEYS.has(k), `unexpected metadata key: ${k}`);
  for (const k of C5_FORBIDDEN_META) assert.ok(!(k in rec.metadata), `governance field ${k} must not be in metadata`);
  assert.ok(!('stack' in rec.metadata), 'no stack in metadata');
  const s = JSON.stringify(rec);
  for (const leak of C5_MUST_BE_ABSENT) assert.ok(!s.includes(leak), `record leaked sentinel: ${leak.slice(0, 22)}…`);
}

test('C5. policy-context safety sweep across every gateway path', async () => {
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('info');
  const denyErrors = [];

  // (1) successful complete()
  registry.__setProvider('anthropic', { complete: async () => c5Response() });
  await gateway.complete(c5TextReq());

  // (3) successful stream()
  registry.__setProvider('anthropic', { stream: async () => ({ on() {}, finalMessage: async () => c5Response() }) });
  await gateway.stream(c5TextReq({ stream: true }));
  await settle();

  // (4) stream finalMessage rejection (error carries a key + email → must be masked)
  const streamBoom = new Error(`stream failed key=${C5.apiKey} user=${C5.email}`);
  registry.__setProvider('anthropic', { stream: async () => ({ on() {}, finalMessage: async () => { throw streamBoom; } }) });
  await gateway.stream(c5TextReq({ stream: true }));
  await settle();

  // (5) successful generateImage()
  registry.__setProvider('openai', { generateImage: async () => ({ b64: 'AAAA' }) });
  await gateway.generateImage(c5ImageReq());

  // (2) denied complete() — enforce mode + unknown model → PolicyDeniedError, provider not called
  process.env.AI_POLICY_MODE = 'enforce';
  let denyProviderCalls = 0;
  registry.__setProvider('anthropic', { complete: async () => { denyProviderCalls++; return c5Response(); } });
  try { await gateway.complete(c5TextReq({ model: 'C5-UNKNOWN-MODEL' })); } catch (e) { denyErrors.push(e); }

  // (6) denied generateImage() — enforce + unknown model
  registry.__setProvider('openai', { generateImage: async () => { denyProviderCalls++; return { b64: 'X' }; } });
  try { await gateway.generateImage(c5ImageReq({ model: 'C5-UNKNOWN-IMG' })); } catch (e) { denyErrors.push(e); }
  delete process.env.AI_POLICY_MODE;

  logger.__setSink(restore); logger.__setLevel('silent');

  // ── verify every emitted AI_CALL record ──
  const calls = captured.filter((r) => r.event === 'AI_CALL');
  assert.ok(calls.length >= 6, `expected ≥6 AI_CALL records, got ${calls.length}`);
  for (const rec of calls) c5AssertRecordSafe(rec);
  assert.equal(denyProviderCalls, 0, 'no provider called on either deny');

  // at least one success + one error + one masked-secret error record present
  assert.ok(calls.some((r) => r.metadata.status === 'ok'), 'a success AI_CALL exists');
  assert.ok(calls.some((r) => r.metadata.status === 'error'), 'an error AI_CALL exists');
  const streamErr = calls.find((r) => r.metadata.status === 'error' && r.metadata.errorName === 'Error');
  assert.ok(streamErr && streamErr.metadata.errorMessage.includes('[REDACTED]'), 'stream-rejection key masked');

  // ── verify deny errors ──
  assert.equal(denyErrors.length, 2, 'both deny paths threw');
  for (const e of denyErrors) {
    assert.equal(e.name, 'PolicyDeniedError');
    assert.equal(e.code, 'AI_POLICY_DENIED');
    assert.equal(e.status, 403);
    const es = `${e.message} ${e.stack || ''}`;
    // the generic message carries no sentinel content/secret
    for (const leak of C5_MUST_BE_ABSENT) assert.ok(!e.message.includes(leak), `deny message leaked: ${leak.slice(0, 20)}…`);
    assert.ok(!/SELECT|tblPswd/.test(e.message), 'no SQL in deny message');
    assert.ok(!es.includes(C5.apiKey), 'no raw key in deny error');
  }
});
