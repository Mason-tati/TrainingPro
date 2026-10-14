// WP-15 · D5 — Sensitive-data safety sweep (isolated temp DB).
//
// Adversarially proves the NEW governance business-audit helper
// (lib/governance/audit.js) and the operational logger do not leak sensitive
// sentinels. Test-only: no production code is modified (no leak was found in the
// governance helper for the sweep's scope).
//
// LEGACY CURRENT-STATE FINDING (documented, NOT fixed here, NOT a failing test):
//   The pre-existing lib/audit.js still writes OldValue/NewValue verbatim, so a
//   caller passing sensitive free-text there would persist it. This is a known
//   pre-existing condition, out of scope for D5, to be remediated in a future
//   PO-approved migration WP. lib/audit.js is intentionally left unchanged.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');

let app;
let audit;
let logger;
before(async () => {
  app = await startTestApp();
  audit = require(path.join(ROOT, 'lib', 'governance', 'audit.js'));
  logger = require(path.join(ROOT, 'lib', 'logger.js')); // the app's logger instance
});
after(async () => { if (app) await app.close(); });

// ── unique sentinels, one per sensitive category ────────────────────────────
const S = {
  password: 'SWEEP-PASSWORD-x1', hashPass: 'SWEEP-HASHPASS-x2', bcrypt: '$2a$10$SWEEPbcryptHASHxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  cookie: 'SWEEP-COOKIE-x4', connectSid: 'connect.sid=SWEEP-SID-x5', sessionId: 'SWEEP-SESSIONID-x6',
  authorization: 'SWEEP-AUTHZ-x7', bearer: 'Bearer SWEEP-BEARER-x8', jwt: 'eyJSWEEPa.eyJSWEEPb.SWEEPc',
  apiKey: 'sk-SWEEPapikey1234567', sql: "SELECT HashPass FROM tblPswd WHERE UserName='sweep'",
  dbPath: 'database/traintrack.db', reqBody: 'SWEEP-REQBODY-x11', resBody: 'SWEEP-RESBODY-x12',
  fileContents: 'SWEEP-FILECONTENTS-x13', prompt: 'SWEEP-AIPROMPT-x14', completion: 'SWEEP-AICOMPLETION-x15',
  rawAi: 'SWEEP-RAWAI-x16', medical: 'SWEEP-MEDICAL-asthma-x17', disciplinary: 'SWEEP-DISCIPLINARY-warning-x18',
  pii: 'SWEEP-PII-x19', account: '4111111111111111', email: 'sweep.person@example.com', phone: '0455123987',
  docText: 'SWEEP-DOCTEXT-x23',
};
// Everything that must NEVER appear in a stored row or a log record (raw form).
const ALL_RAW = [
  S.password, S.hashPass, S.bcrypt, S.cookie, 'SWEEP-SID-x5', S.sessionId, S.authorization,
  'SWEEP-BEARER-x8', S.jwt, S.apiKey, S.sql, S.dbPath, S.reqBody, S.resBody, S.fileContents,
  S.prompt, S.completion, S.rawAi, S.medical, S.disciplinary, S.pii, S.account, S.email, S.phone, S.docText,
];

const countAudit = async () => (await app.db.dbGet('SELECT COUNT(*) AS n FROM tblAudit')).n;
const AUDIT_ROW_KEYS = ['AuditAction', 'AuditField', 'AuditRecord', 'AuditTable', 'AuditUser', 'NewValue', 'OldValue'];

