// WP-07 · C10 — AI boundary + no-network guard.
// Proves the AI client is lazy, cached, key-gated, and NEVER performs a real
// network call. The Anthropic SDK is replaced by a fake constructor that counts
// instantiations and makes no request; the outbound network guard is active.
require('../helpers/network-guard'); // guarantees the guard in this process too
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const https = require('node:https');
const { freshDb, cleanupAll, initReady } = require('../helpers/db');

const ROOT = path.join(__dirname, '..', '..');
const AI_PATH = require.resolve(path.join(ROOT, 'lib', 'ai.js'));
const SDK_PATH = require.resolve('@anthropic-ai/sdk');

// No API key anywhere in this process.
delete process.env.ANTHROPIC_API_KEY;

let sdkNews = 0;
let lastOpts = null;

// Replace the Anthropic SDK with a fake constructor (instantiation only, no I/O).
function installFakeSdk() {
  sdkNews = 0;
  lastOpts = null;
  class FakeAnthropic {
    constructor(opts) {
      sdkNews++;
      lastOpts = opts;
      this.messages = { create: async () => { throw new Error('fake provider: create() must not be called in tests'); } };
    }
  }
  require.cache[SDK_PATH] = { id: SDK_PATH, filename: SDK_PATH, loaded: true, exports: FakeAnthropic };
}

function loadAiFresh() {
  delete require.cache[AI_PATH];
  return require(AI_PATH);
}

// 9 + guard. The outbound network guard is active and blocks non-local traffic.
test('9. outbound network is blocked; localhost is allowed', () => {
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true, 'network guard active');
  assert.throws(() => https.request('https://api.anthropic.com/v1/messages'), /network-guard/, 'outbound https blocked');
  // A localhost request is permitted by the guard (it will fail to connect, not be blocked).
  const { isLocalHost } = require('../helpers/network-guard');
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('api.anthropic.com'), false);
});

// 1. getClient throws a clear error when no key is configured.
test('1. getClient throws a clear error when the key is absent', async () => {
  const { mod } = freshDb();            // temp DB with an empty tblConfig
  await initReady(mod);
  installFakeSdk();
  const ai = loadAiFresh();             // binds dbGet to the temp DB
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(() => ai.getClient(), /Anthropic API key not configured/);
  assert.equal(sdkNews, 0, 'no client instantiated when key missing');
  await cleanupAll();
});

// 3 + 5. Lazy creation; creating the client performs no request.
test('3/5. client is created lazily and instantiation makes no request', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  installFakeSdk();
  const ai = loadAiFresh();
  assert.equal(sdkNews, 0, 'no client created merely by requiring the module (lazy)');
  const client = await ai.getClient();
  assert.equal(sdkNews, 1, 'client created on first request');
  assert.ok(client && typeof client.messages.create === 'function', 'returns a client object');
  // Instantiation only — no network happened (guard did not fire, fake made no call).
  delete process.env.ANTHROPIC_API_KEY;
});

// 2. Repeated getClient calls return the same cached instance.
test('2. getClient returns the same cached client on repeated calls', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  installFakeSdk();
  const ai = loadAiFresh();
  const c1 = await ai.getClient();
  const c2 = await ai.getClient();
  assert.equal(c1, c2, 'same cached instance');
  assert.equal(sdkNews, 1, 'client instantiated exactly once');
  delete process.env.ANTHROPIC_API_KEY;
});

// 4. Removing the key AFTER a client is cached returns the cached client (current behaviour).
test('4. cached client persists after the key is removed (observed behaviour)', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  installFakeSdk();
  const ai = loadAiFresh();
  const cA = await ai.getClient();
  delete process.env.ANTHROPIC_API_KEY;      // key gone, but a client is already cached
  const cB = await ai.getClient();
  assert.equal(cB, cA, 'cached client still returned after key removal');
  assert.equal(sdkNews, 1, 'no re-instantiation');
  // resetClient clears the cache (then a missing key would fail again).
  ai.resetClient();
});

// 8. A fake provider object behaves safely — its create() cannot silently hit the network.
test('8. fake provider create() fails loudly instead of making a real call', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
  installFakeSdk();
  const ai = loadAiFresh();
  const client = await ai.getClient();
  await assert.rejects(() => client.messages.create({}), /must not be called/);
  delete process.env.ANTHROPIC_API_KEY;
});
