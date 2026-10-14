// WP-26 · Phase 2 — Enterprise Document Engine — Folder Management — Service.
//
// Business orchestration over an INJECTED folder repository, reusing the certified BaseService. It
// enforces the WP-26 Phase 2 folder rules: unlimited hierarchy, unique folder numbers, unique folder
// paths, circular-reference prevention, deterministic path generation + depth calculation, security
// inheritance, and metadata/retention/archive/soft-delete/restore/move validation. NO controller/HTTP
// logic and NO SQL. Stateless, deterministic (timestamps stamped by the repository/SQLite), never-
// throw (every method resolves an explicit { ok, ... } result), copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findChildren', 'findByPath', 'findRootFolders', 'moveFolder', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const SECURITY_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const RETENTION_CATEGORIES = ['NONE', 'SHORT', 'STANDARD', 'LONG', 'PERMANENT'];
// Content fields settable via updateFolder (folderName + structural fields are managed elsewhere).
const UPDATABLE_FIELDS = [
  'description', 'category', 'subCategory', 'department', 'site', 'businessUnit',
  'securityClassification', 'ownerId', 'sortOrder', 'retentionCategory', 'active',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(folder) {
  let metadata = null;
  try {
    metadata = folder.metadataJson ? JSON.parse(folder.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, folder, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseFolderService extends BaseService {
  constructor(repository) {
    super(repository, REPOSITORY_METHODS);
  }

  // Create a folder anywhere in the hierarchy. Generates folderPath/folderDepth, inherits security
  // from the parent, and enforces unique number + unique path.
  createFolder(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isNonEmptyString(src.folderName)) return invalid('folderName is required', 'VALIDATION');
      if (!isNonEmptyString(src.folderNumber)) return invalid('folderNumber is required', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const retentionCategory = pick(src, 'retentionCategory', 'STANDARD');
      if (!RETENTION_CATEGORIES.includes(retentionCategory)) return invalid('invalid retentionCategory', 'VALIDATION');

      if (await this.repository.count({ folderNumber: src.folderNumber }) > 0) return invalid('duplicate folderNumber', 'CONFLICT');

      let parentFolderId = null;
      let basePath = '';
      let folderDepth = 0;
      let inheritedSecurity = 'INTERNAL';
      if (src.parentFolderId !== undefined && src.parentFolderId !== null) {
        const parent = await this.repository.findById(src.parentFolderId);
        if (!parent) return invalid('parent folder not found', 'VALIDATION');
        parentFolderId = parent.id;
        basePath = parent.folderPath;
        folderDepth = parent.folderDepth + 1;
        inheritedSecurity = parent.securityClassification;
      }

      const securityClassification = src.securityClassification !== undefined ? src.securityClassification : inheritedSecurity;
      if (!SECURITY_CLASSIFICATIONS.includes(securityClassification)) return invalid('invalid securityClassification', 'VALIDATION');

      const folderPath = `${basePath}/${src.folderName}`;
      if (await this.repository.findByPath(folderPath)) return invalid('duplicate folderPath', 'CONFLICT');

      const payload = {
        parentFolderId,
        folderNumber: src.folderNumber,
        folderName: src.folderName,
        description: pick(src, 'description', null),
        category: pick(src, 'category', null),
        subCategory: pick(src, 'subCategory', null),
        department: pick(src, 'department', null),
        site: pick(src, 'site', null),
        businessUnit: pick(src, 'businessUnit', null),
        securityClassification,
        ownerId: pick(src, 'ownerId', null),
        folderPath,
        folderDepth,
        sortOrder: pick(src, 'sortOrder', 0),
        retentionCategory,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const folder = await this.repository.create(payload);
      return { ok: true, folder: withMetadata(folder) };
    });
  }

  // Update content fields of a folder (folderName + structural fields are immutable here).
  updateFolder(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('folder not found', 'NOT_FOUND');
      if (src.securityClassification !== undefined && !SECURITY_CLASSIFICATIONS.includes(src.securityClassification)) return invalid('invalid securityClassification', 'VALIDATION');
      if (src.retentionCategory !== undefined && !RETENTION_CATEGORIES.includes(src.retentionCategory)) return invalid('invalid retentionCategory', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const folder = await this.repository.update(id, payload);
      return { ok: true, folder: withMetadata(folder) };
    });
  }

  getFolder(id) {
    return execute(async () => {
      const folder = await this.repository.findById(id);
      if (!folder) return invalid('folder not found', 'NOT_FOUND');
      return { ok: true, folder: withMetadata(folder) };
    });
  }

  listRootFolders() {
    return execute(async () => {
      const folders = await this.repository.findRootFolders();
      return { ok: true, folders: folders.map((f) => withMetadata(f)) };
    });
  }

  listChildren(parentFolderId) {
    return execute(async () => {
      const folders = await this.repository.findChildren(parentFolderId);
      return { ok: true, folders: folders.map((f) => withMetadata(f)) };
    });
  }

  // Move a folder (and its whole subtree) under a new parent (null → root). Prevents circular
  // references and duplicate paths; recomputes path/depth for the folder and every descendant.
  moveFolder(id, newParentId) {
    return execute(async () => {
      const folder = await this.repository.findById(id);
      if (!folder) return invalid('folder not found', 'NOT_FOUND');

      let parentFolderId = null;
      let basePath = '';
      let folderDepth = 0;
      if (newParentId !== undefined && newParentId !== null) {
        if (newParentId === id) return invalid('cannot move a folder into itself', 'VALIDATION');
        const parent = await this.repository.findById(newParentId);
        if (!parent) return invalid('target parent not found', 'VALIDATION');
        let ancestorId = parent.parentFolderId;
        while (ancestorId !== null) {
          if (ancestorId === id) return invalid('circular parent reference', 'VALIDATION');
          const ancestor = await this.repository.findById(ancestorId);
          ancestorId = ancestor.parentFolderId;
        }
        parentFolderId = parent.id;
        basePath = parent.folderPath;
        folderDepth = parent.folderDepth + 1;
      }

      const folderPath = `${basePath}/${folder.folderName}`;
      const clash = await this.repository.findByPath(folderPath);
      if (clash && clash.id !== id) return invalid('duplicate folderPath', 'CONFLICT');

      const moved = await this.repository.moveFolder(id, { parentFolderId, folderPath, folderDepth });
      await this._cascade(moved);
      const result = await this.repository.findById(id);
      return { ok: true, folder: withMetadata(result) };
    });
  }

  // Recompute path/depth for every descendant of a moved folder (parent linkage is unchanged).
  async _cascade(folder) {
    const children = await this.repository.findChildren(folder.id);
    for (const child of children) {
      const childPath = `${folder.folderPath}/${child.folderName}`;
      const childDepth = folder.folderDepth + 1;
      const updated = await this.repository.moveFolder(child.id, { parentFolderId: child.parentFolderId, folderPath: childPath, folderDepth: childDepth });
      await this._cascade(updated);
    }
  }

  archiveFolder(id) {
    return execute(async () => {
      const folder = await this.repository.findById(id);
      if (!folder) return invalid('folder not found', 'NOT_FOUND');
      if (folder.archived) return invalid('folder already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, folder: withMetadata(updated) };
    });
  }

  // Soft-delete validation: the folder must exist and must be empty (no non-deleted children).
  deleteFolder(id) {
    return execute(async () => {
      const folder = await this.repository.findById(id);
      if (!folder) return invalid('folder not found', 'NOT_FOUND');
      const children = await this.repository.findChildren(id);
      if (children.length > 0) return invalid('folder is not empty', 'VALIDATION');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreFolder(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('folder not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const folder = await this.repository.findById(id);
      return { ok: true, folder: withMetadata(folder) };
    });
  }
}

module.exports = EnterpriseFolderService;
