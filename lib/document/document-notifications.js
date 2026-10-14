// WP-17 · D13 — Enterprise document notification registry (document-management foundation).
//
// The immutable single source of truth for document notification templates — their
// trigger, category, delivery channels, recipient types, and escalation/reminder rules
// — plus a reserved `futureReserved` extension block. Deep-frozen, copy-on-read (fresh
// objects AND fresh arrays), pure, dependency-free, CommonJS, never throws; unknown ids
// fall back to a safe default. UNWIRED — nothing consumes it (no notification engine,
// email/SMS/Slack/Teams integration).
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    templatePolicy: null,
    deliveryPolicy: null,
    digestPolicy: null,
    batchingPolicy: null,
    escalationPolicy: null,
    reminderPolicy: null,
    localizationPolicy: null,
    integrationPolicy: null,
    preferencePolicy: null,
    suppressionPolicy: null,
  };
}

// Build a notification. `n` carries the channel/recipient arrays (always arrays), the
// boolean flags, and the reminder/escalation numbers (null or integer) — all explicit.
function notification(id, displayName, description, category, trigger, n) {
  return {
    id,
    displayName,
    description,
    category,
    trigger,
    defaultChannels: [...n.defaultChannels],
    recipientTypes: [...n.recipientTypes],
    requiresAuthentication: !!n.requiresAuthentication,
    requiresAcknowledgement: !!n.requiresAcknowledgement,
    requiresEscalation: !!n.requiresEscalation,
    allowsDigest: !!n.allowsDigest,
    allowsBatching: !!n.allowsBatching,
    allowsExternalRecipients: !!n.allowsExternalRecipients,
    highPriority: !!n.highPriority,
    auditRequired: !!n.auditRequired,
    defaultReminderDays: n.defaultReminderDays,
    defaultEscalationDays: n.defaultEscalationDays,
    futureReserved: reserved(),
  };
}

