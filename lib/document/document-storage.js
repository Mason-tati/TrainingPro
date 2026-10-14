// WP-17 · D12 — Enterprise document storage registry (document-management foundation).
//
// The immutable single source of truth for the future storage model — providers,
// retention storage classes, encryption/checksum/virus-scan expectations, retention
// and lifecycle rules — plus a reserved `futureReserved` extension block. Deep-frozen,
// copy-on-read (fresh objects), pure, dependency-free, CommonJS, never throws; unknown
// ids fall back to a safe, most-protective default. UNWIRED — nothing consumes it (no
// storage engine, filesystem, or cloud integration).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    encryptionPolicy: null,
    checksumPolicy: null,
    virusScanPolicy: null,
    retentionPolicy: null,
    legalHoldPolicy: null,
    lifecyclePolicy: null,
    backupPolicy: null,
    signedUrlPolicy: null,
    replicationPolicy: null,
    integrationPolicy: null,
  };
}

// Build a storage mode. `s` carries the boolean flags and retention/size numbers
// (null or integer, always explicit here). No implicit defaults → no branches.
function storage(id, displayName, description, category, provider, storageClass, s) {
  return {
    id,
    displayName,
    description,
    category,
    provider,
    storageClass,
    requiresEncryption: !!s.requiresEncryption,
    requiresChecksum: !!s.requiresChecksum,
    requiresVirusScan: !!s.requiresVirusScan,
    requiresAccessControl: !!s.requiresAccessControl,
    requiresAudit: !!s.requiresAudit,
    allowsPublicAccess: !!s.allowsPublicAccess,
    allowsExternalAccess: !!s.allowsExternalAccess,
    allowsTemporaryAccess: !!s.allowsTemporaryAccess,
    supportsVersioning: !!s.supportsVersioning,
    supportsRetentionLock: !!s.supportsRetentionLock,
    supportsLegalHold: !!s.supportsLegalHold,
    supportsLifecycleTransition: !!s.supportsLifecycleTransition,
    supportsSignedUrl: !!s.supportsSignedUrl,
    supportsBackup: !!s.supportsBackup,
    defaultRetentionDays: s.defaultRetentionDays,
    maxFileSizeMb: s.maxFileSizeMb,
    futureReserved: reserved(),
  };
}

