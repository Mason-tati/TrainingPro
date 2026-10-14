// WP-10 · A6.2 — lib/content.js AI-gateway migration verification.
// Proves content.js Anthropic paths flow through the real AI Gateway (audited,
// agent/operation stamped, content-safe) via the provider-registry stub. No real
// Anthropic/OpenAI/network; no API key required. The OpenAI image path is NOT
// migrated in A6.2 (kept as a direct fetch), so it is not exercised here.
require('../helpers/network-guard');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const registry = require(path.join(ROOT, 'lib', 'ai', 'providers', 'registry.js'));
const logger = require(path.join(ROOT, 'lib', 'logger.js'));
const { validateLogRecord } = require(path.join(ROOT, 'lib', 'log-schema.js'));
const content = require(path.join(ROOT, 'lib', 'content.js'));

delete process.env.ANTHROPIC_API_KEY;

let aiCalls;
let handler;
let restoreLevel;
function textResponse(text) { return { content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 5 } }; }

beforeEach(() => {
  aiCalls = [];
  handler = () => textResponse('{}');
  registry.__setProvider('anthropic', { complete: async (req) => { aiCalls.push(req); return handler(req); } });
  restoreLevel = logger.__setLevel('silent');
});
afterEach(() => { registry.__reset(); logger.__setLevel(restoreLevel); });

// A6.2-1. content.generate() goes through the gateway (operation generate_content).
test('A6.2-1. generate() routes through the gateway', async () => {
  handler = () => textResponse(JSON.stringify({ title: 'T', sections: [{ heading: 'H', body: 'B' }] }));
  const data = await content.generate('course', 'Haul truck basics', {});
  assert.deepEqual(data, { title: 'T', sections: [{ heading: 'H', body: 'B' }] }, 'response parsed unchanged');
  assert.equal(aiCalls.length, 1, 'one gateway call (no source → no flowchart pass)');
  assert.equal(aiCalls[0].provider, 'anthropic');
  assert.equal(aiCalls[0].agent, 'AI-DOC-001');
  assert.equal(aiCalls[0].operation, 'generate_content');
  assert.equal(aiCalls[0].max_tokens, 64000); // model max — fits large multi-section docs in one pass
});

// A6.2-2. translateSection() goes through the gateway (operation translate_section).
test('A6.2-2. translateSection() routes through the gateway', async () => {
  handler = () => textResponse(JSON.stringify({ heading: 'หัวข้อ' }));
  const out = await content.translateSection({ heading: 'Heading' }, 'Thai');
  assert.deepEqual(out, { heading: 'หัวข้อ' }, 'translated JSON parsed unchanged');
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].operation, 'translate_section');
  assert.equal(aiCalls[0].agent, 'AI-DOC-001');
});

// A6.2-3. generateCoverImageSvg() goes through the gateway (operation generate_cover_svg).
test('A6.2-3. generateCoverImageSvg() routes through the gateway; retry preserved', async () => {
  // first attempt returns prose (no svg) → retry; second returns svg
  let n = 0;
  handler = () => (++n === 1 ? textResponse('sorry, here is a description') : textResponse('<svg viewBox="0 0 800 500"></svg>'));
  const svg = await content.generateCoverImageSvg('haul truck');
  assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'), 'svg returned');
  assert.equal(aiCalls.length, 2, 'retry behaviour preserved');
  assert.equal(aiCalls[0].operation, 'generate_cover_svg');
});

// A6.2-5. AI_CALL emitted (with audit) only when AI is used; schema-valid.
test('A6.2-5. gateway emits schema-valid AI_CALL for content generation', async () => {
  handler = () => textResponse(JSON.stringify({ title: 'X', sections: [] }));
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('debug');
  await content.generate('sop', 'Isolation procedure', {});
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = captured.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assert.equal(validateLogRecord(calls[0]).valid, true);
  assert.equal(calls[0].module, 'AI');
  assert.equal(calls[0].metadata.operation, 'generate_content');
});

