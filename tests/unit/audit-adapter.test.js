// WP-16 · M2 — Audit adapter unit tests (pure paths; no DB writes).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const A = require(path.join(ROOT, 'lib', 'governance', 'audit-adapter.js'));
const { ENTITY_IDS } = require(path.join(ROOT, 'lib', 'governance', 'entities.js'));
const { ACTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'actions.js'));
const requestContext = require(path.join(ROOT, 'lib', 'request-context.js'));

// M1-observed legacy values.
const OBSERVED_TABLES = ['AIContent', 'Assignment', 'Attendance', 'Competency', 'CompetencyFramework', 'CompetencyRecord', 'Disciplinary', 'Equipment', 'EquipmentBreakdown', 'EquipmentService', 'EquipmentType', 'Exam', 'KBArticle', 'LeaveBooking', 'LeaveType', 'Onboarding', 'OnboardingReview', 'PPTX', 'create', 'tblClass', 'tblEmpJob', 'tblExam', 'tblFiles', 'tblFormSubmission', 'tblFormTemplate', 'tblQ', 'tblRegister', 'tblRoster', 'tblStaff', 'tblTest', 'tblTrainer', 'lock', 'unlock'];
const OBSERVED_ACTIONS = ['AI-EXTRACT', 'APPROVE_TRANSLATION', 'ASSESS', 'ASSIGN', 'BOOK', 'CERTIFICATE', 'COVER', 'CREATE', 'DELETE', 'DELETE_DOC', 'DEVELOP', 'DUPLICATE', 'EDIT', 'EMAIL', 'EXAM', 'FROM_MASTER', 'MARK_ALL_PRESENT', 'MEDICAL', 'MOVE', 'PPTX_BUILD', 'PPTX_DELETE', 'PPTX_UPLOAD', 'PROMOTE', 'ROLE_ADD', 'ROLE_REMOVE', 'SAVE', 'SIGN', 'STATUS', 'SUPERVISOR_SIGN', 'TEMPLATE_FORM_DELETE', 'TEMPLATE_FORM_UPLOAD', 'TRANSLATE', 'UPDATE', 'UPLOAD', 'UPLOAD_DOC', 'shift-type', 'exam', 'lock', 'unlock'];

// 1 + 3. Every observed table maps to a known governance entity id.
test('M2-u1/3. every observed table maps to a known entity', () => {
  for (const t of OBSERVED_TABLES) {
    const e = A.mapLegacyTable(t);
    assert.ok(ENTITY_IDS.includes(e), `${t} → ${e} (known entity)`);
  }
  assert.equal(A.mapLegacyTable('tblStaff'), 'users');
  assert.equal(A.mapLegacyTable('Disciplinary'), 'disciplinary');
  assert.equal(A.mapLegacyTable('Onboarding'), 'onboarding');
  assert.equal(A.mapLegacyTable('LeaveType'), 'leave');
  assert.equal(A.mapLegacyTable('Equipment'), 'equipment');
});

// 2 + 3. Every observed action maps to a known governance action id.
test('M2-u2/3. every observed action maps to a known action', () => {
  for (const a of OBSERVED_ACTIONS) {
    const act = A.mapLegacyAction(a);
    assert.ok(ACTION_IDS.includes(act), `${a} → ${act} (known action)`);
  }
  assert.equal(A.mapLegacyAction('CREATE'), 'create');
  assert.equal(A.mapLegacyAction('UPLOAD_DOC'), 'create');
  assert.equal(A.mapLegacyAction('ROLE_ADD'), 'assign');
  assert.equal(A.mapLegacyAction('PPTX_BUILD'), 'generate_ai');
  assert.equal(A.mapLegacyAction('CERTIFICATE'), 'certify');
  assert.equal(A.mapLegacyAction('exam'), 'assess', 'case-insensitive');
});

// 4. Standard calling convention normalized.
test('M2-u4. standard convention', () => {
  const n = A.normalizeLegacyArgs(['alice', 'tblStaff', 'UPDATE', 42, 'Status', 'A', 'B']);
  assert.equal(n.convention, 'standard');
  assert.equal(n.actor, 'alice');
  assert.equal(n.table, 'tblStaff');
  assert.equal(n.action, 'UPDATE');
  assert.equal(n.recordId, 42);
});

// 5 + 6. Req-first convention + dynamic lock/unlock handled.
test('M2-u5/6. req-first convention + dynamic action', () => {
  const req = { session: { user: { username: 'bob' } } };
  const n = A.normalizeLegacyArgs([req, 'lock', 'exam', 7]);
  assert.equal(n.convention, 'req');
  assert.equal(n.actor, 'bob');
  assert.equal(n.table, 'lock');
  assert.equal(n.action, 'exam');
  assert.equal(A.mapLegacyAction('unlock'), 'update');
  assert.equal(A.mapLegacyAction('lock'), 'update');
});

// 7 + 8. Actor from req.session.user.username → req.user → context → system.
test('M2-u7/8. actor resolution priority', () => {
  assert.equal(A.normalizeLegacyArgs([{ session: { user: { username: 's' } } }]).actor, 's');
  assert.equal(A.normalizeLegacyArgs([{ user: { username: 'u' } }]).actor, 'u');
  assert.equal(A.normalizeLegacyArgs([{ body: { username: 'b' } }]).actor, 'b');
  requestContext.run({ actor: 'ctx', module: 'System' }, () => {
    assert.equal(A.normalizeLegacyArgs([{ session: {} }]).actor, 'ctx', 'context fallback');
    assert.equal(A.normalizeLegacyArgs([undefined]).actor, 'ctx');
  });
  assert.equal(A.normalizeLegacyArgs([{ session: {} }]).actor, 'system', 'system fallback');
});

