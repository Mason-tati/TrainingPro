// WP-16 · M1 — Legacy audit usage inventory (READ-ONLY static scan).
//
// Encodes the complete inventory of every legacy logAudit() call site and
// validates it against a fresh scan of the route sources. Executes NO production
// code and changes nothing — it is the specification for M2. If the code drifts
// (a new call site, table, or action; or a route starts importing governance),
// this test fails so the inventory is kept authoritative.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ROUTES = path.join(ROOT, 'routes');

// Files migrated to the governance audit adapter (M3 low-risk + M4 high-risk + M5 medium-risk).
const MIGRATED = [
  'classes.js', 'trainers.js', 'roster.js', 'register.js', 'assignment.js', 'attendance.js', 'equipment.js', // M3
  'disciplinary.js', 'onboarding.js', 'leave.js', 'staff.js', // M4 high-risk
  'competency.js', 'forms.js', 'content.js', 'exams.js', 'powerpoints.js', 'files.js', 'translator.js', 'knowledgebase.js', // M5 medium-risk
];

// ── inventory: logAudit() call sites per NON-migrated route file (call sites only) ──
// WP-16 M5 completed the migration: every route audit call site now uses the
// governance adapter, so NO route file retains a legacy logAudit() call.
const EXPECTED_COUNTS = {};
const TOTAL = 0; // remaining legacy logAudit call sites (90 original − 28 M3 − 24 M4 − 38 M5)

// ── inventory: distinct AuditTable literals (31) → proposed governance entity + risk ──
// entity `null` = NO direct D1 entity today (M2 must add an entity or map with a
// documented fallback). risk ∈ LOW|MEDIUM|HIGH|CRITICAL.
const TABLES = {
  // Low-risk operational / scheduling / reference
  tblClass: { entity: 'training', risk: 'LOW' },
  tblRoster: { entity: 'training', risk: 'LOW' },
  create: { entity: null, risk: 'LOW' }, // roster.js req-first quirk (shift-type)
  tblRegister: { entity: 'training', risk: 'LOW' },
  tblTrainer: { entity: 'users', risk: 'LOW' },
  Assignment: { entity: 'training', risk: 'LOW' },
  Attendance: { entity: 'training', risk: 'LOW' },
  Equipment: { entity: null, risk: 'LOW' },
  EquipmentType: { entity: null, risk: 'LOW' },
  EquipmentService: { entity: null, risk: 'LOW' },
  EquipmentBreakdown: { entity: null, risk: 'LOW' },
  LeaveType: { entity: null, risk: 'LOW' },
  // Medium-risk business content / assessments / documents / AI
  Competency: { entity: 'competencies', risk: 'MEDIUM' },
  CompetencyFramework: { entity: 'competencies', risk: 'MEDIUM' },
  CompetencyRecord: { entity: 'competencies', risk: 'MEDIUM' },
  Exam: { entity: 'assessments', risk: 'MEDIUM' },
  tblExam: { entity: 'assessments', risk: 'MEDIUM' },
  tblTest: { entity: 'assessments', risk: 'MEDIUM' },
  tblQ: { entity: 'assessments', risk: 'MEDIUM' },
  tblFormTemplate: { entity: 'assessments', risk: 'MEDIUM' },
  tblFormSubmission: { entity: 'assessments', risk: 'MEDIUM' },
  KBArticle: { entity: 'documents', risk: 'MEDIUM' },
  tblFiles: { entity: 'documents', risk: 'MEDIUM' },
  PPTX: { entity: 'documents', risk: 'MEDIUM' },
  AIContent: { entity: 'ai_outputs', risk: 'MEDIUM' },
  LeaveBooking: { entity: null, risk: 'MEDIUM' },
  // High-risk HR / people
  tblStaff: { entity: 'users', risk: 'HIGH' },
  tblEmpJob: { entity: 'users', risk: 'HIGH' },
  OnboardingReview: { entity: null, risk: 'HIGH' },
  // Critical HR / disciplinary / medical (sensitive free-text)
  Disciplinary: { entity: 'disciplinary', risk: 'CRITICAL' },
  Onboarding: { entity: null, risk: 'CRITICAL' }, // includes a MEDICAL action → medical data
};

// ── inventory: distinct AuditAction literals (36) → maps to governance registry? ──
// Only CREATE/UPDATE/DELETE map cleanly (case-fold). All others need an M2 mapping.
const GOV_MAPPED_ACTIONS = new Set(['CREATE', 'UPDATE', 'DELETE']);
const ACTIONS = [
  'AI-EXTRACT', 'APPROVE_TRANSLATION', 'ASSESS', 'ASSIGN', 'BOOK', 'CERTIFICATE', 'COVER', 'CREATE',
  'DELETE', 'DELETE_DOC', 'DEVELOP', 'DUPLICATE', 'EDIT', 'EMAIL', 'EXAM', 'FROM_MASTER',
  'MARK_ALL_PRESENT', 'MEDICAL', 'MOVE', 'PPTX_BUILD', 'PPTX_DELETE', 'PPTX_UPLOAD', 'PROMOTE',
  'ROLE_ADD', 'ROLE_REMOVE', 'SAVE', 'SIGN', 'STATUS', 'SUPERVISOR_SIGN', 'TEMPLATE_FORM_DELETE',
  'TEMPLATE_FORM_UPLOAD', 'TRANSLATE', 'UPDATE', 'UPLOAD', 'UPLOAD_DOC', 'shift-type',
];

const HIGH_RISK_FILES = ['disciplinary.js', 'onboarding.js', 'leave.js', 'staff.js', 'content.js'];

function routeSrc(file) { return fs.readFileSync(path.join(ROUTES, file), 'utf8'); }