// A6.2-6. No prompt/system/document text appears in the AI_CALL audit.
test('A6.2-6. no prompt/content appears in AI_CALL logs', async () => {
  handler = () => textResponse(JSON.stringify({ title: 'X', sections: [] }));
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('debug');
  await content.generate('sop', 'A62-SENTINEL-PROMPT', { sourceText: 'A62-SENTINEL-DOCUMENT-BODY' });
  logger.__setSink(restore); logger.__setLevel('silent');
  const s = JSON.stringify(captured.filter((r) => r.event === 'AI_CALL'));
  assert.ok(!s.includes('A62-SENTINEL-PROMPT'), 'prompt absent');
  assert.ok(!s.includes('A62-SENTINEL-DOCUMENT-BODY'), 'source document text absent');
  assert.ok(!s.includes('senior training'), 'system text absent');
});

// A6.2-7. Error handling preserved (unexpected format → thrown error).
test('A6.2-7. generate() error handling preserved', async () => {
  handler = () => textResponse('not json and unrepairable <<<');
  await assert.rejects(() => content.generate('course', 'x', {}), /unexpected format/);
});

// ── WP-10 A6.5 — OpenAI image path migration ───────────────────────────────
const openaiAdapter = require(path.join(ROOT, 'lib', 'ai', 'providers', 'openai.js'));

// A6.5-1/3. Adapter forwards the exact endpoint/method/headers/body; parses b64.
test('A6.5-1/3. openai adapter forwards the exact request and parses the image', async () => {
  const realFetch = global.fetch;
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ data: [{ b64_json: 'IMGDATA' }] }) };
  };
  try {
    const out = await openaiAdapter.generateImage({ apiKey: 'sk-a65-key', prompt: 'haul truck', model: 'gpt-image-1', size: '1536x1024', quality: 'medium', n: 1 });
    assert.equal(out, 'data:image/png;base64,IMGDATA', 'b64 parsed + dataURI unchanged');
    assert.equal(seen.url, 'https://api.openai.com/v1/images/generations', 'endpoint unchanged');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers.Authorization, 'Bearer sk-a65-key', 'auth header unchanged');
    assert.equal(seen.init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.model, 'gpt-image-1');
    assert.equal(body.size, '1536x1024');
    assert.equal(body.quality, 'medium');
    assert.equal(body.n, 1);
    assert.ok(body.prompt.includes('Photorealistic') && body.prompt.includes('haul truck'), 'prompt wrapper preserved');
    assert.ok(!('response_format' in body), 'body shape unchanged (no response_format)');
  } finally { global.fetch = realFetch; }
});

// A6.5-4/5. Error + userError behaviour preserved (adapter level).
test('A6.5-4/5. openai adapter error + userError behaviour preserved', async () => {
  const realFetch = global.fetch;
  // no key → userError
  await assert.rejects(() => openaiAdapter.generateImage({ prompt: 'x' }), (e) => e.userError === true && /API key not set/.test(e.message));
  // 401 → userError true with provider message
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid key' } }) });
  try {
    await assert.rejects(() => openaiAdapter.generateImage({ apiKey: 'k', prompt: 'x' }), (e) => e.userError === true && e.message === 'invalid key');
    // 500 → userError false
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(() => openaiAdapter.generateImage({ apiKey: 'k', prompt: 'x' }), (e) => e.userError === false);
    // ok but no data → generic error
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
    await assert.rejects(() => openaiAdapter.generateImage({ apiKey: 'k', prompt: 'x' }), /no image data/);
  } finally { global.fetch = realFetch; }
});

// A6.5-2/6/7. generateCoverImagePhoto → gateway; AI_CALL (openai/AI-DOC-001/op); no key/prompt in logs.
test('A6.5-2/6/7. generateCoverImagePhoto routes through the gateway, audited, content-safe', async () => {
  registry.__setProvider('openai', { generateImage: async (req) => { aiCalls.push(req); return 'data:image/png;base64,STUB'; } });
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('debug');
  const out = await content.generateCoverImagePhoto('A65-IMG-PROMPT', 'sk-A65-SECRET-KEY');
  logger.__setSink(restore); logger.__setLevel('silent');
  assert.equal(out, 'data:image/png;base64,STUB', 'return value unchanged');
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].provider, 'openai');
  assert.equal(aiCalls[0].agent, 'AI-DOC-001');
  assert.equal(aiCalls[0].operation, 'generate_cover_image');
  const calls = captured.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.provider, 'openai');
  const s = JSON.stringify(calls);
  assert.ok(!s.includes('A65-IMG-PROMPT'), 'image prompt absent from logs');
  assert.ok(!s.includes('sk-A65-SECRET-KEY'), 'API key absent from logs');
});
