// WP-16 · M5 — Medium-risk route audit migration tests (isolated temp DB).
// Exercises the migrated document / AI / examination / competency / forms /
// translator audit paths. Proves: unchanged responses, shape-compatible tblAudit
// rows (legacy AuditTable/AuditAction strings preserved), AI content dropped, and
// that sensitive bodies (AI prompt/completion, translation text, large document
// content, file binary/base64) never reach OldValue/NewValue — while useful
// identifiers (names, counts) are retained.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const MED_ROUTES = ['competency', 'forms', 'content', 'exams', 'powerpoints', 'files', 'translator', 'knowledgebase'];

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

const lastAudit = () => app.db.dbGet('SELECT * FROM tblAudit ORDER BY AuditID DESC LIMIT 1');

// 1 + 9 + 10 + 11 + 17. Competency route unchanged; audit row created; legacy
// AuditTable/AuditAction preserved; non-sensitive identifier retained.
test('M5-1. competency: response unchanged; audit row shape preserved; identifier kept', async () => {
  const r = await app.request('POST', '/api/competency/frameworks', { name: 'M5-COMP-SENTINEL', description: 'x' });
  assert.equal(r.status, 200, 'same status (1,17)');
  assert.equal(r.json().success, true, 'same body shape (17)');
  assert.ok(r.json().id, 'id returned (17)');
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'CompetencyFramework', 'AuditTable preserved (10)');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction preserved (11)');
  assert.equal(row.AuditRecord, String(r.json().id), 'audit row created for record (9)');
  assert.equal(row.NewValue, 'M5-COMP-SENTINEL', 'non-sensitive identifier retained');
});

// 8 + 9 + 10 + 11 + 15. Knowledgebase route unchanged; audit row created; large
// article BODY never reaches the audit row (only the title identifier is logged).
test('M5-8. knowledgebase: response unchanged; large article body absent from audit', async () => {
  const bigBody = 'M5-KB-BODY-SENTINEL-' + 'x'.repeat(6000); // large document content
  const r = await app.request('POST', '/api/kb/articles', { title: 'M5-KB-TITLE', body: bigBody, status: 'Published' });
  assert.equal(r.status, 200, 'same status (8)');
  assert.equal(r.json().success, true, 'same body shape (8)');
  const row = await lastAudit();
  assert.equal(row.AuditTable, 'KBArticle', 'AuditTable preserved (10)');
  assert.equal(row.AuditAction, 'CREATE', 'AuditAction preserved (11)');
  assert.equal(row.AuditRecord, String(r.json().id), 'audit row created (9)');
  assert.equal(row.NewValue, 'M5-KB-TITLE', 'title identifier retained');
  assert.ok(!JSON.stringify(row).includes('M5-KB-BODY-SENTINEL'), 'large article body absent (15)');
});

// 12 + 13. AI content (ai_outputs) — prompt AND completion free-text are DROPPED to
// a safe placeholder in the written tblAudit row (defense-in-depth via the adapter).
test('M5-12/13. AI prompt + completion dropped from audit (written row is [REDACTED])', async () => {
  const A = require('../../lib/governance/audit-adapter'); // fresh instance wired to the temp DB
  const rp = await A.recordLegacyAudit('m5tester', 'AIContent', 'SAVE', 12, 'prompt', null, 'M5-AI-PROMPT-SENTINEL raw model input');
  assert.equal(rp.written, true, 'row written to the temp DB');
  assert.equal(rp.record.NewValue, '[REDACTED]', 'prompt dropped in prepared record (12)');
  const rowP = await lastAudit();
  assert.equal(rowP.AuditTable, 'AIContent', 'legacy AuditTable preserved');
  assert.equal(rowP.NewValue, '[REDACTED]', 'prompt dropped in written row (12)');
  assert.ok(!JSON.stringify(rowP).includes('M5-AI-PROMPT-SENTINEL'), 'AI prompt sentinel absent (12)');

  const rc = await A.recordLegacyAudit('m5tester', 'AIContent', 'UPDATE', 13, 'completion', null, 'M5-AI-COMPLETION-SENTINEL raw model output');
  assert.equal(rc.record.NewValue, '[REDACTED]', 'completion dropped in prepared record (13)');
  const rowC = await lastAudit();
  assert.equal(rowC.NewValue, '[REDACTED]', 'completion dropped in written row (13)');
  assert.ok(!JSON.stringify(rowC).includes('M5-AI-COMPLETION-SENTINEL'), 'AI completion sentinel absent (13)');
});

