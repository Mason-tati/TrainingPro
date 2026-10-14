// WP-18 · E5 — In-memory sequence manager (Enterprise Document Engine).
//
// Pure in-memory, namespaced counters. NO database, NO files, NO imports. Each namespace
// (e.g. 'SOP', 'WI', 'FORM') maintains an independent counter. The counter holds the
// last-issued value; the first number issued is `start + step` (default 1). UNWIRED.
'use strict';

class SequenceManager {
  // options: { start = 0 (initial last-issued value), step = 1 (increment per issue) }
  constructor(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    this._start = (Number.isInteger(opts.start) && opts.start >= 0) ? opts.start : 0;
    this._step = (Number.isInteger(opts.step) && opts.step > 0) ? opts.step : 1;
    this._counters = new Map();
  }

  _key(namespace) {
    if (typeof namespace !== 'string' || namespace.trim() === '') {
      throw new Error('sequence namespace must be a non-empty string');
    }
    return namespace;
  }

  _current(namespace) {
    return this._counters.has(namespace) ? this._counters.get(namespace) : this._start;
  }

  // Advance by the configured step and return the newly-issued value.
  getNextSequence(namespace) {
    const ns = this._key(namespace);
    const next = this._current(ns) + this._step;
    this._counters.set(ns, next);
    return next;
  }

  // The value the next getNextSequence() would return — WITHOUT advancing.
  peekSequence(namespace) {
    const ns = this._key(namespace);
    return this._current(ns) + this._step;
  }

  // Reset the namespace to its initial state (next issued value returns to start + step).
  resetSequence(namespace) {
    const ns = this._key(namespace);
    this._counters.set(ns, this._start);
    return this._start;
  }

  // Force the last-issued value; the next issued number becomes value + step.
  setSequence(namespace, value) {
    const ns = this._key(namespace);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('sequence value must be a non-negative integer');
    }
    this._counters.set(ns, value);
    return value;
  }

  // Advance the counter by an arbitrary positive amount and return the new value.
  increment(namespace, by) {
    const ns = this._key(namespace);
    const amount = (by === undefined) ? this._step : by;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('increment amount must be a positive integer');
    }
    const next = this._current(ns) + amount;
    this._counters.set(ns, next);
    return next;
  }
}

module.exports = SequenceManager;
