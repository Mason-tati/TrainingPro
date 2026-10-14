// EWP-01b — Enterprise Workforce Platform — Reference & Organisation — Service.
//
// Business orchestration over the organisation repository-registry. CRUD for each of the eight levels is
// delegated to a per-level EWP-01a generic-lifecycle-service (never-throw, copy-on-read reused, NOT
// re-implemented); this service adds ONLY the cross-level hierarchy: parent/children, ancestors/
// descendants, tree, breadcrumb, and lookup. Organisation rules (code/name required, duplicate code,
// duplicate name, parent existence in the immediate parent level) are supplied to the generic services as
// pluggable validators. Circular references are structurally impossible: the strict typed level chain
// means a node's parent is always a different, higher level, enforced by immediate-parent validation —
// so hierarchy walks are bounded by the finite chain and need no cycle bookkeeping. The uuid generator is
// dependency-injected (default node:crypto.randomUUID) so tests are deterministic. Never-throw,
// deterministic (given the injected uuid), copy-on-read. UNWIRED.
'use strict';

const { randomUUID } = require('node:crypto');
const { createService } = require('../generic-lifecycle-service');
const { LEVELS } = require('./organisation-migration');
const V = require('../shared-validation');

async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class OrganisationService {
  constructor(registry, options) {
    if (!registry || typeof registry.get !== 'function') {
      throw new Error('OrganisationService requires an organisation repository-registry');
    }
    const opts = V.isPlainObject(options) ? options : {};
    this.registry = registry;
    this.uuidFn = typeof opts.uuid === 'function' ? opts.uuid : randomUUID;
    this._byName = new Map(LEVELS.map((L) => [L.level, L]));
    this._services = new Map();
    for (const L of LEVELS) {
      this._services.set(L.level, createService(registry.get(L.level), {
        resourceKey: 'node',
        collectionKey: 'nodes',
        validateCreate: this._mkCreateValidator(L),
        validateUpdate: this._mkUpdateValidator(L),
      }));
    }
  }

  // ---- level helpers ----
  _known(level) { return this._byName.has(level); }
  _parentLevel(level) { const L = this._byName.get(level); return L ? L.parent : undefined; }
  _childLevel(level) { const child = LEVELS.find((L) => L.parent === level); return child ? child.level : null; }
  _repo(level) { return this.registry.get(level); }
  _crumb(level, node) { return { level, id: node.id, uuid: node.uuid, code: node.code, name: node.name }; }

  // ---- pluggable validators for the generic services ----
  _mkCreateValidator(L) {
    const repo = this.registry.get(L.level);
    const parentRepo = L.parent ? this.registry.get(L.parent) : null;
    return async (input) => {
      if (!V.isNonEmptyString(input.code)) return V.invalid('code is required');
      if (!V.isNonEmptyString(input.name)) return V.invalid('name is required');
      if ((await repo.findBy('code', input.code)).length) return V.invalid('code already exists', 'CONFLICT');
      if ((await repo.findBy('name', input.name)).length) return V.invalid('name already exists', 'CONFLICT');
      if (parentRepo === null) {
        if (input.parentId !== undefined && input.parentId !== null) return V.invalid('root level cannot have a parent');
      } else {
        if (!V.isPositiveInteger(input.parentId)) return V.invalid('parentId is required');
        if (!(await parentRepo.findById(input.parentId))) return V.invalid('parent not found');
      }
      return null;
    };
  }

  _mkUpdateValidator(L) {
    const repo = this.registry.get(L.level);
    const parentRepo = L.parent ? this.registry.get(L.parent) : null;
    return async (patch, current) => {
      if (patch.code !== undefined) {
        if (!V.isNonEmptyString(patch.code)) return V.invalid('code must be a non-empty string');
        if ((await repo.findBy('code', patch.code)).some((r) => r.id !== current.id)) return V.invalid('code already exists', 'CONFLICT');
      }
      if (patch.name !== undefined) {
        if (!V.isNonEmptyString(patch.name)) return V.invalid('name must be a non-empty string');
        if ((await repo.findBy('name', patch.name)).some((r) => r.id !== current.id)) return V.invalid('name already exists', 'CONFLICT');
      }
      if (patch.parentId !== undefined) {
        if (parentRepo === null) {
          if (patch.parentId !== null) return V.invalid('root level cannot have a parent');
        } else {
          if (!V.isPositiveInteger(patch.parentId)) return V.invalid('parentId must be a positive integer');
          if (!(await parentRepo.findById(patch.parentId))) return V.invalid('parent not found');
        }
      }
      return null;
    };
  }

  // ---- CRUD (delegated to the per-level generic service; uuid is server-generated) ----
  createNode(level, input) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    const src = V.isPlainObject(input) ? input : {};
    return this._services.get(level).create(Object.assign({}, src, { uuid: this.uuidFn() }));
  }
  updateNode(level, id, patch) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return this._services.get(level).update(id, patch);
  }
  getNode(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return this._services.get(level).get(id);
  }
  listLevel(level, filters) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return this._services.get(level).list(filters);
  }
  archiveNode(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return this._services.get(level).archive(id);
  }
  restoreNode(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return this._services.get(level).restore(id);
  }
  removeNode(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return this._services.get(level).remove(id);
  }

  // ---- hierarchy (cross-level) ----
  children(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return execute(async () => {
      const node = await this._repo(level).findById(id);
      if (!node) return V.invalid('node not found', 'NOT_FOUND');
      const child = this._childLevel(level);
      if (!child) return V.ok({ level: null, nodes: [] });
      const rows = await this._repo(child).findBy('parentId', id);
      return V.ok({ level: child, nodes: rows.map((r) => V.withMetadata(r)) });
    });
  }

  parent(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return execute(async () => {
      const node = await this._repo(level).findById(id);
      if (!node) return V.invalid('node not found', 'NOT_FOUND');
      const pLevel = this._parentLevel(level);
      if (pLevel === null || !V.isPositiveInteger(node.parentId)) return V.ok({ level: null, parent: null });
      const parentRow = await this._repo(pLevel).findById(node.parentId);
      return V.ok({ level: pLevel, parent: parentRow ? V.withMetadata(parentRow) : null });
    });
  }

  // The ordered chain of ancestor crumbs from root down to (but excluding) the given node.
  async _ancestorList(level, node) {
    const chain = [];
    let curLevel = level;
    let cur = node;
    let pLevel = this._parentLevel(curLevel);
    while (pLevel !== null && V.isPositiveInteger(cur.parentId)) {
      const parentRow = await this._repo(pLevel).findById(cur.parentId);
      if (!parentRow) break;
      chain.unshift(this._crumb(pLevel, parentRow));
      curLevel = pLevel;
      cur = parentRow;
      pLevel = this._parentLevel(curLevel);
    }
    return chain;
  }

  ancestors(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return execute(async () => {
      const node = await this._repo(level).findById(id);
      if (!node) return V.invalid('node not found', 'NOT_FOUND');
      return V.ok({ ancestors: await this._ancestorList(level, node) });
    });
  }

  breadcrumb(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return execute(async () => {
      const node = await this._repo(level).findById(id);
      if (!node) return V.invalid('node not found', 'NOT_FOUND');
      const trail = (await this._ancestorList(level, node)).concat([this._crumb(level, node)]);
      return V.ok({ breadcrumb: trail });
    });
  }

  async _gather(level, id, acc) {
    const child = this._childLevel(level);
    if (!child) return;
    const rows = await this._repo(child).findBy('parentId', id);
    for (const r of rows) {
      acc.push(this._crumb(child, r));
      await this._gather(child, r.id, acc);
    }
  }

  descendants(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return execute(async () => {
      const node = await this._repo(level).findById(id);
      if (!node) return V.invalid('node not found', 'NOT_FOUND');
      const flat = [];
      await this._gather(level, id, flat);
      return V.ok({ descendants: flat });
    });
  }

  async _buildTree(level, id) {
    const node = await this._repo(level).findById(id);
    if (!node) return null;
    const child = this._childLevel(level);
    const children = [];
    if (child) {
      const rows = await this._repo(child).findBy('parentId', id);
      for (const r of rows) children.push(await this._buildTree(child, r.id));
    }
    return { level, id: node.id, uuid: node.uuid, code: node.code, name: node.name, children };
  }

  tree(level, id) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return execute(async () => {
      const built = await this._buildTree(level, id);
      if (!built) return V.invalid('node not found', 'NOT_FOUND');
      return V.ok({ tree: built });
    });
  }

  lookupByCode(level, code) {
    if (!this._known(level)) return Promise.resolve(V.invalid('unknown level'));
    return execute(async () => {
      if (!V.isNonEmptyString(code)) return V.invalid('code is required');
      const rows = await this._repo(level).findBy('code', code);
      if (!rows.length) return V.invalid('node not found', 'NOT_FOUND');
      return V.ok({ node: V.withMetadata(rows[0]) });
    });
  }

  // The full organisation forest: a tree per top-level Company.
  hierarchy() {
    return execute(async () => {
      const roots = await this._repo('COMPANY').findActive();
      const trees = [];
      for (const r of roots) trees.push(await this._buildTree('COMPANY', r.id));
      return V.ok({ hierarchy: trees });
    });
  }
}

function createOrganisationService(registry, options) {
  return new OrganisationService(registry, options);
}

module.exports = { OrganisationService, createOrganisationService };
