// WP-17 · D10 — Enterprise document distribution registry (document-management foundation).
//
// The immutable single source of truth for document distribution modes — audiences,
// acknowledgement/authentication requirements, controlled-copy distribution rules, and
// delivery channels — plus a reserved `futureReserved` extension block. Deep-frozen,
// copy-on-read (fresh objects AND fresh arrays), pure, dependency-free, CommonJS, never
// throws; unknown ids fall back to a safe default. UNWIRED — nothing consumes it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// The reserved forward-compatibility block — every key present, every value null.
function reserved() {
  return {
    audienceResolver: null,
    deliveryPolicy: null,
    notificationTemplate: null,
    escalationRule: null,
    acknowledgementPolicy: null,
    signaturePolicy: null,
    competencyRule: null,
    employmentRule: null,
    externalSharingRule: null,
    integrationHook: null,
  };
}

// Build a distribution mode. `d` carries the boolean rule flags, defaultChannel string,
// and allowedChannels array (always an array) — always explicit here.
function distribution(id, displayName, description, category, audienceType, d) {
  return {
    id,
    displayName,
    description,
    category,
    audienceType,
    requiresAuthentication: !!d.requiresAuthentication,
    requiresReadAcknowledgement: !!d.requiresReadAcknowledgement,
    requiresElectronicSignature: !!d.requiresElectronicSignature,
    requiresCompetency: !!d.requiresCompetency,
    requiresRoleMatch: !!d.requiresRoleMatch,
    requiresDepartmentMatch: !!d.requiresDepartmentMatch,
    requiresSiteMatch: !!d.requiresSiteMatch,
    requiresActiveEmployment: !!d.requiresActiveEmployment,
    allowsExternalRecipients: !!d.allowsExternalRecipients,
    allowsPublicAccess: !!d.allowsPublicAccess,
    allowsAnonymousAccess: !!d.allowsAnonymousAccess,
    tracksDelivery: !!d.tracksDelivery,
    tracksRead: !!d.tracksRead,
    tracksAcknowledgement: !!d.tracksAcknowledgement,
    tracksExpiry: !!d.tracksExpiry,
    defaultChannel: d.defaultChannel,
    allowedChannels: [...d.allowedChannels],
    futureReserved: reserved(),
  };
}

