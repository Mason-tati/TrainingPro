// WP-10 · A1 — AI provider registry.
//
// Resolves a provider name to its adapter. Adapters are lazy-required so merely
// loading the registry instantiates no SDK. Future providers are registered as
// placeholders (not implemented in A1) so the enterprise shape is established
// without adding behaviour. A test seam lets suites inject stub providers.
'use strict';

// name → adapter loader (lazy). `null` = reserved/future, not yet implemented.
const PROVIDERS = {
  anthropic: () => require('./anthropic'),
  openai: () => require('./openai'),
  // Future-ready registry entries (intentionally not implemented in A1):
  gemini: null,
  ollama: null,
  'azure-openai': null,
  bedrock: null,
  vertex: null,
};

let _overrides = {};

function getProvider(name) {
  if (Object.prototype.hasOwnProperty.call(_overrides, name)) return _overrides[name];
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, name)) {
    throw new Error(`AI provider registry: unknown provider "${name}"`);
  }
  const loader = PROVIDERS[name];
  if (loader === null) throw new Error(`AI provider registry: provider "${name}" is registered but not implemented`);
  return loader();
}

// Names known to the registry (implemented + reserved), for docs/diagnostics.
function listProviders() { return Object.keys(PROVIDERS); }

// ── test seams (mirrors the codebase's __ helpers) ──
function __setProvider(name, impl) { _overrides[name] = impl; }
function __reset() { _overrides = {}; }

module.exports = { getProvider, listProviders, __setProvider, __reset };
