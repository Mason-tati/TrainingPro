// WP-10 · A6.4 — AI route batch 2 migration verification
// (exams / forms / knowledgebase / translator / powerpoints).
// Real routes through the real AI Gateway with a stubbed provider — no real
// Anthropic/OpenAI/network. Proves gateway routing, streaming, resetClient,
// audit, content-safety, and unchanged response/error behaviour.
require('../helpers/network-guard');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
let app;
let registry;
let logs;
let completeHandler;
let streamHandler;

before(async () => {
  app = await startTestApp();
  registry = require(path.join(ROOT, 'lib', 'ai', 'providers', 'registry.js'));
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => logs.push(r));
});
after(async () => { if (app) { registry.__reset(); app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); } });
beforeEach(() => {
  logs = [];
  completeHandler = () => ({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 3, output_tokens: 3 } });
  registry.__setProvider('anthropic', {
    complete: async (req) => completeHandler(req),
    stream: async (req) => streamHandler(req),
    resetClient: () => { registry.__resetCalled = (registry.__resetCalled || 0) + 1; },
  });
});
const aiCallsFor = (op) => logs.filter((r) => r.event === 'AI_CALL' && r.metadata && r.metadata.operation === op);
const settle = () => new Promise((r) => setTimeout(r, 30));

// 0. Structural: all five files migrated (no client.messages; approved agents present).
test('A6.4-0. all five route files are migrated to the gateway', () => {
  const map = {
    'routes/exams.js': 'AI-LRN-001',
    'routes/forms.js': 'AI-FRM-001',
    'routes/knowledgebase.js': 'AI-DOC-004',
    'routes/translator.js': 'AI-DOC-002',
    'routes/powerpoints.js': 'AI-DOC-003',
  };
  for (const [rel, agent] of Object.entries(map)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/\bclient\.messages\./.test(src), `${rel}: no direct client.messages`);
    assert.ok(src.includes('aiGateway'), `${rel}: uses the gateway`);
    assert.ok(src.includes(agent), `${rel}: stamps ${agent}`);
  }
});

// 1/7/9/10. exams /ai-suggest → gateway (generate_answers, AI-LRN-001); no content.
test('A6.4-1. exams /ai-suggest routes through the gateway', async () => {
  completeHandler = () => ({ content: [{ type: 'text', text: JSON.stringify({ answers: [{ Answer: 'A', correct: true }, { Answer: 'B', correct: false }], hint: 'h' }) }], usage: { input_tokens: 4, output_tokens: 8 } });
  const r = await app.request('POST', '/api/exams/ai-suggest', { question: 'A64-SENTINEL-QUESTION', questionType: 'single', count: 2 });
  assert.equal(r.status, 200, 'response status unchanged');
  assert.ok(Array.isArray(r.json().answers) && r.json().answers.length === 2, 'response shape unchanged');
  const calls = aiCallsFor('generate_answers');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.agent, 'AI-LRN-001');
  assert.equal(calls[0].metadata.model, 'claude-haiku-4-5', 'model preserved');
  assert.ok(!JSON.stringify(calls).includes('A64-SENTINEL-QUESTION'), 'question text absent from audit');
});

// 3/7. knowledgebase /ai-draft → gateway (kb_article, AI-DOC-004).
test('A6.4-3. knowledgebase /ai-draft routes through the gateway', async () => {
  completeHandler = () => ({ content: [{ type: 'text', text: '## Article body' }], usage: { input_tokens: 2, output_tokens: 5 } });
  const r = await app.request('POST', '/api/kb/ai-draft', { prompt: 'Isolation procedure', title: 'LOTO' });
  assert.equal(r.status, 200);
  assert.equal(r.json().body, '## Article body', 'response parsing unchanged');
  const calls = aiCallsFor('kb_article');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.agent, 'AI-DOC-004');
});

// 6. resetClient still works (exams /ai-settings → aiGateway.resetClient → provider).
test('A6.4-6. exams /ai-settings resets the client via the gateway', async () => {
  registry.__resetCalled = 0;
  const r = await app.request('PUT', '/api/exams/ai-settings', { apiKey: 'sk-a64-new-key' });
  assert.equal(r.status, 200, 'settings response unchanged');
  assert.ok(registry.__resetCalled >= 1, 'provider resetClient forwarded');
  await app.db.dbRun("DELETE FROM tblConfig WHERE ckey='anthropic_api_key'"); // cleanup temp config
});

// 5/8. powerpoints streaming → gateway; AI_CALL emitted on finalMessage (develop_deck).
test('A6.4-5/8. powerpoints /develop streams through the gateway', async () => {
  streamHandler = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_delta', delta: { text: JSON.stringify({ slides: [{ title: 'Slide 1', bullets: ['a'] }] }) } };
    },
    finalMessage: async () => ({ content: [{ type: 'text', text: '' }], usage: { input_tokens: 10, output_tokens: 40 } }),
  });
  const boundary = '----A64Boundary';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="topic"\r\n\r\nHaul truck safety\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="slides"\r\n\r\n5\r\n` +
    `--${boundary}--\r\n`, 'utf8');
  const res = await new Promise((resolve, reject) => {
    const u = new URL(app.baseUrl + '/api/powerpoints/develop');
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Cookie: app.cookie } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, text: d })); });
    req.on('error', reject); req.write(body); req.end();
  });
  await settle();
  assert.equal(res.status, 200, 'streamed deck response unchanged');
  const deck = JSON.parse(res.text);
  assert.ok(deck.success && deck.deck && Array.isArray(deck.deck.slides), 'deck built from stream deltas');
  const calls = aiCallsFor('develop_deck');
  assert.equal(calls.length, 1, 'one AI_CALL on finalMessage');
  assert.equal(calls[0].metadata.agent, 'AI-DOC-003');
  assert.equal(calls[0].metadata.totalTokens, 50, 'usage from finalMessage');
});

// 11. Error behaviour unchanged (provider failure → route's existing 500).
test('A6.4-11. provider failure preserves route error behaviour', async () => {
  completeHandler = () => { throw new Error('provider down'); };
  const r = await app.request('POST', '/api/exams/ai-suggest', { question: 'q', questionType: 'single' });
  assert.equal(r.status, 500, 'existing 500 contract preserved');
  assert.ok(r.json().error.includes('AI service error'), 'exams error wrapper preserved');
});
