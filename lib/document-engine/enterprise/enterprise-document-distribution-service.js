// WP-26 · Phase 6 — Enterprise Document Engine — Distribution — Service.
//
// Business orchestration over an INJECTED distribution repository (reusing the certified BaseService)
// plus a READ-ONLY injected WP-26 Phase 4 document-version repository (used only to validate the
// distributed version exists — never mutated). Enforces: version existence, recipient (user or
// group) validation, mandatory-read validation, acknowledgement, notification tracking, and
// outstanding/completion calculation. NO controller/HTTP logic and NO SQL. Stateless, deterministic
// (dates stamped by the repository/SQLite), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findPending', 'findAcknowledged', 'findOutstanding', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const DISTRIBUTION_TYPES = ['INDIVIDUAL', 'GROUP', 'BROADCAST'];
const DELIVERY_METHODS = ['EMAIL', 'PORTAL', 'PRINT', 'SMS'];
const DISTRIBUTION_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'ACKNOWLEDGED', 'EXPIRED'];
// Content fields settable via updateDistribution (version + acknowledgement/notification managed elsewhere).
const UPDATABLE_FIELDS = [
  'distributionType', 'deliveryMethod', 'distributionStatus', 'sentDate', 'receivedDate',
  'expiryDate', 'mandatoryRead',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}
