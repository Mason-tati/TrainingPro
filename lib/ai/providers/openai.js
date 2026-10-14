// WP-10 · A6.5 — OpenAI provider adapter (image generation).
//
// Owns the SDK/HTTP call for the 'openai' provider. The image-generation fetch
// was moved here verbatim from lib/content.js — endpoint, method, headers,
// Authorization, request body shape, parsing, error handling and userError
// behaviour are byte-identical. The gateway forwards the request unchanged and
// audits metadata only (never the prompt or key).
'use strict';

async function generateImage(request) {
  const { apiKey, prompt } = request || {};
  if (!apiKey) { const e = new Error('OpenAI API key not set. Add it under Admin → AI Settings to use AI photos.'); e.userError = true; throw e; }
  const full = `Photorealistic, professional photograph of ${prompt}. Mining / heavy-industrial setting, clean well-lit composition suitable for a training document cover. No text, no watermark, no logos, no people's faces in focus.`;
  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: request.model || 'gpt-image-1', prompt: full, size: request.size || '1536x1024', quality: request.quality || 'medium', n: request.n || 1 })
    });
  } catch (netErr) { throw new Error('Could not reach OpenAI: ' + netErr.message); }
  if (!resp.ok) {
    let msg = 'OpenAI image request failed (HTTP ' + resp.status + ')';
    try { const j = await resp.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch {}
    const e = new Error(msg); e.userError = [400, 401, 403, 429].includes(resp.status); throw e;
  }
  const j = await resp.json();
  const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('OpenAI returned no image data.');
  return 'data:image/png;base64,' + b64;
}

module.exports = { name: 'openai', generateImage };