// 1 + 2 + 3 + 4 + 13. Valid governance write is sentinel-free and stable-shaped.
test('D5-1..4/13. governance helper write leaks no sentinels', async () => {
  const before = await countAudit();
  const r = await audit.recordAuditEvent({
    entity: 'users', action: 'update', actor: 'sweep-actor',
    recordId: S.account, // long number → masked
    field: S.connectSid, // secret pattern → masked
    oldValue: `key ${S.apiKey} tok ${S.bearer} jwt ${S.jwt}`,
    newValue: `sid ${S.connectSid} acct ${S.account}`,
    // content free-text goes in metadata (never written to tblAudit)
    metadata: {
      password: S.password, HashPass: S.hashPass, hash: S.bcrypt, cookie: S.cookie, sessionId: S.sessionId,
      authorization: S.authorization, jwt: S.jwt, sql: S.sql, dbPath: S.dbPath, body: S.reqBody,
      responseBody: S.resBody, filedata: S.fileContents, prompt: S.prompt, completion: S.completion,
      aiOutput: S.rawAi, medical: S.medical, disciplinary: S.disciplinary, pii: S.pii, email: S.email,
      phone: S.phone, docText: S.docText,
    },
    scope: { tenantId: 'SWEEP-TENANT', company: { nested: 1 }, site: [1, 2] },
  });
  assert.equal(r.written, true);
  assert.equal(await countAudit(), before + 1, 'exactly one row written');
  // stable shape (13): the built record maps exactly the 7 tblAudit fields
  assert.deepEqual(Object.keys(r.record).sort(), [...AUDIT_ROW_KEYS].sort());

  const row = await app.db.dbGet('SELECT * FROM tblAudit ORDER BY AuditID DESC LIMIT 1');
  const s = JSON.stringify(row);
  for (const leak of ALL_RAW) assert.ok(!s.includes(leak), `stored row leaked: ${leak}`);
  // only safe masked/capped values remain (4)
  assert.equal(row.AuditUser, 'sweep-actor', 'actor is the safe identity only');
  assert.ok(row.OldValue.includes('[REDACTED]') && !row.OldValue.includes('sk-SWEEP'), 'secrets masked');
  assert.ok(row.AuditRecord.includes('[REDACTED]'), 'account number masked');
});

// 5 + 6 + 7. Unknown entity / unknown action / malformed → nothing written.
test('D5-5/6/7. unknown/malformed writes nothing', async () => {
  const before = await countAudit();
  assert.equal((await audit.recordAuditEvent({ entity: 'nope', action: 'update', oldValue: S.medical })).written, false);
  assert.equal((await audit.recordAuditEvent({ entity: 'users', action: 'nope', oldValue: S.disciplinary })).written, false);
  assert.equal((await audit.recordAuditEvent(null)).written, false);
  assert.equal((await audit.recordAuditEvent({})).written, false);
  assert.equal(await countAudit(), before, 'no rows written');
});

// 8. sanitizeAuditMetadata drops forbidden fields.
test('D5-8. sanitizeAuditMetadata drops forbidden fields', () => {
  const out = audit.sanitizeAuditMetadata({
    keep: 'ok', n: 1,
    password: S.password, HashPass: S.hashPass, hash: S.bcrypt, cookie: S.cookie, authorization: S.authorization,
    jwt: S.jwt, token: S.bearer, sql: S.sql, body: S.reqBody, prompt: S.prompt, completion: S.completion,
    filedata: S.fileContents, base64: S.docText,
  });
  assert.deepEqual(Object.keys(out).sort(), ['keep', 'n'].sort());
  const s = JSON.stringify(out);
  for (const leak of ALL_RAW) assert.ok(!s.includes(leak), `metadata leaked: ${leak}`);
});

// 9 + 10 + 11 + 12. Operational logger does not leak governance sentinels.
test('D5-9..12. operational logger leaks no sentinels', () => {
  const rows = [];
  const restore = logger.__setSink((r) => rows.push(r));
  const prev = logger.__setLevel('info');
  const rc = require(path.join(ROOT, 'lib', 'request-context.js'));
  try {
    // aiEvent uses a strict allow-list → every forbidden field is discarded.
    logger.aiEvent('AI_CALL', {
      provider: 'anthropic', model: 'm',
      prompt: S.prompt, completion: S.completion, rawOutput: S.rawAi, messages: [S.docText],
      password: S.password, cookie: S.cookie, sessionId: S.sessionId, authorization: S.authorization,
      sql: S.sql, dbPath: S.dbPath, body: S.reqBody, responseBody: S.resBody,
    });
    // warn/info go through the redactor (deny-keys dropped, patterns masked).
    rc.run({ requestId: 'req-sweep', actor: 'admin', module: 'System' }, () => {
      logger.warn('SECURITY_SWEEP', {
        password: S.password, cookie: S.cookie, authorization: S.authorization, prompt: S.prompt,
        completion: S.completion, medical: S.medical, disciplinary: S.disciplinary, sessionId: S.sessionId,
        note: `inline ${S.apiKey} ${S.bearer} ${S.jwt} ${S.account} ${S.email}`,
      });
    });
    logger.__setSink(restore); logger.__setLevel(prev);
    const s = JSON.stringify(rows);
    for (const leak of ALL_RAW) assert.ok(!s.includes(leak), `logger leaked: ${leak}`);
    // correlation may include requestId/actor only (12) — never a session id/cookie/body
    const warnRec = rows.find((r) => r.event === 'SECURITY_SWEEP');
    assert.equal(warnRec.requestId, 'req-sweep');
    assert.equal(warnRec.actor, 'admin');
    assert.ok(!JSON.stringify(warnRec).includes('SWEEP-SID'), 'no session id');
  } finally { logger.__setSink(restore); logger.__setLevel(prev); }
});

