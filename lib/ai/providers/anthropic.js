// WP-10 · A1 — Anthropic provider adapter.
//
// Owns the SDK call for the 'anthropic' provider. It wraps the EXISTING
// lib/ai.js client resolver (which is not modified) and simply forwards: no
// logging, no retries, no metadata, no prompt changes. Gateway-control keys
// (provider/agent/operation/stream) are stripped so only genuine SDK options
// reach messages.create/stream. Responses and streams are returned untouched;
// errors propagate unchanged.
'use strict';
const ai = require('../../ai.js'); // explicit extension — lib/ai.js (the file, not the lib/ai/ dir)

// Gateway-control keys that are consumed by the gateway/adapter and must NOT be
// forwarded to the Anthropic SDK. Everything else (model, system, messages,
// max_tokens, temperature, tools, tool_choice, metadata, thinking, and any
// future SDK option) is forwarded unchanged, with nested values kept BY
// REFERENCE (no cloning) so structures are preserved exactly.
const GATEWAY_CONTROL_KEYS = ['provider', 'agent', 'operation', 'stream'];

function toSdkArgs(request) {
  const args = {};
  for (const [k, v] of Object.entries(request || {})) {
    if (!GATEWAY_CONTROL_KEYS.includes(k)) args[k] = v; // reference-preserving
  }
  return args;
}

async function complete(request) {
  const client = await ai.getClient();
  // Stream under the hood and return the assembled final message (identical shape to messages.create).
  // Streaming keeps bytes flowing on the connection, so long generations aren't killed by an
  // idle-connection timeout on intermediate proxies/firewalls — the failure mode that made large
  // non-streaming requests hang for minutes and then time out.
  return client.messages.stream(toSdkArgs(request)).finalMessage();
}

async function stream(request) {
  const client = await ai.getClient();
  return client.messages.stream(toSdkArgs(request));
}

function resetClient() {
  return ai.resetClient();
}

module.exports = { name: 'anthropic', complete, stream, resetClient, toSdkArgs, GATEWAY_CONTROL_KEYS };