function isBinaryFlag(value) {
  return value === 0 || value === 1;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(dist) {
  let metadata = null;
  try {
    metadata = dist.metadataJson ? JSON.parse(dist.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, dist, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentDistributionService extends BaseService {
  constructor(repository, versionRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!versionRepository || typeof versionRepository.findById !== 'function') {
      throw new Error('EnterpriseDocumentDistributionService requires an injected version repository with findById()');
    }
    this.versionRepository = versionRepository;
  }

  // Create a distribution of a version to a user and/or group.
  createDistribution(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (src.documentVersionId === undefined || src.documentVersionId === null) return invalid('documentVersionId is required', 'VALIDATION');
      const version = await this.versionRepository.findById(src.documentVersionId);
      if (!version) return invalid('document version not found', 'VALIDATION');

      const hasUser = src.userId !== undefined && src.userId !== null;
      const hasGroup = src.distributionGroupId !== undefined && src.distributionGroupId !== null;
      if (!hasUser && !hasGroup) return invalid('a recipient (userId or distributionGroupId) is required', 'VALIDATION');
      if (hasUser && !isPositiveInteger(src.userId)) return invalid('invalid userId', 'VALIDATION');
      if (hasGroup && !isPositiveInteger(src.distributionGroupId)) return invalid('invalid distributionGroupId', 'VALIDATION');

      const distributionType = pick(src, 'distributionType', 'INDIVIDUAL');
      if (!DISTRIBUTION_TYPES.includes(distributionType)) return invalid('invalid distributionType', 'VALIDATION');
      const deliveryMethod = pick(src, 'deliveryMethod', 'PORTAL');
      if (!DELIVERY_METHODS.includes(deliveryMethod)) return invalid('invalid deliveryMethod', 'VALIDATION');
      const distributionStatus = pick(src, 'distributionStatus', 'PENDING');
      if (!DISTRIBUTION_STATUSES.includes(distributionStatus)) return invalid('invalid distributionStatus', 'VALIDATION');
      const mandatoryRead = pick(src, 'mandatoryRead', 0);
      if (!isBinaryFlag(mandatoryRead)) return invalid('mandatoryRead must be 0 or 1', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');

      const payload = {
        documentVersionId: version.id,
        userId: pick(src, 'userId', null),
        distributionGroupId: pick(src, 'distributionGroupId', null),
        distributionType,
        deliveryMethod,
        distributionStatus,
        sentDate: pick(src, 'sentDate', null),
        receivedDate: pick(src, 'receivedDate', null),
        expiryDate: pick(src, 'expiryDate', null),
        mandatoryRead,
        acknowledged: 0,
        notificationCount: 0,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const distribution = await this.repository.create(payload);
      return { ok: true, distribution: withMetadata(distribution) };
    });
  }

  updateDistribution(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('distribution not found', 'NOT_FOUND');
      if (src.distributionType !== undefined && !DISTRIBUTION_TYPES.includes(src.distributionType)) return invalid('invalid distributionType', 'VALIDATION');
      if (src.deliveryMethod !== undefined && !DELIVERY_METHODS.includes(src.deliveryMethod)) return invalid('invalid deliveryMethod', 'VALIDATION');
      if (src.distributionStatus !== undefined && !DISTRIBUTION_STATUSES.includes(src.distributionStatus)) return invalid('invalid distributionStatus', 'VALIDATION');
      if (src.mandatoryRead !== undefined && !isBinaryFlag(src.mandatoryRead)) return invalid('mandatoryRead must be 0 or 1', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const distribution = await this.repository.update(id, payload);
      return { ok: true, distribution: withMetadata(distribution) };
    });
  }

  getDistribution(id) {
    return execute(async () => {
      const distribution = await this.repository.findById(id);
      if (!distribution) return invalid('distribution not found', 'NOT_FOUND');
      return { ok: true, distribution: withMetadata(distribution) };
    });
  }

  listVersionDistributions(documentVersionId) {
    return execute(async () => {
      const distributions = await this.repository.findByVersion(documentVersionId);
      return { ok: true, distributions: distributions.map((d) => withMetadata(d)) };
    });
  }

  pendingDistributions() {
    return execute(async () => {
      const distributions = await this.repository.findPending();
      return { ok: true, distributions: distributions.map((d) => withMetadata(d)) };
    });
  }

  outstandingDistributions() {
    return execute(async () => {
      const distributions = await this.repository.findOutstanding();
      return { ok: true, distributions: distributions.map((d) => withMetadata(d)) };
    });
  }

  // Acknowledge a distribution (stamps acknowledgedDate via SQL). Cannot re-acknowledge.
  acknowledgeDistribution(id) {
    return execute(async () => {
      const distribution = await this.repository.findById(id);
      if (!distribution) return invalid('distribution not found', 'NOT_FOUND');
      if (distribution.acknowledged) return invalid('distribution already acknowledged', 'VALIDATION');
      const updated = await this.repository.update(id, { acknowledged: 1, distributionStatus: 'ACKNOWLEDGED', acknowledgedDate: true });
      return { ok: true, distribution: withMetadata(updated) };
    });
  }

  // Notification tracking (service-level): increments notificationCount and stamps lastNotificationDate.
  recordNotification(id) {
    return execute(async () => {
      const distribution = await this.repository.findById(id);
      if (!distribution) return invalid('distribution not found', 'NOT_FOUND');
      if (distribution.acknowledged) return invalid('cannot notify an acknowledged distribution', 'VALIDATION');
      const updated = await this.repository.update(id, { notificationCount: distribution.notificationCount + 1, lastNotificationDate: true });
      return { ok: true, distribution: withMetadata(updated) };
    });
  }

  // Distribution completion (service-level): complete when every distribution is acknowledged.
  getDistributionCompletion(documentVersionId) {
    return execute(async () => {
      const distributions = await this.repository.findByVersion(documentVersionId);
      const total = distributions.length;
      const acknowledged = distributions.filter((d) => d.acknowledged === 1).length;
      const outstanding = total - acknowledged;
      const mandatoryOutstanding = distributions.filter((d) => d.mandatoryRead === 1 && d.acknowledged === 0).length;
      const complete = total > 0 && acknowledged === total;
      return { ok: true, complete, total, acknowledged, outstanding, mandatoryOutstanding };
    });
  }

  archiveDistribution(id) {
    return execute(async () => {
      const distribution = await this.repository.findById(id);
      if (!distribution) return invalid('distribution not found', 'NOT_FOUND');
      if (distribution.archived) return invalid('distribution already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, distribution: withMetadata(updated) };
    });
  }

  deleteDistribution(id) {
    return execute(async () => {
      const distribution = await this.repository.findById(id);
      if (!distribution) return invalid('distribution not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreDistribution(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('distribution not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const distribution = await this.repository.findById(id);
      return { ok: true, distribution: withMetadata(distribution) };
    });
  }
}

module.exports = EnterpriseDocumentDistributionService;
