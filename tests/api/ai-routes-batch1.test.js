// WP-10 · A6.3 — AI route batch 1 migration verification (ai / disciplinary / onboarding).
// Drives the real routes through the real AI Gateway with a stubbed provider
// (no real Anthropic/OpenAI/network). Proves gateway routing, audited AI_CALL,
// content-safety, and unchanged response/error behaviour.
require('../helpers/network-guard');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');
const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

let app;
let registry;
let logs;
let empId;
let handler; // per-test provider response

before(async () => {
  app = await startTestApp();
  // The app's fresh instances (purged per startTestApp) — must be required AFTER it.
  registry = require(path.join(__dirname, '..', '..', 'lib', 'ai', 'providers', 'registry.js'));
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => logs.push(r));
  empId = (await app.request('POST', '/api/staff', { LastName: 'AiR', FirstName: 'Batch1', Status: 'Active', FileNum: 'A63-1' })).json().StaffID;
});
after(async () => { if (app) { registry.__reset(); app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); } });
beforeEach(() => {
  logs = [];
  handler = (req) => ({ content: [{ type: 'text', text: 'stub' }], usage: { input_tokens: 4, output_tokens: 2 } });
  registry.__setProvider('anthropic', { complete: async (req) => { req.__seen = true; return handler(req); } });
});

const aiCallsFor = (op) => logs.filter((r) => r.event === 'AI_CALL' && r.metadata && r.metadata.operation === op);

// 1. routes/ai.js /draft-desc goes through the gateway (agent AI-ADM-001).
test('A6.3-1. /api/ai/draft-desc routes through the gateway', async () => {
  handler = () => ({ content: [{ type: 'text', text: 'A concise competency description.' }], usage: { input_tokens: 3, output_tokens: 6 } });
  const r = await app.request('POST', '/api/ai/draft-desc', { itemType: 'competency', context: 'Working at heights' });
  assert.equal(r.status, 200, 'response status unchanged');
  assert.equal(r.json().success, true);
  assert.equal(r.json().description, 'A concise competency description.', 'response parsing unchanged');
  const calls = aiCallsFor('draft_description');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].module, 'AI');
  assert.equal(calls[0].metadata.agent, 'AI-ADM-001');
  assert.equal(validateLogRecord(calls[0]).valid, true);
});

// 2. disciplinary /ai-draft goes through the gateway (agent AI-WKF-001).
test('A6.3-2. /api/disciplinary/ai-draft routes through the gateway', async () => {
  handler = () => ({ content: [{ type: 'text', text: 'Factual disciplinary description text.' }], usage: { input_tokens: 8, output_tokens: 12 } });
  const r = await app.request('POST', '/api/disciplinary/ai-draft', { EmpID: empId, ActionType: 'Verbal Warning', Reason: 'Absenteeism' });
  assert.equal(r.status, 200, 'response status unchanged');
  assert.equal(r.json().description, 'Factual disciplinary description text.');
  assert.ok(r.json().contextUsed && typeof r.json().contextUsed.recentActions === 'number', 'contextUsed shape unchanged');
  const calls = aiCallsFor('draft_disciplinary');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.agent, 'AI-WKF-001');
});

// 3. onboarding role-description goes through the gateway (agent AI-WKF-002).
test('A6.3-3. onboarding role-description routes through the gateway', async () => {
  handler = () => ({ content: [{ type: 'text', text: JSON.stringify({ title: 'Operator', summary: 's', responsibilities: [], requirements: [], qualifications: [], competencies: [], reportsTo: 'Supervisor' }) }], usage: { input_tokens: 5, output_tokens: 20 } });
  // create a candidate
  const cand = await app.request('POST', '/api/onboarding', { FirstName: 'Cand', LastName: 'Idate', Position: 'Haul Truck Operator' });
  const cid = cand.json().CandidateID;
  assert.ok(cid, 'candidate created');
  const r = await app.request('POST', `/api/onboarding/${cid}/role-description`, { position: 'Haul Truck Operator' });
  assert.equal(r.status, 200, 'response status unchanged');
  const calls = aiCallsFor('role_description');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.agent, 'AI-WKF-002');
});

// 4/5. AI_CALL emitted per path; no prompt/system/user content in the audit.
test('A6.3-4/5. AI_CALL emitted; no prompt/content in logs', async () => {
  handler = () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
  await app.request('POST', '/api/ai/draft-desc', { itemType: 'course', context: 'A63-SENTINEL-USER-CONTEXT' });
  const calls = logs.filter((r) => r.event === 'AI_CALL');
  assert.ok(calls.length >= 1, 'AI_CALL emitted');
  const s = JSON.stringify(calls);
  assert.ok(!s.includes('A63-SENTINEL-USER-CONTEXT'), 'user context absent from audit');
  assert.ok(!s.includes('mining-industry training'), 'system prompt text absent from audit');
});

// WP-12 · C2. The authenticated session actor reaches the AI audit — proving the
// same request context the gateway forwards into policy.evaluate carries the real
// user. Route and auth behaviour are unchanged; no content leaks.
test('C2. authenticated session actor reaches AI_CALL via request context', async () => {
  handler = () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } });
  const r = await app.request('POST', '/api/ai/draft-desc', { itemType: 'competency', context: 'C2-ACTOR-SENTINEL' });
  assert.equal(r.status, 200, 'route response unchanged');
  const calls = logs.filter((x) => x.event === 'AI_CALL');
  assert.ok(calls.length >= 1, 'AI_CALL emitted');
  assert.equal(calls[0].actor, 'admin', 'top-level actor is the authenticated session user');
  assert.equal(calls[0].module, 'AI');
  assert.ok(!JSON.stringify(calls).includes('C2-ACTOR-SENTINEL'), 'no route content in the audit');
});

// 6/7. Error behaviour unchanged: provider failure → route's existing 500 shape.
test('A6.3-6/7. provider failure preserves route error behaviour', async () => {
  handler = () => { throw new Error('provider down'); };
  const r = await app.request('POST', '/api/ai/draft-desc', { itemType: 'form', context: 'x' });
  assert.equal(r.status, 500, 'existing 500 contract preserved');
  assert.ok(typeof r.json().error === 'string', 'error JSON shape unchanged');
  // disciplinary wraps the message: "AI draft failed: …"
  const d = await app.request('POST', '/api/disciplinary/ai-draft', { EmpID: empId, ActionType: 'Verbal Warning' });
  assert.equal(d.status, 500);
  assert.ok(d.json().error.startsWith('AI draft failed:'), 'disciplinary error wrapper preserved');
});
