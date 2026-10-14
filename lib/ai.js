const Anthropic = require('@anthropic-ai/sdk');
const { dbGet } = require('../database/db');
const { readSecretConfig } = require('./secret-config'); // R7 — decrypt-at-rest for tblConfig keys

// Lazy-init the client — reads ANTHROPIC_API_KEY from env or tblConfig (decrypted if encrypted at rest)
let _client = null;
async function getClient() {
  if (_client) return _client;
  let key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    key = await readSecretConfig(dbGet, 'anthropic_api_key');
  }
  if (!key) throw new Error('Anthropic API key not configured. Add ANTHROPIC_API_KEY to your environment or set it under Admin → AI Settings.');
  // 25-minute per-request timeout. AI calls STREAM (see the provider adapter), so the connection stays
  // alive while a big document is written — the timeout only trips on a genuine hang (no data), NOT on a
  // slow-but-progressing generation. maxRetries: 3 because this site's network/proxy intermittently RESETS
  // connections ("terminated" / "Connection error."); those fail fast, so the SDK's automatic
  // exponential-backoff retries recover most of them cheaply.
  _client = new Anthropic({ apiKey: key, baseURL: 'https://api.anthropic.com', timeout: 25 * 60 * 1000, maxRetries: 3 });
  return _client;
}

// Reset client (called after settings change)
function resetClient() { _client = null; }

module.exports = { getClient, resetClient };
