// WP-15 · D4 — Entity & event governance resolution (governance foundation).
//
// Integrates the D1 registries (entities/classifications/retention/sensitive-data)
// and the D3 audit taxonomy into a single report-only resolver. Pure,
// dependency-free (internal governance requires only), never throws, returns fresh
// copies, never mutates input. Only GLOBAL governance is populated in D4 — the
// multi-tenant scope is normalized but no override is applied. Unwired.
'use strict';

const { getEntity, ENTITY_IDS } = require('./entities');
const { getAuditEvent } = require('./audit-taxonomy');

// Normalize a scope object into the reserved multi-tenant shape. Only scalar
// string/number values survive (coerced to string); objects/arrays/others → null.
// No overrides, no DB, no context lookup, no enforcement. Never throws.
function scopeValue(v) {
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function resolveGovernanceScope(scope) {
  const s = (scope && typeof scope === 'object' && !Array.isArray(scope)) ? scope : {};
  return {
    tenantId: scopeValue(s.tenantId),
    company: scopeValue(s.company),
    site: scopeValue(s.site),
    department: scopeValue(s.department),
    project: scopeValue(s.project),
  };
}

// Resolve governance metadata for an entity. Unknown → safe default (D1 handles
// the fallback). Fresh copies throughout. Never throws; never mutates input.
function getEntityGovernance(entity, scope) {
  const e = getEntity(entity); // D1 returns a fresh deep copy or the safe default
  return {
    entity: e.id,
    classification: e.classification,
    retention: e.retention,
    sensitiveCategories: [...e.sensitiveCategories],
    ownership: {
      businessOwner: e.businessOwner,
      technicalOwner: e.technicalOwner,
      responsibleDepartment: e.responsibleDepartment,
      approvalAuthority: e.approvalAuthority,
    },
    ai: {
      aiGenerated: e.aiGenerated,
      aiModel: e.aiModel,
      promptVersion: e.promptVersion,
      policyVersion: e.policyVersion,
      confidence: e.confidence,
      humanVerified: e.humanVerified,
      verifiedBy: e.verifiedBy,
      verificationDate: e.verificationDate,
    },
    evidenceEdges: [...e.evidenceEdges],
    scope: resolveGovernanceScope(scope),
    source: 'global',
  };
}

// Resolve governance metadata for an audit event: event-level fields from the D3
// taxonomy + entity-level sensitivity/ownership/AI from getEntityGovernance.
// Unknown event → safe default. Fresh copies. Never throws.
function getEventGovernance(eventId, scope) {
  const ev = getAuditEvent(eventId); // D3 returns a fresh copy or the safe default
  const eg = getEntityGovernance(ev.entity, scope);
  return {
    event: ev.id,
    entity: ev.entity,
    action: ev.action,
    classification: ev.classification,
    retention: ev.retention,
    sensitiveCategories: eg.sensitiveCategories,
    ownership: eg.ownership,
    ai: eg.ai,
    evidenceEdges: eg.evidenceEdges,
    complianceRelevant: ev.complianceRelevant,
    lifecycleEvent: ev.lifecycleEvent,
    evidenceEvent: ev.evidenceEvent,
    risk: ev.risk,
    category: ev.category,
    scope: eg.scope,
    source: 'global',
  };
}

// Fresh array of governance objects for every governed D1 entity.
function listGovernedEntities() {
  return ENTITY_IDS.map((id) => getEntityGovernance(id));
}

module.exports = { getEntityGovernance, getEventGovernance, listGovernedEntities, resolveGovernanceScope };
