// WP-10 · A6.5 — repo-wide AI boundary guard.
// Enforces that all AI usage flows through the gateway: no direct Anthropic SDK
// calls (messages.create/stream) outside the anthropic adapter, no direct OpenAI
// image fetch outside the openai adapter, and no getClient() outside lib/ai.js +
// its adapter. Scans PRODUCTION source only (routes/ + lib/), never tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const ANTHROPIC_ADAPTER = path.join('lib', 'ai', 'providers', 'anthropic.js');
const OPENAI_ADAPTER = path.join('lib', 'ai', 'providers', 'openai.js');
const AI_CLIENT = path.join('lib', 'ai.js');

// Recursively list production .js files under a dir (excluding node_modules).
function listJs(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJs(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = [
  ...listJs(path.join(ROOT, 'routes')),
  ...listJs(path.join(ROOT, 'lib')),
].map((f) => ({ rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));

test('guard: no direct Anthropic messages.create/stream outside the anthropic adapter', () => {
  const offenders = files.filter((f) => f.rel !== ANTHROPIC_ADAPTER && /\.messages\.(create|stream)\s*\(/.test(f.src));
  assert.deepEqual(offenders.map((o) => o.rel), [], 'files calling the Anthropic SDK directly');
});

test('guard: no direct api.openai.com fetch outside the openai adapter', () => {
  const offenders = files.filter((f) => f.rel !== OPENAI_ADAPTER && f.src.includes('api.openai.com'));
  assert.deepEqual(offenders.map((o) => o.rel), [], 'files calling OpenAI directly');
});

test('guard: no getClient() usage outside lib/ai.js and the anthropic adapter', () => {
  // Allowed: lib/ai.js defines getClient; the anthropic adapter consumes it.
  const offenders = files.filter((f) => f.rel !== AI_CLIENT && f.rel !== ANTHROPIC_ADAPTER && /getClient\s*\(/.test(f.src));
  assert.deepEqual(offenders.map((o) => o.rel), [], 'files resolving the AI client directly');
});

test('guard: business libs and routes that do AI use the gateway', () => {
  // Any production file that references aiGateway must require lib/ai-gateway.
  const users = files.filter((f) => f.rel !== path.join('lib', 'ai-gateway.js') && /aiGateway\./.test(f.src));
  for (const f of users) {
    assert.ok(/require\(['"][^'"]*ai-gateway['"]\)/.test(f.src), `${f.rel} references aiGateway but does not require it`);
  }
  // And the migrated modules are indeed on the gateway.
  const migrated = ['lib/translate.js', 'lib/content.js', 'routes/ai.js', 'routes/disciplinary.js',
    'routes/onboarding.js', 'routes/exams.js', 'routes/forms.js', 'routes/knowledgebase.js',
    'routes/translator.js', 'routes/powerpoints.js'].map((p) => p.split('/').join(path.sep));
  for (const rel of migrated) {
    const f = files.find((x) => x.rel === rel);
    assert.ok(f, `${rel} present`);
    assert.ok(/require\(['"][^'"]*ai-gateway['"]\)/.test(f.src), `${rel} uses the gateway`);
  }
});