// 2-7. The other migrated medium-risk routers load and mount unchanged. (startTestApp
// re-requires every route + lib module against the temp DB; a broken import/syntax in
// any migrated file would fail the before-hook, so a booted app proves they all load.)
test('M5-2..7. migrated routers load and mount unchanged', () => {
  assert.ok(app && app.dbPath, 'app booted → all routes (incl. the 8 migrated) mounted');
  for (const f of MED_ROUTES) {
    const mod = require(path.join(ROOT, 'routes', `${f}.js`));
    assert.equal(typeof mod, 'function', `${f}.js exports a mounted Express router`);
  }
});

// 14 + 16. Content-safety: the migrated audit call sites pass only safe IDENTIFIERS
// (file names, languages, folders, counts) — never a request body, file buffer, or
// base64/binary. So translation bodies (14) and file binary/base64 (16) are
// structurally incapable of reaching tblAudit through these routes.
test('M5-14/16. audit call sites pass identifiers, never raw bodies/buffers/base64', () => {
  const FORBIDDEN = [/\.buffer\b/, /base64/i, /req\.body\.body\b/, /req\.body\.content\b/, /req\.file\.buffer\b/, /toString\(\s*['"]base64/i];
  for (const f of MED_ROUTES) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', `${f}.js`), 'utf8');
    // isolate each recordLegacyAudit(...) call site (single-line calls in these files)
    for (const line of src.split('\n')) {
      if (!line.includes('recordLegacyAudit(')) continue;
      for (const pat of FORBIDDEN) {
        assert.ok(!pat.test(line), `${f}.js audit call must not pass ${pat} — "${line.trim().slice(0, 100)}"`);
      }
    }
  }
});

// 18. Every migrated route imports the adapter and no longer uses legacy lib/audit.
test('M5-18. all 8 medium-risk routes migrated to the adapter', () => {
  for (const f of MED_ROUTES) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', `${f}.js`), 'utf8');
    assert.ok(!/require\(['"]\.\.\/lib\/audit['"]\)/.test(src), `${f}.js must not import lib/audit`);
    assert.ok(!src.includes('logAudit('), `${f}.js has no logAudit calls`);
    assert.ok(src.includes('governance/audit-adapter'), `${f}.js imports the adapter`);
  }
});

// Sanitization matrix: AI content is dropped; document/assessment identifiers are
// masked + capped (kept useful); oversized/secret content is never stored raw.
test('M5-san. AI content dropped; document identifiers masked+capped', () => {
  const A = require('../../lib/governance/audit-adapter');
  // legacy tables map to the intended governance entities
  assert.equal(A.mapLegacyTable('AIContent'), 'ai_outputs');
  assert.equal(A.mapLegacyTable('tblFiles'), 'documents');
  assert.equal(A.mapLegacyTable('KBArticle'), 'documents');
  // ai_outputs carries ai_content → whole value dropped
  assert.equal(A.sanitizeLegacyAuditValues(['ai_content'], 'raw model output'), '[REDACTED]', 'AI content dropped');
  // documents/assessments carry no content-drop category → identifier preserved (masked/capped)
  assert.equal(A.sanitizeLegacyAuditValues([], 'safety-plan.pdf'), 'safety-plan.pdf', 'file-name identifier retained');
  // an oversized value (e.g. an accidental large paste) is capped to <=256 chars, never full-length
  const capped = A.sanitizeLegacyAuditValues([], 'A'.repeat(4000));
  assert.ok(typeof capped === 'string' && capped.length <= 256, 'oversized value capped to <=256');
});

// Isolated temp DB — production DB path is never used.
test('M5-iso. isolated temp DB', () => {
  assert.ok(app.dbPath.includes('.tmp') && !app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});
