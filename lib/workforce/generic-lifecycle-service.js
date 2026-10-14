// EWP-01a — Enterprise Workforce Platform — Foundation Framework — Generic Lifecycle Service.
//
// The reusable business-orchestration shell for EVERY future Workforce entity. Wraps a generic lifecycle
// repository and provides the never-throw CRUD + lifecycle (archive/restore/soft-delete with the
// already-archived guard) + copy-on-read (parsed metadata) that every certified engine hand-copied 18
// times — defined ONCE. Entity-specific rules are supplied as pluggable validators (validateCreate /
// validateUpdate), keeping the distinctive logic per entity while the mechanical lifecycle is inherited.
// Stateless, deterministic (dates stamped by the repository/SQLite), never throws. UNWIRED.
'use strict';

const V = require('./shared-validation');

async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class GenericLifecycleService {
  // config = { resourceKey='record', collectionKey='records', validateCreate?(input), validateUpdate?(input,current) }
  constructor(repository, config) {
    if (!repository || typeof repository.create !== 'function' || typeof repository.findById !== 'function') {
      throw new Error('GenericLifecycleService requires a repository with create() and findById()');
    }
    const cfg = V.isPlainObject(config) ? config : {};
    this.repository = repository;
    this.resourceKey = typeof cfg.resourceKey === 'string' && cfg.resourceKey ? cfg.resourceKey : 'record';
    this.collectionKey = typeof cfg.collectionKey === 'string' && cfg.collectionKey ? cfg.collectionKey : 'records';
    this.validateCreate = typeof cfg.validateCreate === 'function' ? cfg.validateCreate : null;
    this.validateUpdate = typeof cfg.validateUpdate === 'function' ? cfg.validateUpdate : null;
    this.notFound = `${this.resourceKey} not found`;
  }

  _one(row) {
    return V.ok({ [this.resourceKey]: V.withMetadata(row) });
  }
  _many(rows) {
    return V.ok({ [this.collectionKey]: rows.map((r) => V.withMetadata(r)) });
  }

  // Fold a `metadata` object (if supplied) into the storage-shaped `metadataJson` column. A supplied
  // non-object metadata serializes to null (the repository allow-lists columns, so a raw `metadata`
  // field is otherwise ignored). Returns a fresh payload — copy-on-read, never mutates the input.
  _payload(src) {
    if (src.metadata === undefined) {
      return Object.assign({}, src);
    }
    return Object.assign({}, src, { metadataJson: V.toMetadataJson(src.metadata) });
  }

  create(input) {
    return execute(async () => {
      const src = V.isPlainObject(input) ? input : {};
      if (this.validateCreate) {
        const bad = await this.validateCreate(src);
        if (bad) return bad;
      }
      const row = await this.repository.create(this._payload(src));
      return this._one(row);
    });
  }

  update(id, patch) {
    return execute(async () => {
      const src = V.isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return V.invalid(this.notFound, 'NOT_FOUND');
      if (this.validateUpdate) {
        const bad = await this.validateUpdate(src, current);
        if (bad) return bad;
      }
      const row = await this.repository.update(id, this._payload(src));
      return this._one(row);
    });
  }

  get(id) {
    return execute(async () => {
      const row = await this.repository.findById(id);
      if (!row) return V.invalid(this.notFound, 'NOT_FOUND');
      return this._one(row);
    });
  }

  list(filters, scope) {
    return execute(async () => {
      const rows = await this.repository.findAll(filters, scope);
      return this._many(rows);
    });
  }

  listBy(column, value) {
    return execute(async () => {
      const rows = await this.repository.findBy(column, value);
      return this._many(rows);
    });
  }

  listActive() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return this._many(rows);
    });
  }

  archive(id) {
    return execute(async () => {
      const row = await this.repository.findById(id);
      if (!row) return V.invalid(this.notFound, 'NOT_FOUND');
      if (row.archived) return V.invalid(`${this.resourceKey} already archived`, 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return this._one(updated);
    });
  }

  remove(id) {
    return execute(async () => {
      const row = await this.repository.findById(id);
      if (!row) return V.invalid(this.notFound, 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restore(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return V.invalid(this.notFound, 'NOT_FOUND');
      await this.repository.restore(id);
      const row = await this.repository.findById(id);
      return this._one(row);
    });
  }
}

// Factory-based construction (the platform standard).
function createService(repository, config) {
  return new GenericLifecycleService(repository, config);
}

module.exports = { GenericLifecycleService, createService };