const DOCUMENT_NOTIFICATIONS = deepFreeze({
  NONE: notification('NONE', 'None', 'No notification', 'none', 'none', {
    defaultChannels: ['none'], recipientTypes: ['none'], defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_CREATED: notification('DOCUMENT_CREATED', 'Document Created', 'A document was created', 'lifecycle', 'create', {
    defaultChannels: ['app'], recipientTypes: ['owner', 'author'],
    requiresAuthentication: true, allowsDigest: true, allowsBatching: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_UPDATED: notification('DOCUMENT_UPDATED', 'Document Updated', 'A document was updated', 'lifecycle', 'update', {
    defaultChannels: ['app'], recipientTypes: ['actor', 'owner', 'author'],
    requiresAuthentication: true, allowsDigest: true, allowsBatching: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_SUBMITTED_FOR_REVIEW: notification('DOCUMENT_SUBMITTED_FOR_REVIEW', 'Submitted for Review', 'A document was submitted for review', 'review', 'submit_review', {
    defaultChannels: ['app', 'email'], recipientTypes: ['reviewer', 'document_control'],
    requiresAuthentication: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_REVIEW_ASSIGNED: notification('DOCUMENT_REVIEW_ASSIGNED', 'Review Assigned', 'A review was assigned', 'review', 'assign_review', {
    defaultChannels: ['app', 'email'], recipientTypes: ['reviewer'],
    requiresAuthentication: true, allowsDigest: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_REVIEW_DUE: notification('DOCUMENT_REVIEW_DUE', 'Review Due', 'A review is due', 'review', 'due_review', {
    defaultChannels: ['app', 'email'], recipientTypes: ['reviewer'],
    requiresAuthentication: true, auditRequired: true, defaultReminderDays: 3, defaultEscalationDays: null,
  }),
  DOCUMENT_REVIEW_OVERDUE: notification('DOCUMENT_REVIEW_OVERDUE', 'Review Overdue', 'A review is overdue', 'review', 'overdue_review', {
    defaultChannels: ['app', 'email', 'sms'], recipientTypes: ['reviewer', 'managers'],
    requiresAuthentication: true, requiresEscalation: true, highPriority: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: 2,
  }),
  DOCUMENT_APPROVAL_REQUESTED: notification('DOCUMENT_APPROVAL_REQUESTED', 'Approval Requested', 'Approval was requested', 'approval', 'request_approval', {
    defaultChannels: ['app', 'email'], recipientTypes: ['approver'],
    requiresAuthentication: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_APPROVAL_APPROVED: notification('DOCUMENT_APPROVAL_APPROVED', 'Approved', 'A document was approved', 'approval', 'approve', {
    defaultChannels: ['app', 'email'], recipientTypes: ['owner', 'author', 'publisher'],
    requiresAuthentication: true, allowsDigest: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_APPROVAL_REJECTED: notification('DOCUMENT_APPROVAL_REJECTED', 'Rejected', 'A document approval was rejected', 'approval', 'reject', {
    defaultChannels: ['app', 'email'], recipientTypes: ['owner', 'author'],
    requiresAuthentication: true, highPriority: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_PUBLISHED: notification('DOCUMENT_PUBLISHED', 'Published', 'A document was published', 'publishing', 'publish', {
    defaultChannels: ['app', 'email', 'kiosk'], recipientTypes: ['readers', 'document_control'],
    requiresAuthentication: true, requiresAcknowledgement: true, allowsDigest: true, allowsBatching: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_SUPERSEDED: notification('DOCUMENT_SUPERSEDED', 'Superseded', 'A document was superseded', 'lifecycle', 'supersede', {
    defaultChannels: ['app'], recipientTypes: ['readers', 'document_control'],
    requiresAuthentication: true, allowsDigest: true, allowsBatching: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_ARCHIVED: notification('DOCUMENT_ARCHIVED', 'Archived', 'A document was archived', 'lifecycle', 'archive', {
    defaultChannels: ['app'], recipientTypes: ['document_control'],
    requiresAuthentication: true, allowsDigest: true, allowsBatching: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: null,
  }),
  DOCUMENT_EXPIRING_SOON: notification('DOCUMENT_EXPIRING_SOON', 'Expiring Soon', 'A document is expiring soon', 'expiry', 'expiry_warning', {
    defaultChannels: ['app', 'email'], recipientTypes: ['owner', 'document_control'],
    requiresAuthentication: true, allowsDigest: true, auditRequired: true, defaultReminderDays: 30, defaultEscalationDays: null,
  }),
  DOCUMENT_EXPIRED: notification('DOCUMENT_EXPIRED', 'Expired', 'A document has expired', 'expiry', 'expired', {
    defaultChannels: ['app', 'email', 'sms'], recipientTypes: ['owner', 'document_control', 'managers'],
    requiresAuthentication: true, requiresEscalation: true, highPriority: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: 1,
  }),
  READ_ACKNOWLEDGEMENT_REQUIRED: notification('READ_ACKNOWLEDGEMENT_REQUIRED', 'Read Acknowledgement Required', 'A read acknowledgement is required', 'acknowledgement', 'read_ack_required', {
    defaultChannels: ['app', 'email'], recipientTypes: ['acknowledgers'],
    requiresAuthentication: true, requiresAcknowledgement: true, auditRequired: true, defaultReminderDays: 7, defaultEscalationDays: null,
  }),
  READ_ACKNOWLEDGEMENT_OVERDUE: notification('READ_ACKNOWLEDGEMENT_OVERDUE', 'Read Acknowledgement Overdue', 'A read acknowledgement is overdue', 'acknowledgement', 'read_ack_overdue', {
    defaultChannels: ['app', 'email', 'sms'], recipientTypes: ['acknowledgers', 'supervisors'],
    requiresAuthentication: true, requiresAcknowledgement: true, requiresEscalation: true, highPriority: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: 2,
  }),
  ELECTRONIC_SIGNATURE_REQUIRED: notification('ELECTRONIC_SIGNATURE_REQUIRED', 'Electronic Signature Required', 'An electronic signature is required', 'signature', 'signature_required', {
    defaultChannels: ['app', 'email'], recipientTypes: ['signers'],
    requiresAuthentication: true, requiresAcknowledgement: true, auditRequired: true, defaultReminderDays: 3, defaultEscalationDays: null,
  }),
  ELECTRONIC_SIGNATURE_OVERDUE: notification('ELECTRONIC_SIGNATURE_OVERDUE', 'Electronic Signature Overdue', 'An electronic signature is overdue', 'signature', 'signature_overdue', {
    defaultChannels: ['app', 'email', 'sms'], recipientTypes: ['signers', 'managers'],
    requiresAuthentication: true, requiresAcknowledgement: true, requiresEscalation: true, highPriority: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: 2,
  }),
  TRAINING_RELEASED: notification('TRAINING_RELEASED', 'Training Released', 'Training content was released', 'training', 'training_release', {
    defaultChannels: ['app', 'email'], recipientTypes: ['training_group'],
    requiresAuthentication: true, allowsDigest: true, allowsBatching: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: null,
  }),
  TRAINING_ACKNOWLEDGEMENT_REQUIRED: notification('TRAINING_ACKNOWLEDGEMENT_REQUIRED', 'Training Acknowledgement Required', 'A training acknowledgement is required', 'training', 'read_ack_required', {
    defaultChannels: ['app', 'email'], recipientTypes: ['training_group'],
    requiresAuthentication: true, requiresAcknowledgement: true, auditRequired: true, defaultReminderDays: 7, defaultEscalationDays: null,
  }),
  TRANSLATION_READY: notification('TRANSLATION_READY', 'Translation Ready', 'A translation is ready', 'translation', 'translation_ready', {
    defaultChannels: ['app'], recipientTypes: ['owner', 'document_control'],
    requiresAuthentication: true, allowsDigest: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  AI_CONTENT_REVIEW_REQUIRED: notification('AI_CONTENT_REVIEW_REQUIRED', 'AI Content Review Required', 'AI-generated content requires review', 'ai', 'ai_review_required', {
    defaultChannels: ['app'], recipientTypes: ['reviewer', 'document_control'],
    requiresAuthentication: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  CONTROLLED_COPY_DISTRIBUTED: notification('CONTROLLED_COPY_DISTRIBUTED', 'Controlled Copy Distributed', 'A controlled copy was distributed', 'controlled_copy', 'controlled_copy_distributed', {
    defaultChannels: ['app', 'email', 'webhook'], recipientTypes: ['document_control', 'external'],
    requiresAuthentication: true, allowsExternalRecipients: true, auditRequired: true, defaultReminderDays: null, defaultEscalationDays: null,
  }),
  EMERGENCY_DOCUMENT_RELEASED: notification('EMERGENCY_DOCUMENT_RELEASED', 'Emergency Document Released', 'An emergency document was released', 'emergency', 'emergency_release', {
    defaultChannels: ['app', 'email', 'sms', 'teams', 'slack'], recipientTypes: ['readers', 'supervisors', 'managers', 'hseq', 'hr', 'admins'],
    requiresAuthentication: true, requiresAcknowledgement: true, allowsExternalRecipients: true, highPriority: true, auditRequired: true,
    defaultReminderDays: null, defaultEscalationDays: null,
  }),
});

const DOCUMENT_NOTIFICATION_IDS = Object.freeze(Object.keys(DOCUMENT_NOTIFICATIONS));

// Safe default for an unrecognised notification id (per D13 specification).
const SAFE_DEFAULT = deepFreeze(notification('UNKNOWN', 'Unknown Notification', 'Unrecognised notification — safe default', 'lifecycle', 'none', {
  defaultChannels: [], recipientTypes: [],
  requiresAuthentication: true, requiresAcknowledgement: false, requiresEscalation: false,
  allowsDigest: false, allowsBatching: false, allowsExternalRecipients: false, highPriority: false, auditRequired: true,
  defaultReminderDays: null, defaultEscalationDays: null,
}));

// Deep copy — fresh notification with fresh channel/recipient arrays + fresh futureReserved.
function copyNotification(n) {
  return Object.assign({}, n, {
    defaultChannels: [...n.defaultChannels],
    recipientTypes: [...n.recipientTypes],
    futureReserved: Object.assign({}, n.futureReserved),
  });
}

function getDocumentNotification(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_NOTIFICATIONS, id);
  return copyNotification(known ? DOCUMENT_NOTIFICATIONS[id] : SAFE_DEFAULT);
}

function listDocumentNotifications() {
  return DOCUMENT_NOTIFICATION_IDS.map((k) => copyNotification(DOCUMENT_NOTIFICATIONS[k]));
}

function isKnownDocumentNotification(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_NOTIFICATIONS, id);
}

module.exports = {
  DOCUMENT_NOTIFICATIONS,
  DOCUMENT_NOTIFICATION_IDS,
  getDocumentNotification,
  listDocumentNotifications,
  isKnownDocumentNotification,
};
