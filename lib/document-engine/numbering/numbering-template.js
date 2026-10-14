// WP-18 · E5 — Numbering template engine (Enterprise Document Engine).
//
// Pure, dependency-free template parser + renderer for document-number templates.
// A template is a string mixing literal text (any separators) with {TOKEN} placeholders.
// Everything here NEVER throws and NEVER mutates its inputs. It imports nothing —
// no database, no Express, no routes, no services, no repositories. UNWIRED.
'use strict';

// The complete, fixed set of supported tokens. Frozen so callers cannot mutate it.
const TOKENS = Object.freeze(['SITE', 'DEPARTMENT', 'TYPE', 'YEAR', 'MONTH', 'DAY', 'SEQUENCE', 'REVISION']);
const TOKEN_SET = new Set(TOKENS);

function isSupportedToken(name) {
  return typeof name === 'string' && TOKEN_SET.has(name);
}

// Parse a template into ordered parts. Returns a plain result object (never throws):
//   { valid, errors:[], parts:[{type:'literal'|'token', value}], tokens:[...] }
// Rules: braces must balance; token names must be supported; a token may appear at most
// once (duplicates prohibited); the template MUST contain exactly the {SEQUENCE} token.
function parseTemplate(template) {
  const errors = [];
  const parts = [];
  const tokens = [];
  if (typeof template !== 'string' || template.length === 0) {
    return { valid: false, errors: ['template must be a non-empty string'], parts: [], tokens: [] };
  }
  const seen = new Set();
  let literal = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{') {
      if (literal !== '') { parts.push({ type: 'literal', value: literal }); literal = ''; }
      const close = template.indexOf('}', i + 1);
      if (close === -1) { errors.push('unterminated token: missing "}"'); literal = ''; break; }
      const name = template.slice(i + 1, close);
      if (name === '') {
        errors.push('empty token "{}"');
      } else if (!TOKEN_SET.has(name)) {
        errors.push(`invalid token "{${name}}"`);
      } else if (seen.has(name)) {
        errors.push(`duplicate token "{${name}}"`);
      } else {
        seen.add(name);
        tokens.push(name);
        parts.push({ type: 'token', value: name });
      }
      i = close + 1;
    } else if (ch === '}') {
      errors.push('unexpected "}" without matching "{"');
      i += 1;
    } else {
      literal += ch;
      i += 1;
    }
  }
  if (literal !== '') { parts.push({ type: 'literal', value: literal }); }
  if (!seen.has('SEQUENCE')) { errors.push('template must contain the {SEQUENCE} token'); }
  return { valid: errors.length === 0, errors, parts, tokens };
}

// Render parsed parts against a values map. Missing/undefined/null token values render as
// an empty string. Never throws, never mutates `values`.
function renderParts(parts, values) {
  const v = (values && typeof values === 'object') ? values : {};
  let out = '';
  for (const part of parts) {
    if (part.type === 'literal') {
      out += part.value;
    } else {
      const val = v[part.value];
      out += (val === undefined || val === null) ? '' : String(val);
    }
  }
  return out;
}

module.exports = { TOKENS, isSupportedToken, parseTemplate, renderParts };
