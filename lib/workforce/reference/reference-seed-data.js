// EWP-01b — Enterprise Workforce Platform — Reference & Organisation — Seed Data (optional).
//
// A small, deterministic sample organisation hierarchy for testing and local bootstrapping. It NEVER
// runs automatically: importing this module has no side effects. `applySeed(service)` must be called
// explicitly, and it creates the sample nodes THROUGH the organisation service (so all validation and
// uuid generation apply). Copy-on-read (getSeed returns a fresh deep copy). Never mounts, never touches
// production. UNWIRED.
'use strict';

// Sample hierarchy: 1 Company, 2 Business Units, 2 Regions, 2 Countries, 3 Sites, 2 Divisions,
// 2 Departments, 2 Cost Centres. `key` is an internal reference; `parent` names a key one level up.
const SEED = {
  companies: [{ key: 'C1', code: 'GMC', name: 'Global Mining Corp', description: 'Parent company' }],
  businessUnits: [
    { key: 'BU1', parent: 'C1', code: 'BU-METALS', name: 'Metals' },
    { key: 'BU2', parent: 'C1', code: 'BU-ENERGY', name: 'Energy' },
  ],
  regions: [
    { key: 'R1', parent: 'BU1', code: 'REG-WA', name: 'Western Australia' },
    { key: 'R2', parent: 'BU2', code: 'REG-QLD', name: 'Queensland' },
  ],
  countries: [
    { key: 'CO1', parent: 'R1', code: 'AU-WA', name: 'Australia (WA)' },
    { key: 'CO2', parent: 'R2', code: 'AU-QLD', name: 'Australia (QLD)' },
  ],
  sites: [
    { key: 'S1', parent: 'CO1', code: 'SITE-PIL', name: 'Pilbara Iron' },
    { key: 'S2', parent: 'CO1', code: 'SITE-GLD', name: 'Goldfields' },
    { key: 'S3', parent: 'CO2', code: 'SITE-BOW', name: 'Bowen Coal' },
  ],
  divisions: [
    { key: 'D1', parent: 'S1', code: 'DIV-MIN', name: 'Mining' },
    { key: 'D2', parent: 'S1', code: 'DIV-PROC', name: 'Processing' },
  ],
  departments: [
    { key: 'DEP1', parent: 'D1', code: 'DEP-HAUL', name: 'Haulage' },
    { key: 'DEP2', parent: 'D2', code: 'DEP-CRUSH', name: 'Crushing' },
  ],
  costCentres: [
    { key: 'CC1', parent: 'DEP1', code: 'CC-4412', name: 'Haul Trucks' },
    { key: 'CC2', parent: 'DEP2', code: 'CC-5521', name: 'Primary Crusher' },
  ],
};

// The ordered creation plan: level → seed group. Parents are created before children.
const PLAN = [
  { level: 'COMPANY', group: 'companies' },
  { level: 'BUSINESS_UNIT', group: 'businessUnits' },
  { level: 'REGION', group: 'regions' },
  { level: 'COUNTRY', group: 'countries' },
  { level: 'SITE', group: 'sites' },
  { level: 'DIVISION', group: 'divisions' },
  { level: 'DEPARTMENT', group: 'departments' },
  { level: 'COST_CENTRE', group: 'costCentres' },
];

function getSeed() {
  return JSON.parse(JSON.stringify(SEED));
}

// Create the sample hierarchy through an organisation service. Returns { ok:true, created, ids } on
// success, or { ok:false, level, code, result } at the first node the service rejects.
async function applySeed(service) {
  const ids = new Map();
  const created = {};
  for (const step of PLAN) {
    created[step.level] = [];
    for (const item of SEED[step.group]) {
      const input = { code: item.code, name: item.name, description: item.description };
      if (item.parent !== undefined) {
        input.parentId = ids.get(item.parent);
      }
      const res = await service.createNode(step.level, input);
      if (!res.ok) {
        return { ok: false, level: step.level, code: item.code, result: res };
      }
      ids.set(item.key, res.node.id);
      created[step.level].push(res.node);
    }
  }
  return { ok: true, created, ids: Object.fromEntries(ids) };
}

module.exports = { SEED: getSeed(), getSeed, PLAN: PLAN.map((p) => Object.assign({}, p)), applySeed };
