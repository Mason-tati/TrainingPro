// WP-18 · E5 — Document number generator (Enterprise Document Engine).
//
// Deterministic, configurable document-number generation over the template engine and the
// in-memory sequence manager. Date tokens (YEAR/MONTH/DAY) are supplied by the caller —
// the generator never reads the system clock — so output is fully deterministic and the
// PUBLIC methods (generate/preview/validate/parse/normalize) NEVER throw. Configuration and
// caller context are copied, never mutated. Imports only its sibling numbering modules —
// no database, no Express, no routes, no services, no repositories. UNWIRED.
'use strict';

const SequenceManager = require('./sequence-manager');
const { parseTemplate, renderParts } = require('./numbering-template');

// Escape a literal for safe inclusion in a RegExp.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

// Regex fragments used to parse a formatted number back into its tokens.
const TOKEN_PATTERNS = {
  SITE: '([A-Za-z0-9]+)',
  DEPARTMENT: '([A-Za-z0-9]+)',
  TYPE: '([A-Za-z0-9]+)',
  YEAR: '(\\d{1,4})',
  MONTH: '(\\d{1,2})',
  DAY: '(\\d{1,2})',
  SEQUENCE: '(\\d+)',
  REVISION: '([A-Za-z0-9]+)',
};

class DocumentNumberGenerator {
  constructor(config) {
    const cfg = (config && typeof config === 'object') ? config : {};
    this._config = Object.assign({}, cfg); // copy — the caller's object is never mutated
    this._template = (typeof cfg.template === 'string') ? cfg.template : '';
    this._parsed = parseTemplate(this._template);
    this._prefix = (typeof cfg.prefix === 'string') ? cfg.prefix : '';
    this._suffix = (typeof cfg.suffix === 'string') ? cfg.suffix : '';
    this._padWidth = (Number.isInteger(cfg.padWidth) && cfg.padWidth >= 0) ? cfg.padWidth : 6;
    this._minWidth = (Number.isInteger(cfg.minWidth) && cfg.minWidth >= 0) ? cfg.minWidth : 0;
    this._width = Math.max(this._padWidth, this._minWidth);
    this._revWidth = (Number.isInteger(cfg.revisionWidth) && cfg.revisionWidth >= 0) ? cfg.revisionWidth : 2;
    this._strict = (cfg.strict === undefined) ? true : Boolean(cfg.strict);
    this._namespace = (typeof cfg.namespace === 'string' && cfg.namespace.trim() !== '') ? cfg.namespace : 'DEFAULT';
    const injected = cfg.sequenceManager;
    const usable = injected && typeof injected.getNextSequence === 'function' && typeof injected.peekSequence === 'function';
    this._seq = usable ? injected : new SequenceManager({
      start: Number.isInteger(cfg.start) ? cfg.start : 0,
      step: Number.isInteger(cfg.step) ? cfg.step : 1,
    });
  }

  _pad(value) {
    return String(value).padStart(this._width, '0');
  }

  // Resolve non-sequence token values from the caller context (accepts UPPER or lower keys).
  _resolveValues(ctx) {
    const values = {};
    const pick = (...keys) => {
      for (const k of keys) {
        if (ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== '') return ctx[k];
      }
      return undefined;
    };
    const site = pick('SITE', 'site'); if (site !== undefined) values.SITE = String(site);
    const dept = pick('DEPARTMENT', 'department', 'dept'); if (dept !== undefined) values.DEPARTMENT = String(dept);
    const type = pick('TYPE', 'type'); if (type !== undefined) values.TYPE = String(type);
    const year = pick('YEAR', 'year'); if (year !== undefined) values.YEAR = String(year);
    const month = pick('MONTH', 'month'); if (month !== undefined) values.MONTH = String(month).padStart(2, '0');
    const day = pick('DAY', 'day'); if (day !== undefined) values.DAY = String(day).padStart(2, '0');
    const rev = pick('REVISION', 'revision', 'rev');
    if (rev !== undefined) values.REVISION = /^\d+$/.test(String(rev)) ? String(rev).padStart(this._revWidth, '0') : String(rev);
    return values;
  }

  _fail(errors) {
    return { ok: false, number: null, sequence: null, template: this._template, errors };
  }

  _produce(context, consume) {
    if (!this._parsed.valid) return this._fail(this._parsed.errors.slice());
    const ctx = (context && typeof context === 'object') ? context : {};
    const values = this._resolveValues(ctx);
    if (this._strict) {
      const missing = this._parsed.tokens.filter((t) => t !== 'SEQUENCE' && values[t] === undefined);
      if (missing.length > 0) return this._fail(missing.map((t) => `missing value for {${t}}`));
    }
    let sequence;
    try {
      sequence = consume ? this._seq.getNextSequence(this._namespace) : this._seq.peekSequence(this._namespace);
    } catch (err) {
      return this._fail([(err && err.message) ? err.message : 'sequence error']);
    }
    values.SEQUENCE = this._pad(sequence);
    const body = renderParts(this._parsed.parts, values);
    return { ok: true, number: this._prefix + body + this._suffix, sequence, template: this._template, errors: [] };
  }

  // Produce the next number, CONSUMING a sequence value. Never throws.
  generate(context) {
    return this._produce(context, true);
  }

  // Produce what the next number WOULD be, without consuming a sequence value. Never throws.
  preview(context) {
    return this._produce(context, false);
  }

  // Validate a template (the generator's own by default, or one passed in). Never throws.
  validate(template) {
    const parsed = (template === undefined) ? this._parsed : parseTemplate(template);
    return { valid: parsed.valid, errors: parsed.errors.slice() };
  }

  _buildParsePattern() {
    let pattern = '^';
    for (const part of this._parsed.parts) {
      pattern += (part.type === 'literal') ? escapeRegExp(part.value) : TOKEN_PATTERNS[part.value];
    }
    pattern += '$';
    return new RegExp(pattern);
  }

  // Parse a formatted number back into its tokens. Never throws.
  parse(input) {
    const raw = String(input === undefined || input === null ? '' : input);
    if (!this._parsed.valid) return { ok: false, tokens: {}, sequence: null, raw, errors: this._parsed.errors.slice() };
    let core = raw;
    if (this._prefix !== '' && core.startsWith(this._prefix)) core = core.slice(this._prefix.length);
    if (this._suffix !== '' && core.endsWith(this._suffix)) core = core.slice(0, core.length - this._suffix.length);
    const match = core.match(this._buildParsePattern());
    if (!match) return { ok: false, tokens: {}, sequence: null, raw, errors: ['input does not match template'] };
    const tokens = {};
    this._parsed.tokens.forEach((name, idx) => { tokens[name] = match[idx + 1]; });
    return { ok: true, tokens, sequence: Number(tokens.SEQUENCE), raw, errors: [] };
  }

  // Canonicalize a number: trim, upper-case, strip whitespace, re-pad the sequence. Never throws.
  normalize(input) {
    const cleaned = String(input === undefined || input === null ? '' : input).trim().toUpperCase().replace(/\s+/g, '');
    const parsed = this.parse(cleaned);
    if (!parsed.ok) return cleaned;
    const values = Object.assign({}, parsed.tokens, { SEQUENCE: this._pad(parsed.sequence) });
    return this._prefix.toUpperCase() + renderParts(this._parsed.parts, values) + this._suffix.toUpperCase();
  }
}

module.exports = DocumentNumberGenerator;
