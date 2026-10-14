// WP-17 · D9 — Enterprise document publishing registry (document-management foundation).
//
// The immutable single source of truth for document publishing modes — supported
// channels, export formats, distribution/controlled-copy behaviours, watermark and
// read-acknowledgement rules — plus a reserved `futureReserved` extension block.
// Deep-frozen, copy-on-read (fresh objects AND fresh arrays), pure, dependency-free,
// CommonJS, never throws; unknown ids fall back to a safe default. UNWIRED — nothing
// consumes it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    renderPolicy: null,
    exportPolicy: null,
    distributionPolicy: null,
    watermarkPolicy: null,
    accessPolicy: null,
    expiryPolicy: null,
    acknowledgementPolicy: null,
    signaturePolicy: null,
    translationPolicy: null,
    integrationPolicy: null,
  };
}

// Build a publishing mode. `p` carries the format/channel arrays (always arrays), the
// boolean rule flags, and the watermark/status strings — always explicit here.
function publishing(id, displayName, description, category, p) {
  return {
    id,
    displayName,
    description,
    category,
    allowedFormats: [...p.allowedFormats],
    allowedChannels: [...p.allowedChannels],
    requiresApproval: !!p.requiresApproval,
    requiresPublishedStatus: !!p.requiresPublishedStatus,
    requiresVersionLock: !!p.requiresVersionLock,
    requiresReadAcknowledgement: !!p.requiresReadAcknowledgement,
    requiresElectronicSignature: !!p.requiresElectronicSignature,
    requiresControlledCopy: !!p.requiresControlledCopy,
    requiresWatermark: !!p.requiresWatermark,
    allowsDownload: !!p.allowsDownload,
    allowsPrint: !!p.allowsPrint,
    allowsEmail: !!p.allowsEmail,
    allowsExternalSharing: !!p.allowsExternalSharing,
    allowsPublicAccess: !!p.allowsPublicAccess,
    tracksDistribution: !!p.tracksDistribution,
    tracksAcknowledgement: !!p.tracksAcknowledgement,
    tracksExpiry: !!p.tracksExpiry,
    defaultWatermark: p.defaultWatermark,
    defaultStatusAfterPublish: p.defaultStatusAfterPublish,
    futureReserved: reserved(),
  };
}

