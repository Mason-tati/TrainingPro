// WP-18 · E3 — BaseRepository for the Enterprise Document Engine.
//
// Thin, safe wrapper over an INJECTED sqlite3 connection (the callback API). It never
// opens the production DB, never imports database/db.js, Express, the request context,
// the logger, or any route. It only promisifies run/get/all and provides a guarded
// parameterized INSERT builder whose column names come from a fixed allow-list.
// UNWIRED — nothing in production consumes it.
'use strict';

class BaseRepository {
  constructor(db) {
    if (!db || typeof db.run !== 'function' || typeof db.get !== 'function' || typeof db.all !== 'function') {
      throw new Error('BaseRepository requires an injected sqlite3 database connection');
    }
    this.db = db;
  }

  // Promisified sqlite3 primitives. Errors are surfaced (never swallowed here).
  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function runCb(err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
    });
  }

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  // Build a parameterized INSERT. `table` and `allowed` are fixed literals from the
  // repository (never user input); values are bound, never concatenated. Input is not
  // mutated. Only keys present in `data` AND in `allowed` are inserted.
  _buildInsert(table, data, allowed) {
    const src = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    const cols = allowed.filter((c) => src[c] !== undefined);
    const params = cols.map((c) => src[c]);
    const placeholders = cols.map(() => '?').join(', ');
    return { sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, params };
  }
}

module.exports = BaseRepository;
