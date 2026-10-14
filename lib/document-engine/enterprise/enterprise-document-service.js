// WP-26 · Phase 1 — Enterprise Document Engine Foundation — Service.
//
// Business orchestration over an INJECTED repository. It reuses the certified BaseService (DI
// contract validation) — no duplicated wiring. It enforces the WP-26 business rules (unique document
// numbers, automatic version handling, current-version enforcement, archive/soft-delete/metadata/
// security-classification/lifecycle validation) and contains NO controller/HTTP logic and NO SQL.
// Stateless, deterministic (timestamps are stamped by the repository/SQLite, never here),
// copy-on-read, and never-throw: every method resolves an explicit `{ ok, ... }` result. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByNumber', 'findAll', 'archive', 'softDelete', 'restore', 'exists', 'count'];
const SECURITY_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
const LIFECYCLE_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'SUPERSEDED', 'EXPIRED'];
// Fields a caller may set through updateDocument (archived/deleted are managed by dedicated methods).
const UPDATABLE_FIELDS = [
  'title', 'description', 'category', 'subCategory', 'documentType', 'versionMajor', 'versionMinor',
  'status', 'ownerId', 'approverId', 'securityClassification', 'language', 'approvedAt',
  'effectiveDate', 'reviewDate', 'expiryDate', 'supersededBy', 'currentVersion',
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

// Attach a best-effort parsed `metadata` object to a stored row (never throws on bad JSON).
function withMetadata(doc) {
  let metadata = null;
  try {
    metadata = doc.metadataJson ? JSON.parse(doc.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, doc, { metadata });
}

// Centralised never-throw executor — any unexpected error becomes an explicit negative result.
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentService extends BaseService {
  constructor(repository) {
    super(repository, REPOSITORY_METHODS);
  }

  // Create a document. Enforces required fields, unique number, lifecycle/classification/metadata
  // validation, and automatic version/current-version defaults.
  createDocument(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isNonEmptyString(src.title)) return invalid('title is required', 'VALIDATION');
      if (!isNonEmptyString(src.documentNumber)) return invalid('documentNumber is required', 'VALIDATION');
      const status = pick(src, 'status', 'DRAFT');
      if (!LIFECYCLE_STATUSES.includes(status)) return invalid('invalid status', 'VALIDATION');
      const securityClassification = pick(src, 'securityClassification', 'INTERNAL');
      if (!SECURITY_CLASSIFICATIONS.includes(securityClassification)) return invalid('invalid securityClassification', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');

      const existing = await this.repository.findByNumber(src.documentNumber);
      if (existing) return invalid('duplicate documentNumber', 'CONFLICT');

      const payload = {
        documentNumber: src.documentNumber,
        title: src.title,
        description: pick(src, 'description', null),
        category: pick(src, 'category', null),
        subCategory: pick(src, 'subCategory', null),
        documentType: pick(src, 'documentType', null),
        versionMajor: pick(src, 'versionMajor', 1),
        versionMinor: pick(src, 'versionMinor', 0),
        status,
        ownerId: pick(src, 'ownerId', null),
        approverId: pick(src, 'approverId', null),
        securityClassification,
        language: pick(src, 'language', 'en'),
        approvedAt: pick(src, 'approvedAt', null),
        effectiveDate: pick(src, 'effectiveDate', null),
        reviewDate: pick(src, 'reviewDate', null),
        expiryDate: pick(src, 'expiryDate', null),
        supersededBy: pick(src, 'supersededBy', null),
        currentVersion: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const document = await this.repository.create(payload);
      return { ok: true, document: withMetadata(document) };
    });
  }

  // Update mutable fields of a non-deleted document (validates lifecycle/classification/metadata).
  updateDocument(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('document not found', 'NOT_FOUND');
      if (src.status !== undefined && !LIFECYCLE_STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
      if (src.securityClassification !== undefined && !SECURITY_CLASSIFICATIONS.includes(src.securityClassification)) return invalid('invalid securityClassification', 'VALIDATION');
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

  listDocuments(filters) {
    return execute(async () => {
      const documents = await this.repository.findAll(filters);
      return { ok: true, documents: documents.map((d) => withMetadata(d)) };
    });
  }

  countDocuments(filters) {
    return execute(async () => {
      const count = await this.repository.count(filters);
      return { ok: true, count };
    });
  }

  // Archive validation: the document must exist (non-deleted) and not already be archived.
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

  // Soft-delete validation: the document must exist and not already be deleted (findById excludes deleted).
  deleteDocument(id) {
    return execute(async () => {
      const document = await this.repository.findById(id);
      if (!document) return invalid('document not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  // Restore a soft-deleted (or archived) document. `exists` ignores the deleted flag.
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

module.exports = EnterpriseDocumentService;
