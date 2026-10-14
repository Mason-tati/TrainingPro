// WP-26 · Phase 3 — Enterprise Document Engine — Document Core — Service.
//
// Business orchestration over an INJECTED document-core repository (reusing the certified BaseService)
// plus a READ-ONLY injected WP-26 Phase 2 folder repository (used only for folder existence
// validation and security/retention inheritance — never mutated). Enforces the WP-26 Phase 3 rules:
// unique document numbers, revision/status validation, folder existence validation, security &
// retention inheritance from the folder, and metadata/search/archive/restore/delete validation. NO
// controller/HTTP logic and NO SQL. Stateless, deterministic (timestamps stamped by the repository/
// SQLite), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByNumber', 'findByFolder', 'findByStatus', 'search', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const SECURITY_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const RETENTION_CATEGORIES = ['NONE', 'SHORT', 'STANDARD', 'LONG', 'PERMANENT'];
const STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'SUPERSEDED', 'EXPIRED', 'OBSOLETE'];
// Content fields settable via updateDocument (documentNumber/id/timestamps + folderId are managed elsewhere).
const UPDATABLE_FIELDS = [
  'documentTitle', 'documentType', 'revision', 'status', 'description', 'keywords', 'ownerId',
  'department', 'site', 'businessUnit', 'securityClassification', 'retentionCategory',
  'effectiveDate', 'reviewDate', 'expiryDate', 'language', 'fileName', 'fileExtension', 'mimeType',
  'fileSize', 'checksum', 'storagePath', 'active',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(doc) {
  let metadata = null;
  try {
    metadata = doc.metadataJson ? JSON.parse(doc.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, doc, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentCoreService extends BaseService {
  constructor(repository, folderRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!folderRepository || typeof folderRepository.findById !== 'function') {
      throw new Error('EnterpriseDocumentCoreService requires an injected folder repository with findById()');
    }
    this.folderRepository = folderRepository;
  }

  createDocument(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isNonEmptyString(src.documentTitle)) return invalid('documentTitle is required', 'VALIDATION');
      if (!isNonEmptyString(src.documentNumber)) return invalid('documentNumber is required', 'VALIDATION');
      const revision = pick(src, 'revision', 1);
      if (!isPositiveInteger(revision)) return invalid('revision must be a positive integer', 'VALIDATION');
      const status = pick(src, 'status', 'DRAFT');
      if (!STATUSES.includes(status)) return invalid('invalid status', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');

      if (await this.repository.findByNumber(src.documentNumber)) return invalid('duplicate documentNumber', 'CONFLICT');

      let folderId = null;
      let inheritedSecurity = 'INTERNAL';
      let inheritedRetention = 'STANDARD';
      if (src.folderId !== undefined && src.folderId !== null) {
        const folder = await this.folderRepository.findById(src.folderId);
        if (!folder) return invalid('folder not found', 'VALIDATION');
        folderId = folder.id;
        inheritedSecurity = folder.securityClassification;
        inheritedRetention = folder.retentionCategory;
      }

      const securityClassification = src.securityClassification !== undefined ? src.securityClassification : inheritedSecurity;
      if (!SECURITY_CLASSIFICATIONS.includes(securityClassification)) return invalid('invalid securityClassification', 'VALIDATION');
      const retentionCategory = src.retentionCategory !== undefined ? src.retentionCategory : inheritedRetention;
      if (!RETENTION_CATEGORIES.includes(retentionCategory)) return invalid('invalid retentionCategory', 'VALIDATION');

      const payload = {
        folderId,
        documentNumber: src.documentNumber,
        documentTitle: src.documentTitle,
        documentType: pick(src, 'documentType', null),
        revision,
        status,
        description: pick(src, 'description', null),
        keywords: pick(src, 'keywords', null),
        ownerId: pick(src, 'ownerId', null),
        department: pick(src, 'department', null),
        site: pick(src, 'site', null),
        businessUnit: pick(src, 'businessUnit', null),
        securityClassification,
        retentionCategory,
        effectiveDate: pick(src, 'effectiveDate', null),
        reviewDate: pick(src, 'reviewDate', null),
        expiryDate: pick(src, 'expiryDate', null),
        language: pick(src, 'language', 'en'),
        fileName: pick(src, 'fileName', null),
        fileExtension: pick(src, 'fileExtension', null),
        mimeType: pick(src, 'mimeType', null),
        fileSize: pick(src, 'fileSize', null),
        checksum: pick(src, 'checksum', null),
        storagePath: pick(src, 'storagePath', null),
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const document = await this.repository.create(payload);
      return { ok: true, document: withMetadata(document) };
    });
  }

  updateDocument(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('document not found', 'NOT_FOUND');
      if (src.revision !== undefined && !isPositiveInteger(src.revision)) return invalid('revision must be a positive integer', 'VALIDATION');
      if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
      if (src.securityClassification !== undefined && !SECURITY_CLASSIFICATIONS.includes(src.securityClassification)) return invalid('invalid securityClassification', 'VALIDATION');
      if (src.retentionCategory !== undefined && !RETENTION_CATEGORIES.includes(src.retentionCategory)) return invalid('invalid retentionCategory', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const document = await this.repository.update(id, payload);
      return { ok: true, document: withMetadata(document) };
    });
  }

  getDocument(id) {
    return execute(async () => {
      const document = await this.repository.findById(id);
      if (!document) return invalid('document not found', 'NOT_FOUND');
      return { ok: true, document: withMetadata(document) };
    });
  }

  listFolderDocuments(folderId) {
    return execute(async () => {
      const documents = await this.repository.findByFolder(folderId);
      return { ok: true, documents: documents.map((d) => withMetadata(d)) };
    });
  }

  // Allow-listed search (repository ignores unknown criteria); a provided status is validated.
  searchDocuments(criteria) {
    return execute(async () => {
      const src = isPlainObject(criteria) ? criteria : {};
      if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
      const documents = await this.repository.search(src);
      return { ok: true, documents: documents.map((d) => withMetadata(d)) };
    });
  }

  archiveDocument(id) {
    return execute(async () => {
      const document = await this.repository.findById(id);
      if (!document) return invalid('document not found', 'NOT_FOUND');
      if (document.archived) return invalid('document already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, document: withMetadata(updated) };
    });
  }

  deleteDocument(id) {
    return execute(async () => {
      const document = await this.repository.findById(id);
      if (!document) return invalid('document not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreDocument(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('document not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const document = await this.repository.findById(id);
      return { ok: true, document: withMetadata(document) };
    });
  }
}

module.exports = EnterpriseDocumentCoreService;