const DOCUMENT_DISTRIBUTION = deepFreeze({
  NONE: distribution('NONE', 'No Distribution', 'Document is not distributed', 'none', 'none', {
    defaultChannel: 'none', allowedChannels: ['none'],
  }),
  ALL_USERS: distribution('ALL_USERS', 'All Users', 'Distributed to all application users', 'all', 'user', {
    requiresAuthentication: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  ALL_EMPLOYEES: distribution('ALL_EMPLOYEES', 'All Employees', 'Distributed to all employees', 'employment', 'employee', {
    requiresAuthentication: true, requiresReadAcknowledgement: true, requiresActiveEmployment: true,
    tracksDelivery: true, tracksRead: true, tracksAcknowledgement: true, tracksExpiry: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  ALL_CONTRACTORS: distribution('ALL_CONTRACTORS', 'All Contractors', 'Distributed to all contractors', 'employment', 'contractor', {
    requiresAuthentication: true, allowsExternalRecipients: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'email', allowedChannels: ['email'],
  }),
  ROLE_BASED: distribution('ROLE_BASED', 'Role Based', 'Distributed by role', 'role', 'role', {
    requiresAuthentication: true, requiresRoleMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  DEPARTMENT_BASED: distribution('DEPARTMENT_BASED', 'Department Based', 'Distributed by department', 'department', 'department', {
    requiresAuthentication: true, requiresDepartmentMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  SITE_BASED: distribution('SITE_BASED', 'Site Based', 'Distributed by site', 'site', 'site', {
    requiresAuthentication: true, requiresSiteMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'kiosk', allowedChannels: ['app', 'kiosk', 'qr'],
  }),
  COMPANY_WIDE: distribution('COMPANY_WIDE', 'Company Wide', 'Distributed across the company', 'company', 'company', {
    requiresAuthentication: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  PROJECT_TEAM: distribution('PROJECT_TEAM', 'Project Team', 'Distributed to a project team', 'project', 'project', {
    requiresAuthentication: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  TRAINING_GROUP: distribution('TRAINING_GROUP', 'Training Group', 'Distributed to a training group', 'training', 'training_group', {
    requiresAuthentication: true, requiresReadAcknowledgement: true, requiresActiveEmployment: true,
    tracksDelivery: true, tracksRead: true, tracksAcknowledgement: true, tracksExpiry: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  COMPETENCY_GROUP: distribution('COMPETENCY_GROUP', 'Competency Group', 'Distributed to a competency group', 'competency', 'competency_group', {
    requiresAuthentication: true, requiresCompetency: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true, tracksExpiry: true,
    defaultChannel: 'app', allowedChannels: ['app'],
  }),
  EQUIPMENT_GROUP: distribution('EQUIPMENT_GROUP', 'Equipment Group', 'Distributed to an equipment group', 'equipment', 'equipment_group', {
    requiresAuthentication: true, requiresCompetency: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'qr'],
  }),
  SHIFT_PANEL: distribution('SHIFT_PANEL', 'Shift Panel', 'Distributed to a shift panel', 'shift', 'shift_panel', {
    requiresAuthentication: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'kiosk', allowedChannels: ['app', 'kiosk'],
  }),
  SUPERVISORS: distribution('SUPERVISORS', 'Supervisors', 'Distributed to supervisors', 'leadership', 'role', {
    requiresAuthentication: true, requiresRoleMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  MANAGERS: distribution('MANAGERS', 'Managers', 'Distributed to managers', 'leadership', 'role', {
    requiresAuthentication: true, requiresRoleMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  HSEQ_TEAM: distribution('HSEQ_TEAM', 'HSEQ Team', 'Distributed to the HSEQ team', 'hseq', 'team', {
    requiresAuthentication: true, requiresRoleMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  HR_TEAM: distribution('HR_TEAM', 'HR Team', 'Distributed to the HR team', 'hr', 'team', {
    requiresAuthentication: true, requiresRoleMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  DOCUMENT_OWNERS: distribution('DOCUMENT_OWNERS', 'Document Owners', 'Distributed to document owners', 'owner', 'role', {
    requiresAuthentication: true, requiresRoleMatch: true, requiresActiveEmployment: true, tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  APPROVERS: distribution('APPROVERS', 'Approvers', 'Distributed to approvers', 'approval', 'role', {
    requiresAuthentication: true, requiresRoleMatch: true, requiresElectronicSignature: true, requiresActiveEmployment: true,
    tracksDelivery: true, tracksRead: true,
    defaultChannel: 'app', allowedChannels: ['app', 'email'],
  }),
  EXTERNAL_PARTIES: distribution('EXTERNAL_PARTIES', 'External Parties', 'Distributed to external parties', 'external', 'external', {
    allowsExternalRecipients: true, tracksDelivery: true,
    defaultChannel: 'email', allowedChannels: ['email', 'public_link'],
  }),
  PUBLIC_AUDIENCE: distribution('PUBLIC_AUDIENCE', 'Public Audience', 'Distributed to the public', 'public', 'public', {
    allowsExternalRecipients: true, allowsPublicAccess: true, allowsAnonymousAccess: true,
    defaultChannel: 'public_link', allowedChannels: ['public_link', 'download'],
  }),
  CONTROLLED_COPY_HOLDERS: distribution('CONTROLLED_COPY_HOLDERS', 'Controlled Copy Holders', 'Distributed to controlled-copy holders', 'controlled', 'controlled_copy', {
    requiresAuthentication: true, requiresReadAcknowledgement: true, requiresElectronicSignature: true, requiresActiveEmployment: true,
    tracksDelivery: true, tracksRead: true, tracksAcknowledgement: true, tracksExpiry: true,
    defaultChannel: 'controlled_copy', allowedChannels: ['app', 'controlled_copy'],
  }),
  EMERGENCY_BROADCAST: distribution('EMERGENCY_BROADCAST', 'Emergency Broadcast', 'Fast-tracked emergency broadcast', 'emergency', 'company', {
    requiresAuthentication: true, requiresReadAcknowledgement: true, requiresActiveEmployment: true,
    tracksDelivery: true, tracksRead: true, tracksAcknowledgement: true,
    defaultChannel: 'sms', allowedChannels: ['app', 'email', 'sms', 'print'],
  }),
});

const DOCUMENT_DISTRIBUTION_IDS = Object.freeze(Object.keys(DOCUMENT_DISTRIBUTION));

// Safe default for an unrecognised distribution id (per D10 specification).
const SAFE_DEFAULT = deepFreeze(distribution('UNKNOWN', 'Unknown Distribution Mode', 'Unrecognised distribution mode — safe default', 'controlled', 'controlled_copy', {
  requiresAuthentication: true, requiresReadAcknowledgement: true, requiresElectronicSignature: false, requiresCompetency: false,
  requiresRoleMatch: false, requiresDepartmentMatch: false, requiresSiteMatch: false, requiresActiveEmployment: true,
  allowsExternalRecipients: false, allowsPublicAccess: false, allowsAnonymousAccess: false,
  tracksDelivery: true, tracksRead: true, tracksAcknowledgement: true, tracksExpiry: true,
  defaultChannel: 'app', allowedChannels: [],
}));

// Deep copy — fresh mode with a fresh allowedChannels array + fresh futureReserved.
function copyDistribution(d) {
  return Object.assign({}, d, {
    allowedChannels: [...d.allowedChannels],
    futureReserved: Object.assign({}, d.futureReserved),
  });
}

function getDocumentDistribution(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_DISTRIBUTION, id);
  return copyDistribution(known ? DOCUMENT_DISTRIBUTION[id] : SAFE_DEFAULT);
}

function listDocumentDistribution() {
  return DOCUMENT_DISTRIBUTION_IDS.map((k) => copyDistribution(DOCUMENT_DISTRIBUTION[k]));
}

function isKnownDocumentDistribution(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DOCUMENT_DISTRIBUTION, id);
}

module.exports = {
  DOCUMENT_DISTRIBUTION,
  DOCUMENT_DISTRIBUTION_IDS,
  getDocumentDistribution,
  listDocumentDistribution,
  isKnownDocumentDistribution,
};