// 9 + 10. building a record preserves legacy strings + returns internal mapping.
test('M2-u9/10. legacy strings preserved; internal mapping returned', async () => {
  // pure mapping surface (write path is API-tested)
  assert.deepEqual(A.listLegacyTableMappings().tblStaff, 'users');
  assert.deepEqual(A.listLegacyActionMappings().UPLOAD_DOC, 'create');
  // returned mapping shape
  const m = A.listLegacyActionMappings();
  m.CREATE = 'HACK';
  assert.equal(A.listLegacyActionMappings().CREATE, 'create', 'fresh copy');
});

// 11 + 12. Non-sensitive values preserved; secrets masked.
test('M2-u11/12. non-sensitive preserved; secrets masked', () => {
  // users has credentials/pii but NOT a content-drop category → mask + preserve
  const cats = require(path.join(ROOT, 'lib', 'governance', 'entities.js')).getEntity('users').sensitiveCategories;
  assert.equal(A.sanitizeLegacyAuditValues(cats, 'Smith'), 'Smith', 'plain name preserved');
  assert.ok(A.sanitizeLegacyAuditValues(cats, 'key sk-ABCDEFGH12345').includes('[REDACTED]'), 'secret masked');
  assert.equal(A.sanitizeLegacyAuditValues([], 'Active'), 'Active', 'no categories → preserved');
  assert.equal(A.sanitizeLegacyAuditValues([], { a: 1 }), null, 'object dropped');
});

// 13. Sensitive disciplinary/medical/ai free-text dropped.
test('M2-u13. content-sensitive free-text dropped', () => {
  assert.equal(A.sanitizeLegacyAuditValues(['disciplinary_freetext'], 'final written warning'), '[REDACTED]');
  assert.equal(A.sanitizeLegacyAuditValues(['medical'], 'asthma, lifting restriction'), '[REDACTED]');
  assert.equal(A.sanitizeLegacyAuditValues(['ai_content'], 'raw model output'), '[REDACTED]');
  // disciplinary entity → drop
  const dcats = require(path.join(ROOT, 'lib', 'governance', 'entities.js')).getEntity('disciplinary').sensitiveCategories;
  assert.equal(A.sanitizeLegacyAuditValues(dcats, 'severity notes'), '[REDACTED]');
});

// 14 + 15. Malformed input never throws; unknown table/action → safe fallback.
test('M2-u14/15. never throws; safe fallbacks', () => {
  for (const bad of [undefined, null, 5, {}, [], Symbol('x'), () => {}]) {
    assert.doesNotThrow(() => A.mapLegacyTable(bad));
    assert.doesNotThrow(() => A.mapLegacyAction(bad));
    assert.doesNotThrow(() => A.normalizeLegacyArgs(bad));
    assert.doesNotThrow(() => A.sanitizeLegacyAuditValues(bad, bad));
  }
  assert.equal(A.mapLegacyTable('NopeTable'), 'audit', 'unknown table → fallback entity');
  assert.equal(A.mapLegacyAction('NOPE_ACTION'), 'update', 'unknown action → fallback action');
});

// 16 + 17. No mutation; fresh result objects.
test('M2-u16/17. no mutation; fresh objects', () => {
  const args = ['alice', 'tblStaff', 'UPDATE', 1, 'F', 'A', 'B'];
  const snap = JSON.stringify(args);
  A.normalizeLegacyArgs(args);
  assert.equal(JSON.stringify(args), snap, 'args unchanged');
  assert.notEqual(A.listLegacyTableMappings(), A.listLegacyTableMappings());
});

// 18. Exports exactly the expected surface; only the sanctioned M3 routes import it.
test('M2-u18. exports + only migrated routes import the adapter', () => {
  assert.deepEqual(Object.keys(A).sort(), ['listLegacyActionMappings', 'listLegacyTableMappings', 'mapLegacyAction', 'mapLegacyTable', 'normalizeLegacyArgs', 'recordLegacyAudit', 'sanitizeLegacyAuditValues'].sort());
  // WP-16 M3 (low-risk) + M4 (high-risk) + M5 (medium-risk) — the approved adapter consumers.
  const MIGRATED = new Set(['classes.js', 'trainers.js', 'roster.js', 'register.js', 'assignment.js', 'attendance.js', 'equipment.js', 'disciplinary.js', 'onboarding.js', 'leave.js', 'staff.js', 'competency.js', 'forms.js', 'content.js', 'exams.js', 'powerpoints.js', 'files.js', 'translator.js', 'knowledgebase.js']);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').includes('governance/audit-adapter'), 'server.js must not import the adapter');
  assert.ok(!fs.readFileSync(path.join(ROOT, 'lib', 'audit.js'), 'utf8').includes('governance/audit-adapter'), 'lib/audit.js must not import the adapter');
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) {
    if (!f.endsWith('.js')) continue;
    const imports = fs.readFileSync(path.join(routesDir, f), 'utf8').includes('governance/audit-adapter');
    if (MIGRATED.has(f)) assert.ok(imports, `${f} (migrated) imports the adapter`);
    else assert.ok(!imports, `${f} (not migrated) must not import the adapter`);
  }
});