const DOCUMENT_PUBLISHING = deepFreeze({
  NONE: publishing('NONE', 'No Publishing', 'Document is not published', 'none', {
    allowedFormats: ['none'], allowedChannels: ['none'], defaultWatermark: 'NONE', defaultStatusAfterPublish: 'DRAFT',
  }),
  INTERNAL_ONLY: publishing('INTERNAL_ONLY', 'Internal Only', 'Published to internal app only', 'internal', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app'], requiresApproval: true, requiresPublishedStatus: true,
    tracksDistribution: true, defaultWatermark: 'NONE', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  CONTROLLED_DOCUMENT: publishing('CONTROLLED_DOCUMENT', 'Controlled Document', 'Controlled-copy release with full tracking', 'controlled', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app', 'controlled_copy'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresReadAcknowledgement: true,
    requiresElectronicSignature: true, requiresControlledCopy: true, requiresWatermark: true,
    tracksDistribution: true, tracksAcknowledgement: true, tracksExpiry: true,
    defaultWatermark: 'CONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  TRAINING_RELEASE: publishing('TRAINING_RELEASE', 'Training Release', 'Release of training content', 'training', {
    allowedFormats: ['html', 'pdf', 'pptx', 'video'], allowedChannels: ['app', 'email'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresReadAcknowledgement: true,
    allowsDownload: true, allowsPrint: true, allowsEmail: true,
    tracksDistribution: true, tracksAcknowledgement: true, tracksExpiry: true,
    defaultWatermark: 'NONE', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  READ_ACKNOWLEDGEMENT: publishing('READ_ACKNOWLEDGEMENT', 'Read Acknowledgement', 'Release requiring read acknowledgement', 'acknowledgement', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresReadAcknowledgement: true,
    tracksDistribution: true, tracksAcknowledgement: true, defaultWatermark: 'NONE', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  ELECTRONIC_SIGNOFF: publishing('ELECTRONIC_SIGNOFF', 'Electronic Signoff', 'Release requiring electronic signature', 'signoff', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresElectronicSignature: true,
    tracksDistribution: true, defaultWatermark: 'NONE', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  SITE_RELEASE: publishing('SITE_RELEASE', 'Site Release', 'Release to a single site', 'site', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app', 'kiosk', 'qr'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresControlledCopy: true, requiresWatermark: true,
    allowsPrint: true, tracksDistribution: true, tracksExpiry: true, defaultWatermark: 'CONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  COMPANY_RELEASE: publishing('COMPANY_RELEASE', 'Company Release', 'Release across the company', 'company', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app', 'email'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresControlledCopy: true, requiresWatermark: true,
    allowsDownload: true, allowsEmail: true, tracksDistribution: true, tracksExpiry: true, defaultWatermark: 'CONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  MULTI_SITE_RELEASE: publishing('MULTI_SITE_RELEASE', 'Multi-Site Release', 'Release across multiple sites', 'multi_site', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app', 'email', 'kiosk'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresControlledCopy: true, requiresWatermark: true,
    allowsEmail: true, tracksDistribution: true, tracksExpiry: true, defaultWatermark: 'CONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  PUBLIC_EXPORT: publishing('PUBLIC_EXPORT', 'Public Export', 'Publicly accessible export', 'public', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['public_link', 'download'],
    requiresApproval: true, requiresPublishedStatus: true, requiresWatermark: true,
    allowsDownload: true, allowsExternalSharing: true, allowsPublicAccess: true, tracksDistribution: true,
    defaultWatermark: 'UNCONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  PDF_EXPORT: publishing('PDF_EXPORT', 'PDF Export', 'Export to PDF', 'export', {
    allowedFormats: ['pdf'], allowedChannels: ['download'],
    requiresApproval: true, requiresWatermark: true, allowsDownload: true,
    defaultWatermark: 'UNCONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  WORD_EXPORT: publishing('WORD_EXPORT', 'Word Export', 'Export to Word (docx)', 'export', {
    allowedFormats: ['docx'], allowedChannels: ['download'],
    requiresApproval: true, requiresWatermark: true, allowsDownload: true,
    defaultWatermark: 'UNCONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  POWERPOINT_EXPORT: publishing('POWERPOINT_EXPORT', 'PowerPoint Export', 'Export to PowerPoint (pptx)', 'export', {
    allowedFormats: ['pptx'], allowedChannels: ['download'],
    requiresApproval: true, requiresWatermark: true, allowsDownload: true,
    defaultWatermark: 'UNCONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  TRANSLATED_RELEASE: publishing('TRANSLATED_RELEASE', 'Translated Release', 'Release of a translated document', 'translation', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app', 'email'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresWatermark: true,
    allowsEmail: true, tracksDistribution: true, tracksExpiry: true, defaultWatermark: 'CONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
  SUPERSEDED_RELEASE: publishing('SUPERSEDED_RELEASE', 'Superseded Release', 'Release marking a document superseded', 'superseded', {
    allowedFormats: ['pdf'], allowedChannels: ['archive'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresControlledCopy: true, requiresWatermark: true,
    tracksDistribution: true, tracksExpiry: true, defaultWatermark: 'SUPERSEDED', defaultStatusAfterPublish: 'SUPERSEDED',
  }),
  ARCHIVE_RELEASE: publishing('ARCHIVE_RELEASE', 'Archive Release', 'Release archiving a document', 'archive', {
    allowedFormats: ['pdf', 'zip'], allowedChannels: ['archive'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresControlledCopy: true, requiresWatermark: true,
    tracksDistribution: true, tracksExpiry: true, defaultWatermark: 'ARCHIVED', defaultStatusAfterPublish: 'ARCHIVED',
  }),
  EMERGENCY_RELEASE: publishing('EMERGENCY_RELEASE', 'Emergency Release', 'Fast-tracked emergency release', 'emergency', {
    allowedFormats: ['html', 'pdf'], allowedChannels: ['app', 'email', 'print'],
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresReadAcknowledgement: true, requiresWatermark: true,
    allowsPrint: true, allowsEmail: true, tracksDistribution: true, tracksAcknowledgement: true, defaultWatermark: 'CONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
  }),
});

const DOCUMENT_PUBLISHING_IDS = Object.freeze(Object.keys(DOCUMENT_PUBLISHING));

// Safe default for an unrecognised publishing id (per D9 specification).
const SAFE_DEFAULT = deepFreeze(publishing('UNKNOWN', 'Unknown Publishing Mode', 'Unrecognised publishing mode — safe default', 'controlled', {
  allowedFormats: [], allowedChannels: [],
  requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresReadAcknowledgement: false,
  requiresElectronicSignature: false, requiresControlledCopy: true, requiresWatermark: true,
  allowsDownload: false, allowsPrint: false, allowsEmail: false, allowsExternalSharing: false, allowsPublicAccess: false,
  tracksDistribution: true, tracksAcknowledgement: false, tracksExpiry: true,
  defaultWatermark: 'CONTROLLED', defaultStatusAfterPublish: 'PUBLISHED',
}));

// Deep copy — fresh mode with fresh format/channel arrays + fresh futureReserved.
function copyPublishing(p) {
  return Object.assign({}, p, {
    allowedFormats: [...p.allowedFormats],
    allowedChannels: [...p.allowedChannels],
    futureReserved: Object.assign({}, p.futureReserved),
  });
}

function getDocumentPublishing(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_PUBLISHING, id);
  return copyPublishing(known ? DOCUMENT_PUBLISHING[id] : SAFE_DEFAULT);
}

function listDocumentPublishing() {
  return DOCUMENT_PUBLISHING_IDS.map((k) => copyPublishing(DOCUMENT_PUBLISHING[k]));
}

function isKnownDocumentPublishing(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_PUBLISHING, id);
}

module.exports = {
  DOCUMENT_PUBLISHING,
  DOCUMENT_PUBLISHING_IDS,
  getDocumentPublishing,
  listDocumentPublishing,
  isKnownDocumentPublishing,
};