const DOCUMENT_STORAGE = deepFreeze({
  NONE: storage('NONE', 'No Storage', 'No storage configured', 'none', 'none', 'none', {
    defaultRetentionDays: null, maxFileSizeMb: null,
  }),
  LOCAL_PRIVATE: storage('LOCAL_PRIVATE', 'Local Private', 'Private local filesystem storage', 'local', 'local', 'private', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 100,
  }),
  LOCAL_PUBLIC: storage('LOCAL_PUBLIC', 'Local Public', 'Public local filesystem storage', 'local', 'local', 'public', {
    requiresChecksum: true, requiresVirusScan: true, requiresAudit: true,
    allowsPublicAccess: true, allowsExternalAccess: true, defaultRetentionDays: null, maxFileSizeMb: 50,
  }),
  DATABASE_BLOB: storage('DATABASE_BLOB', 'Database Blob', 'Binary stored in the database', 'database', 'sqlite', 'database', {
    requiresEncryption: true, requiresChecksum: true, requiresAccessControl: true, requiresAudit: true,
    supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 10,
  }),
  OBJECT_STORAGE: storage('OBJECT_STORAGE', 'Object Storage', 'Generic object storage', 'object', 'generic', 'standard', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsVersioning: true, supportsSignedUrl: true, supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 5000,
  }),
  S3_STANDARD: storage('S3_STANDARD', 'S3 Standard', 'Amazon S3 standard storage', 'cloud', 's3', 'standard', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    allowsExternalAccess: true, allowsTemporaryAccess: true, supportsVersioning: true, supportsLifecycleTransition: true,
    supportsSignedUrl: true, supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 5000,
  }),
  S3_INFREQUENT_ACCESS: storage('S3_INFREQUENT_ACCESS', 'S3 Infrequent Access', 'Amazon S3 infrequent-access storage', 'cloud', 's3', 'infrequent_access', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsVersioning: true, supportsRetentionLock: true, supportsLifecycleTransition: true, supportsSignedUrl: true,
    supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 5000,
  }),
  S3_GLACIER: storage('S3_GLACIER', 'S3 Glacier', 'Amazon S3 Glacier archival storage', 'cloud', 's3', 'glacier', {
    requiresEncryption: true, requiresChecksum: true, requiresAccessControl: true, requiresAudit: true,
    supportsRetentionLock: true, supportsLegalHold: true, supportsLifecycleTransition: true, supportsSignedUrl: true,
    supportsBackup: true, defaultRetentionDays: 2555, maxFileSizeMb: 40000,
  }),
  AZURE_BLOB: storage('AZURE_BLOB', 'Azure Blob', 'Azure Blob storage', 'cloud', 'azure', 'standard', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    allowsExternalAccess: true, allowsTemporaryAccess: true, supportsVersioning: true, supportsLifecycleTransition: true,
    supportsSignedUrl: true, supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 5000,
  }),
  GCP_BUCKET: storage('GCP_BUCKET', 'GCP Bucket', 'Google Cloud Storage bucket', 'cloud', 'gcp', 'standard', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    allowsExternalAccess: true, allowsTemporaryAccess: true, supportsVersioning: true, supportsLifecycleTransition: true,
    supportsSignedUrl: true, supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 5000,
  }),
  NETWORK_SHARE: storage('NETWORK_SHARE', 'Network Share', 'On-premise network share', 'network', 'network', 'private', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 2000,
  }),
  BEESTATION: storage('BEESTATION', 'BeeStation', 'Synology BeeStation NAS storage', 'network', 'beestation', 'private', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 20000,
  }),
  ARCHIVE_STORAGE: storage('ARCHIVE_STORAGE', 'Archive Storage', 'Long-term archival storage', 'archive', 'generic', 'archive', {
    requiresEncryption: true, requiresChecksum: true, requiresAccessControl: true, requiresAudit: true,
    supportsRetentionLock: true, supportsLegalHold: true, supportsBackup: true, defaultRetentionDays: 2555, maxFileSizeMb: 40000,
  }),
  TEMPORARY_STORAGE: storage('TEMPORARY_STORAGE', 'Temporary Storage', 'Short-lived temporary storage', 'temporary', 'local', 'temporary', {
    requiresEncryption: true, requiresChecksum: true, requiresAccessControl: true,
    allowsTemporaryAccess: true, defaultRetentionDays: 7, maxFileSizeMb: 500,
  }),
  AI_GENERATED_STORAGE: storage('AI_GENERATED_STORAGE', 'AI Generated Storage', 'Storage for AI-generated content', 'ai', 'generic', 'standard', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsVersioning: true, supportsSignedUrl: true, supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 200,
  }),
  TRANSLATION_STORAGE: storage('TRANSLATION_STORAGE', 'Translation Storage', 'Storage for translated documents', 'translation', 'generic', 'standard', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsVersioning: true, supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: 200,
  }),
  EVIDENCE_STORAGE: storage('EVIDENCE_STORAGE', 'Evidence Storage', 'Tamper-evident evidence storage', 'evidence', 's3', 'evidence', {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    supportsVersioning: true, supportsRetentionLock: true, supportsLegalHold: true, supportsSignedUrl: true, supportsBackup: true,
    defaultRetentionDays: 3650, maxFileSizeMb: 5000,
  }),
  BACKUP_STORAGE: storage('BACKUP_STORAGE', 'Backup Storage', 'Backup and disaster-recovery storage', 'backup', 'generic', 'backup', {
    requiresEncryption: true, requiresChecksum: true, requiresAccessControl: true, requiresAudit: true,
    supportsRetentionLock: true, supportsLegalHold: true, supportsBackup: true, defaultRetentionDays: 365, maxFileSizeMb: 40000,
  }),
});

const DOCUMENT_STORAGE_IDS = Object.freeze(Object.keys(DOCUMENT_STORAGE));

// Safe, most-protective fallback for an unrecognised storage id (per D12 spec).
const SAFE_DEFAULT = deepFreeze(storage('UNKNOWN', 'Unknown Storage', 'Unrecognised storage mode — most-protective default', 'archive', 'generic', 'archive', {
  requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
  allowsPublicAccess: false, allowsExternalAccess: false, allowsTemporaryAccess: false,
  supportsVersioning: false, supportsRetentionLock: true, supportsLegalHold: true, supportsLifecycleTransition: false,
  supportsSignedUrl: false, supportsBackup: true, defaultRetentionDays: null, maxFileSizeMb: null,
}));

// Deep copy — a fresh storage object with a fresh futureReserved block.
function copyStorage(s) {
  return Object.assign({}, s, { futureReserved: Object.assign({}, s.futureReserved) });
}

function getDocumentStorage(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_STORAGE, id);
  return copyStorage(known ? DOCUMENT_STORAGE[id] : SAFE_DEFAULT);
}

function listDocumentStorage() {
  return DOCUMENT_STORAGE_IDS.map((k) => copyStorage(DOCUMENT_STORAGE[k]));
}

function isKnownDocumentStorage(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_STORAGE, id);
}

module.exports = {
  DOCUMENT_STORAGE,
  DOCUMENT_STORAGE_IDS,
  getDocumentStorage,
  listDocumentStorage,
  isKnownDocumentStorage,
};
