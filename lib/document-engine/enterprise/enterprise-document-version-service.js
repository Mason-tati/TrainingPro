// WP-26 · Phase 4 — Enterprise Document Engine — Version Control — Service.
//
// Business orchestration over an INJECTED version repository (reusing the certified BaseService) plus
// a READ-ONLY injected WP-26 Phase 3 document-core repository (used only to validate that the parent
// document exists — never mutated). Enforces: document existence, version uniqueness, major/minor
// sequencing (a new version must exceed the latest), approval-status validation, and automatic
// supersede of the previous current version. The current version is the non-superseded one. NO
// controller/HTTP logic and NO SQL. Stateless, deterministic (timestamps stamped by the repository/
// SQLite), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByDocument', 'findCurrent', 'findVersion', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const APPROVAL_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED'];
// Content fields settable via updateVersion (version identity + documentId + supersededDate are managed elsewhere).
const UPDATABLE_FIELDS = [
  'changeSummary', 'authorId', 'approvalStatus', 'approvedBy', 'approvedDate', 'effectiveDate',
  'fileName', 'fileExtension', 'mimeType', 'fileSize', 'checksum', 'storagePath', 'active',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
// Strict version ordering: a > b iff its major is greater, or equal major with a greater minor.
function isGreaterVersion(a, b) {
  if (a.majorVersion > b.majorVersion) return true;
  if (a.majorVersion === b.majorVersion) return a.minorVersion > b.minorVersion;
  return false;
}
function withMetadata(version) {
  let metadata = null;
  try {
    metadata = version.metadataJson ? JSON.parse(version.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, version, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentVersionService extends BaseService {
  constructor(repository, documentRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!documentRepository || typeof documentRepository.findById !== 'function') {
      throw new Error('EnterpriseDocumentVersionService requires an injected document repository with findById()');
    }
    this.documentRepository = documentRepository;
  }

  // Create a new version. Validates the parent document, version uniqueness and sequencing, and the
  // approval status; the new version becomes current and supersedes the previous current version.
  createVersion(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (src.documentId === undefined || src.documentId === null) return invalid('documentId is required', 'VALIDATION');
      const document = await this.documentRepository.findById(src.documentId);
      if (!document) return invalid('document not found', 'VALIDATION');
      const majorVersion = pick(src, 'majorVersion', 1);
      if (!isPositiveInteger(majorVersion)) return invalid('majorVersion must be a positive integer', 'VALIDATION');
      const minorVersion = pick(src, 'minorVersion', 0);
      if (!isNonNegativeInteger(minorVersion)) return invalid('minorVersion must be a non-negative integer', 'VALIDATION');
      const approvalStatus = pick(src, 'approvalStatus', 'DRAFT');
      if (!APPROVAL_STATUSES.includes(approvalStatus)) return invalid('invalid approvalStatus', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');

      const versionNumber = `${majorVersion}.${minorVersion}`;
      if (await this.repository.findVersion(document.id, versionNumber)) return invalid('duplicate version', 'CONFLICT');

      const existing = await this.repository.findByDocument(document.id);
      if (existing.length > 0) {
        const latest = existing.reduce((max, v) => (isGreaterVersion(v, max) ? v : max), existing[0]);
        if (!isGreaterVersion({ majorVersion, minorVersion }, latest)) return invalid('version must be greater than the latest version', 'VALIDATION');
      }

      const payload = {
        documentId: document.id,
        majorVersion,
        minorVersion,
        versionNumber,
        changeSummary: pick(src, 'changeSummary', null),
        authorId: pick(src, 'authorId', null),
        approvalStatus,
        approvedBy: pick(src, 'approvedBy', null),
        approvedDate: pick(src, 'approvedDate', null),
        effectiveDate: pick(src, 'effectiveDate', null),
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
      const previousCurrent = await this.repository.findCurrent(document.id);
      const created = await this.repository.create(payload);
      if (previousCurrent) await this.repository.update(previousCurrent.id, { supersededDate: true, approvalStatus: 'SUPERSEDED' });
      return { ok: true, version: withMetadata(created) };
    });
  }

  updateVersion(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('version not found', 'NOT_FOUND');
      if (src.approvalStatus !== undefined && !APPROVAL_STATUSES.includes(src.approvalStatus)) return invalid('invalid approvalStatus', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const version = await this.repository.update(id, payload);
      return { ok: true, version: withMetadata(version) };
    });
  }

  getVersion(id) {
    return execute(async () => {
      const version = await this.repository.findById(id);
      if (!version) return invalid('version not found', 'NOT_FOUND');
      return { ok: true, version: withMetadata(version) };
    });
  }

  listVersions(documentId) {
    return execute(async () => {
      const versions = await this.repository.findByDocument(documentId);
      return { ok: true, versions: versions.map((v) => withMetadata(v)) };
    });
  }

  getCurrentVersion(documentId) {
    return execute(async () => {
      const version = await this.repository.findCurrent(documentId);
      if (!version) return invalid('no current version', 'NOT_FOUND');
      return { ok: true, version: withMetadata(version) };
    });
  }

  archiveVersion(id) {
    return execute(async () => {
      const version = await this.repository.findById(id);
      if (!version) return invalid('version not found', 'NOT_FOUND');
      if (version.archived) return invalid('version already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, version: withMetadata(updated) };
    });
  }

  deleteVersion(id) {
    return execute(async () => {
      const version = await this.repository.findById(id);
      if (!version) return invalid('version not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreVersion(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('version not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const version = await this.repository.findById(id);
      return { ok: true, version: withMetadata(version) };
    });
  }
}

module.exports = EnterpriseDocumentVersionService;