// 14 + 15. Legacy lib/audit.js is unchanged (current-state finding, non-failing).
test('D5-14/15. legacy lib/audit.js unchanged (documented current-state finding)', () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'lib', 'audit.js'), 'utf8');
  // It still maps OldValue/NewValue verbatim — the documented pre-existing exposure.
  assert.ok(src.includes('OldValue') && src.includes('NewValue'), 'legacy helper present');
  assert.ok(src.includes('logAudit'), 'legacy logAudit intact');
  // This test asserts the legacy file EXISTS as-is; it does NOT fail on the exposure.
  assert.ok(!src.includes('governance/'), 'legacy audit does not import governance (not migrated in D5)');
});

// 21-guard. Isolated temp DB — production DB path is never used.
test('D5-iso. runs against an isolated temp DB', () => {
  assert.ok(app.dbPath.includes('.tmp') && !app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});

// ── WP-15 D6 — governance close-out verification ────────────────────────────
// All eight governance modules present; nothing in production imports them;
// legacy lib/audit.js remains unmigrated. (Behaviour-neutral, report-only.)
test('D6. governance foundation is complete and unwired', () => {
  const fs2 = require('node:fs');
  const govDir = path.join(ROOT, 'lib', 'governance');
  const EXPECTED_MODULES = ['classifications.js', 'retention.js', 'sensitive-data.js', 'entities.js', 'actions.js', 'audit.js', 'audit-taxonomy.js', 'entity-governance.js', 'audit-adapter.js']; // WP-16 M2 — audit-adapter added
  const present = fs2.readdirSync(govDir).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(present, [...EXPECTED_MODULES].sort(), 'all governance modules present');

  // No server.js imports lib/governance. Routes: only the sanctioned WP-16 M3
  // low-risk migration set may import the governance audit-adapter; no other route
  // imports any lib/governance module.
  const M3_MIGRATED = new Set(['classes.js', 'trainers.js', 'roster.js', 'register.js', 'assignment.js', 'attendance.js', 'equipment.js', 'disciplinary.js', 'onboarding.js', 'leave.js', 'staff.js', 'competency.js', 'forms.js', 'content.js', 'exams.js', 'powerpoints.js', 'files.js', 'translator.js', 'knowledgebase.js']);
  assert.ok(!fs2.readFileSync(path.join(ROOT, 'server.js'), 'utf8').includes('governance/'), 'server.js must not import lib/governance');
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs2.readdirSync(routesDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs2.readFileSync(path.join(routesDir, f), 'utf8');
    if (M3_MIGRATED.has(f)) {
      // migrated routes import ONLY the audit-adapter (no other governance module)
      assert.ok(!/governance\/(?!audit-adapter)/.test(src), `${f} may import only governance/audit-adapter`);
    } else {
      assert.ok(!src.includes('governance/'), `${f} must not import lib/governance`);
    }
  }

  // Legacy lib/audit.js remains unchanged/unmigrated (current-state finding).
  const legacy = fs2.readFileSync(path.join(ROOT, 'lib', 'audit.js'), 'utf8');
  assert.ok(legacy.includes('logAudit') && legacy.includes('OldValue') && legacy.includes('NewValue'), 'legacy logAudit intact');
  assert.ok(!legacy.includes('governance/'), 'legacy audit not migrated to governance');
});
