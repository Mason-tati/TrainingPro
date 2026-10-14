// WP-18 · E6 — Metadata inheritance (Enterprise Document Engine).
//
// Deterministic metadata inheritance across ordered sources (site, department,
// classification, workflow, template, parent) with the document's own metadata taking
// highest precedence by default. Supports custom override precedence and field-level
// inheritance blocking. Pure and dependency-free. NEVER throws, NEVER mutates inputs. UNWIRED.
'use strict';

// Default precedence, lowest → highest. 'own' (the document's own metadata) wins by default.
const DEFAULT_PRECEDENCE = Object.freeze(['site', 'department', 'classification', 'workflow', 'template', 'parent', 'own']);

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
    return out;
  }
  return value;
}

// Resolve inherited metadata. Returns { metadata, resolution } where resolution maps each
// resolved field to the source name it came from. `sources` may be an array of
// { source, metadata } entries OR a plain object map { sourceName: metadata }.
function inheritMetadata(own, sources, options) {
  const opts = obj(options);
  const order = (Array.isArray(opts.precedence) && opts.precedence.length > 0) ? opts.precedence.slice() : DEFAULT_PRECEDENCE.slice();
  const blocked = new Set(Array.isArray(opts.blocked) ? opts.blocked.filter((x) => typeof x === 'string') : []);

  const provided = {};
  if (Array.isArray(sources)) {
    for (const s of sources) {
      if (isPlainObject(s) && typeof s.source === 'string') provided[s.source] = obj(s.metadata);
    }
  } else if (isPlainObject(sources)) {
    for (const k of Object.keys(sources)) provided[k] = obj(sources[k]);
  }
  provided.own = obj(own);
  if (!order.includes('own')) order.push('own');

  const allFields = new Set();
  for (const name of order) {
    const m = provided[name];
    if (m) for (const f of Object.keys(m)) allFields.add(f);
  }

  const metadata = {};
  const resolution = {};
  for (const field of allFields) {
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const src = order[i];
      const m = provided[src];
      if (!m || !Object.prototype.hasOwnProperty.call(m, field)) continue;
      if (blocked.has(field) && src !== 'own') continue; // blocked → only own may supply it
      metadata[field] = deepClone(m[field]);
      resolution[field] = src;
      break;
    }
  }
  return { metadata, resolution };
}

module.exports = { inheritMetadata, DEFAULT_PRECEDENCE };