// 1. Migration is complete: NO route retains a legacy logAudit() call site; every
//    file that ever audited now uses the governance adapter. (WP-16 M5 close-out.)
test('M1-1. migration complete (0 legacy sites); migrated files use the adapter', () => {
  let total = 0;
  for (const [file, expected] of Object.entries(EXPECTED_COUNTS)) {
    const n = (routeSrc(file).match(/logAudit\(/g) || []).length;
    assert.equal(n, expected, `${file} has ${expected} logAudit call sites`);
    total += n;
  }
  assert.equal(total, TOTAL, 'remaining total call sites');
  // migrated (M3+M4+M5) files call the adapter, not logAudit
  for (const f of MIGRATED) {
    assert.equal((routeSrc(f).match(/logAudit\(/g) || []).length, 0, `${f} no longer calls logAudit`);
    assert.ok(routeSrc(f).includes('governance/audit-adapter'), `${f} imports the adapter`);
  }
  // no OTHER route file calls logAudit — after M5 this covers EVERY route file
  for (const f of fs.readdirSync(ROUTES)) {
    if (!f.endsWith('.js') || EXPECTED_COUNTS[f] || MIGRATED.includes(f)) continue;
    assert.equal((routeSrc(f).match(/logAudit\(/g) || []).length, 0, `${f} has no logAudit`);
  }
});

// 2. The historical AuditTable inventory remains authoritative documentation.
//    (Source no longer contains logAudit() — M1-1 proves the migration is complete —
//    so the inventory is validated as the permanent record of the original literals.)
test('M1-2. AuditTable inventory documents the original literals', () => {
  assert.ok(Object.keys(TABLES).length >= 30, `inventory documents ${Object.keys(TABLES).length} tables`);
  for (const [t, v] of Object.entries(TABLES)) {
    assert.ok(typeof t === 'string' && t.length > 0, 'table literal is a non-empty string');
    assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(v.risk), `${t} has a valid risk`);
  }
  // the medium-risk (M5) domains are present in the inventory
  for (const t of ['Competency', 'AIContent', 'KBArticle', 'tblFiles', 'PPTX', 'tblExam', 'tblFormTemplate']) {
    assert.ok(t in TABLES, `AuditTable "${t}" is inventoried`);
  }
});

// 3. The historical AuditAction inventory remains authoritative documentation.
test('M1-3. AuditAction inventory documents the original literals', () => {
  assert.ok(ACTIONS.length >= 30, `inventory documents ${ACTIONS.length} actions`);
  for (const a of ['CREATE', 'UPDATE', 'DELETE', 'AI-EXTRACT', 'TRANSLATE', 'DEVELOP', 'CERTIFICATE']) {
    assert.ok(ACTIONS.includes(a), `AuditAction "${a}" is inventoried`);
  }
});

// 4. High-risk routes are classified; sensitive tables are HIGH/CRITICAL.
test('M1-4. high-risk routes classified', () => {
  // each high-risk file is either still inventoried (legacy) or already migrated
  for (const f of HIGH_RISK_FILES) assert.ok((f in EXPECTED_COUNTS) || MIGRATED.includes(f), `${f} inventoried or migrated`);
  for (const t of ['tblStaff', 'tblEmpJob', 'Disciplinary', 'Onboarding', 'OnboardingReview']) {
    assert.ok(['HIGH', 'CRITICAL'].includes(TABLES[t].risk), `${t} is HIGH/CRITICAL`);
  }
  assert.equal(TABLES.Disciplinary.risk, 'CRITICAL');
  assert.equal(TABLES.Onboarding.risk, 'CRITICAL');
});

// 5. Governance-registry action coverage: only CREATE/UPDATE/DELETE map cleanly.
test('M1-5. action mapping gap is captured', () => {
  const needMapping = ACTIONS.filter((a) => !GOV_MAPPED_ACTIONS.has(a));
  assert.ok(needMapping.length >= 30, `${needMapping.length} actions require M2 mapping`);
  for (const a of GOV_MAPPED_ACTIONS) assert.ok(ACTIONS.includes(a));
});

// 6. Entity-coverage gap: some legacy tables have NO direct D1 entity.
test('M1-6. entity-coverage gap is captured', () => {
  const unmapped = Object.entries(TABLES).filter(([, v]) => v.entity === null).map(([k]) => k);
  assert.ok(unmapped.includes('Equipment') && unmapped.includes('Onboarding') && unmapped.includes('LeaveType'),
    'equipment/onboarding/leave have no direct entity (M2 must add or map)');
});

// 7. Final migration state (M5 complete) — NO route imports lib/audit; all 19
//    audit-bearing routes import the governance adapter.
test('M1-7. final migration state (0 legacy + 19 adapter)', () => {
  let importingAudit = 0;
  let importingAdapter = 0;
  for (const f of fs.readdirSync(ROUTES)) {
    if (!f.endsWith('.js')) continue;
    const src = routeSrc(f);
    if (/require\(['"]\.\.\/lib\/audit['"]\)/.test(src)) importingAudit += 1;
    if (src.includes('governance/audit-adapter')) importingAdapter += 1;
  }
  assert.equal(importingAudit, 0, 'no route file imports the legacy lib/audit after M5');
  assert.equal(importingAdapter, 19, 'the 19 migrated route files (M3+M4+M5) import the governance adapter');
});

// 8. lib/audit.js remains the unchanged legacy helper.
test('M1-8. legacy lib/audit.js unchanged', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'audit.js'), 'utf8');
  assert.ok(src.includes('logAudit') && src.includes('OldValue') && src.includes('NewValue'));
  assert.ok(!src.includes('governance/'), 'legacy audit not migrated');
});
