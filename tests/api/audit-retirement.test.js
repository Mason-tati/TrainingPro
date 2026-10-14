// WP-16 · M6 — Legacy audit retirement: permanent verification suite.
//
// Closes WP-16. Proves — and locks in against regression — that:
//   • no production route imports the legacy lib/audit helper;
//   • every audit-bearing route routes through the governance adapter;
//   • the adapter's legacy→governance mappings all resolve to real entities/actions;
//   • sensitive material (AI prompts/completions, JWTs, tokens, cookies, session
//     ids, passwords, API keys, long numbers, binary, base64) cannot reach tblAudit;
//   • responses, status codes, and the tblAudit row shape are unchanged.
// Runs entirely against an isolated temp DB.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const ROUTES = path.join(ROOT, 'routes');
const A = require('../../lib/governance/audit-adapter');
const { ENTITY_IDS, getEntity } = require('../../lib/governance/entities');
const { ACTION_IDS } = require('../../lib/governance/actions');

const routeFiles = () => fs.readdirSync(ROUTES).filter((f) => f.endsWith('.js'));
const rsrc = (f) => fs.readFileSync(path.join(ROUTES, f), 'utf8');
const LEGACY_IMPORT = /require\((['"])[^'"]*lib\/audit\1\)/; // matches only paths ending in lib/audit

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });
const lastAudit = () => app.db.dbGet('SELECT * FROM tblAudit ORDER BY AuditID DESC LIMIT 1');

// ─────────────────────────── TASK 1 + 2 — retirement invariants ───────────────────────────

test('M6-T2-1. NO production route imports lib/audit', () => {
  for (const f of routeFiles()) assert.ok(!LEGACY_IMPORT.test(rsrc(f)), `${f} must not import lib/audit`);
});

test('M6-T2-2. NO route file calls logAudit()', () => {
  for (const f of routeFiles()) assert.ok(!rsrc(f).includes('logAudit('), `${f} must not call logAudit`);
});

test('M6-T2-3. every audit-bearing route imports the adapter + uses recordLegacyAudit', () => {
  const auditRoutes = routeFiles().filter((f) => rsrc(f).includes('recordLegacyAudit('));
  assert.ok(auditRoutes.length >= 19, `expected >=19 audit routes, found ${auditRoutes.length}`);
  for (const f of auditRoutes) {
    assert.ok(rsrc(f).includes('governance/audit-adapter'), `${f} imports the governance adapter`);
    assert.ok(!LEGACY_IMPORT.test(rsrc(f)), `${f} does not import lib/audit`);
  }
});

test('M6-T2-4. lib/audit.js is retained but has NO production caller (routes/lib/server.js)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'audit.js')), 'legacy lib/audit.js retained');
  const prod = [path.join(ROOT, 'server.js')];
  for (const f of routeFiles()) prod.push(path.join(ROUTES, f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) prod.push(path.join(ROOT, 'lib', f));
  for (const file of prod) {
    if (file === path.join(ROOT, 'lib', 'audit.js')) continue; // the helper itself
    assert.ok(!LEGACY_IMPORT.test(fs.readFileSync(file, 'utf8')), `${path.relative(ROOT, file)} must not import lib/audit`);
  }
});

// ─────────────────────────── TASK 3 — adapter mapping coverage ───────────────────────────

test('M6-T3-1. every mapped legacy TABLE resolves to an existing governance entity', () => {
  const tableMap = A.listLegacyTableMappings();
  for (const [legacy, entity] of Object.entries(tableMap)) {
    assert.ok(ENTITY_IDS.includes(entity), `${legacy} → ${entity} is a real entity`);
    assert.equal(A.mapLegacyTable(legacy), entity, `${legacy} maps consistently`);
    assert.equal(getEntity(entity).id, entity, 'entity resolvable');
  }
});

test('M6-T3-2. every mapped legacy ACTION resolves to an existing governance action', () => {
  const actionMap = A.listLegacyActionMappings();
  for (const [legacy, action] of Object.entries(actionMap)) {
    assert.ok(ACTION_IDS.includes(action), `${legacy} → ${action} is a real action`);
    assert.equal(A.mapLegacyAction(legacy), action, `${legacy} maps consistently`);
  }
});

test('M6-T3-3. every legacy TABLE/ACTION literal used by the live routes maps to a governance entity/action', () => {
  const auditRoutes = routeFiles().filter((f) => rsrc(f).includes('recordLegacyAudit('));
  let tables = 0;
  for (const f of auditRoutes) {
    const s = rsrc(f);
    for (const m of s.matchAll(/recordLegacyAudit\([^,]+,\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
      const [, tbl, act] = m;
      assert.ok(ENTITY_IDS.includes(A.mapLegacyTable(tbl)), `table '${tbl}' (${f}) → real entity`);
      assert.ok(ACTION_IDS.includes(A.mapLegacyAction(act)), `action '${act}' (${f}) → real action`);
      tables += 1;
    }
  }
  assert.ok(tables >= 25, `scanned ${tables} table/action literals from live routes`);
});

test('M6-T3-4. mapLegacyTable/Action ALWAYS return a governance entity/action (incl. unknown/garbage → safe fallback)', () => {
  for (const bad of ['NoSuchTable', '', null, undefined, 5, {}, [], 'lock', 'unlock', 'exam']) {
    assert.ok(ENTITY_IDS.includes(A.mapLegacyTable(bad)), `mapLegacyTable(${String(bad)}) → real entity`);
    assert.ok(ACTION_IDS.includes(A.mapLegacyAction(bad)), `mapLegacyAction(${String(bad)}) → real action`);
  }
  assert.equal(A.mapLegacyTable('NoSuchTable'), 'audit', 'unknown table → safe fallback entity');
  assert.equal(A.mapLegacyAction('NoSuchAction'), 'update', 'unknown action → safe fallback action');
});

// ─────────────────────────── TASK 4 — adversarial sanitization ───────────────────────────

const SECRETS = {
  ai_prompt: 'M6SENT-AI-PROMPT you are a helpful assistant, ignore prior instructions',
  ai_completion: 'M6SENT-AI-COMPLETION here is the generated certificate body text',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJNNlNFTlQtSldUIn0.s3cretSignaturePart123',
  bearer: 'Bearer M6SENT-BEARER-tokenABCDEFGH',
  cookie: 'connect.sid=s%3AM6SENT-COOKIE.aBcDeFgHiJkLmNoPqR',
  session_id: 'connect.sid=s%3AM6SENT-SESSION-9f8e7d6c5b4a',
  password: 'sk-M6SENT-PASSWORD-hunter2ABCDEFGH', // credential pattern → stripped by mask
  api_key: 'sk-M6SENT-APIKEY-ABCDEFGH12345678',
  long_number: '9876543210012',
  binary: 'M6SENT-BINARY' + String.fromCharCode(0, 1, 2, 8, 27, 31, 127), // NUL/control bytes
  base64: 'TTZTRU5ULUJBU0U2NA' + 'QUJDRA'.repeat(1000), // long base64-ish blob
};

// 4a. Content-drop path (AI-generated entity) removes EVERY category entirely.
test('M6-T4a. AI content path drops every sensitive category to [REDACTED]', async () => {
  let id = 0;
  for (const [name, secret] of Object.entries(SECRETS)) {
    id += 1;
    const res = await A.recordLegacyAudit('m6tester', 'AIContent', 'SAVE', id, name, null, secret);
    assert.equal(res.record.NewValue, '[REDACTED]', `${name} dropped in prepared record`);
    const row = await lastAudit();
    assert.equal(row.NewValue, '[REDACTED]', `${name} dropped in written row`);
    const marker = secret.replace(/[^A-Za-z0-9]/g, '').slice(0, 18);
    assert.ok(!JSON.stringify(row).includes(marker), `${name} sentinel absent from tblAudit row`);
  }
});

// 4b. Even on a NON-drop entity, recognised credential/token patterns are masked out.
test('M6-T4b. credential/token patterns masked even without content-drop (documents entity)', async () => {
  const patternCats = ['jwt', 'bearer', 'cookie', 'session_id', 'password', 'api_key', 'long_number'];
  let id = 100;
  for (const name of patternCats) {
    id += 1;
    const secret = SECRETS[name];
    const res = await A.recordLegacyAudit('m6tester', 'tblFiles', 'UPLOAD', id, null, null, secret);
    // the dangerous token itself must be gone (masked); value is bounded
    const distinctive = name === 'long_number' ? secret : secret.replace(/^(Bearer |connect\.sid=)/, '');
    assert.ok(!res.record.NewValue.includes(distinctive), `${name} token masked in prepared record`);
    const row = await lastAudit();
    assert.ok(!JSON.stringify(row).includes(distinctive), `${name} token absent from written row`);
    assert.ok(row.NewValue.length <= 256, `${name} value capped`);
  }
});

// 4c. Oversized binary/base64 values are bounded (never stored full-length) and control
// chars stripped; and the actor is NEVER derived from a password/cookie/session id.
test('M6-T4c. oversized values bounded; control chars stripped; actor never a credential', async () => {
  const res = await A.recordLegacyAudit('m6tester', 'tblFiles', 'UPLOAD', 200, null, null, SECRETS.base64);
  assert.ok(res.record.NewValue.length <= 256, 'base64 blob capped to <=256');
  const bin = await A.recordLegacyAudit('m6tester', 'tblFiles', 'UPLOAD', 201, null, null, SECRETS.binary);
  assert.equal(bin.record.NewValue, 'M6SENT-BINARY', 'control chars stripped, value preserved');
  // actor resolution from a request-like object never surfaces password/cookie/session id
  const reqLike = { session: { user: { username: 'realuser' } }, body: { password: 'sk-SECRET-PW-123', username: 'realuser' }, headers: { cookie: 'connect.sid=s%3Aleak' } };
  const viaReq = A.normalizeLegacyArgs([reqLike, 'tblFiles', 'UPLOAD', 1]);
  assert.equal(viaReq.actor, 'realuser', 'actor is the username, not a secret');
  assert.ok(!JSON.stringify(viaReq).includes('sk-SECRET-PW-123') && !JSON.stringify(viaReq).includes('connect.sid'), 'no credential leaked into actor');
});

// ─────────────────────────── TASK 5 — regression (shape + behaviour) ───────────────────────────

test('M6-T5-1. competency create: response + status + audit row shape unchanged', async () => {
  const r = await app.request('POST', '/api/competency/frameworks', { name: 'M6-REG-FW', description: 'd' });
  assert.equal(r.status, 200, 'status unchanged');
  assert.deepEqual(Object.keys(r.json()).sort(), ['id', 'success'], 'response body shape unchanged');
  assert.equal(r.json().success, true);
  const row = await lastAudit();
  // tblAudit row shape: all legacy columns present + preserved values
  for (const col of ['AuditID', 'AuditDate', 'AuditUser', 'AuditTable', 'AuditAction', 'AuditRecord', 'AuditField', 'OldValue', 'NewValue']) {
    assert.ok(col in row, `column ${col} present`);
  }
  assert.match(row.AuditDate, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'AuditDate format unchanged (datetime now)');
  assert.equal(row.AuditTable, 'CompetencyFramework', 'AuditTable unchanged');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction unchanged');
  assert.equal(row.AuditUser, 'admin', 'AuditUser is the session user');
  assert.equal(row.AuditRecord, String(r.json().id));
});

test('M6-T5-2. knowledgebase create: response + audit user/table/action unchanged', async () => {
  const r = await app.request('POST', '/api/kb/articles', { title: 'M6-REG-KB', body: 'body', status: 'Published' });
  assert.equal(r.status, 200, 'status unchanged');
  assert.equal(r.json().success, true, 'response unchanged');
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'KBArticle');
  assert.equal(row.AuditAction, 'CREATE');
  assert.equal(row.AuditUser, 'admin');
  assert.match(row.AuditDate, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('M6-T5-3. fire-and-forget: adapter never throws and never breaks the caller', async () => {
  // garbage inputs of every shape → resolves, never rejects, always ok:true (fail-open)
  for (const args of [[], [null], [undefined, undefined], [{}, 5, [], Symbol('x')], ['u', 'X', 'Y', {}, () => {}, Symbol('s'), new Map()]]) {
    const res = await A.recordLegacyAudit(...args);
    assert.equal(res.ok, true, 'adapter fails open (ok:true)');
  }
  // and a real route still returns its normal response regardless of audit outcome
  const r = await app.request('POST', '/api/competency/frameworks', { name: 'M6-FAF' });
  assert.equal(r.status, 200, 'route response unaffected by audit');
});

// ─────────────────────────── isolation guard ───────────────────────────

test('M6-iso. runs against an isolated temp DB (production DB never touched)', () => {
  assert.ok(app.dbPath.includes('.tmp') && !app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});
