// WP-17 · D2 — Document-metadata builder tests (pure, total, 100% coverage).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(ROOT, 'lib', 'document', 'document-metadata.js'));

const SHAPE = ['title', 'description', 'type', 'status', 'reviewFrequency', 'approvalLevel', 'documentNumber', 'version', 'owner', 'department', 'site', 'classification', 'retention', 'governance'];

test('DM-1. valid metadata builds with the full shape + embedded governance', () => {
  const md = M.buildDocumentMetadata({
    title: '  Confined Space SOP  ', description: 'How to enter safely', type: 'SOP', status: 'PUBLISHED',
    reviewFrequency: 'YEARLY', approvalLevel: 'SITE_MANAGER', site: 'SYD', department: 'OPS', sequence: 12, version: '2.1',
  });
  for (const k of SHAPE) assert.ok(k in md, `${k} present`);
  assert.equal(md.title, 'Confined Space SOP');
  assert.equal(md.type, 'SOP');
  assert.equal(md.status, 'PUBLISHED');
  assert.equal(md.reviewFrequency, 'YEARLY');
  assert.equal(md.approvalLevel, 'SITE_MANAGER');
  assert.equal(md.documentNumber, 'SYD-OPS-SOP-000012');
  assert.equal(md.version, '2.1');
  assert.equal(md.classification, 'SAFETY_CRITICAL'); // 10. governance embedded
  assert.equal(md.retention, 'extended');
  assert.equal(md.governance.entity, 'documents');
  assert.equal(md.governance.type, 'SOP');
});

test('DM-2..5. unknown type/status/frequency/approval → safe registry defaults', () => {
  const md = M.buildDocumentMetadata({ type: 'NOPE', status: 'NOPE', reviewFrequency: 'NOPE', approvalLevel: 'NOPE' });
  assert.equal(md.type, 'unknown');            // 2
  assert.equal(md.status, 'unknown');          // 3
  assert.equal(md.reviewFrequency, 'unknown'); // 4
  assert.equal(md.approvalLevel, 'unknown');   // 5
  assert.equal(md.classification, 'CONFIDENTIAL');
  assert.equal(md.governance.entity, 'documents');
});

test('DM-6. title sanitization: control strip, trim, cap 160, fallback', () => {
  assert.equal(M.sanitizeDocumentTitle('  Hello' + String.fromCharCode(0, 7) + 'World  '), 'HelloWorld');
  assert.equal(M.sanitizeDocumentTitle('x'.repeat(500)).length, 160, 'capped to 160');
  assert.equal(M.sanitizeDocumentTitle(''), 'Untitled Document');
  assert.equal(M.sanitizeDocumentTitle('   '), 'Untitled Document');
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(M.sanitizeDocumentTitle(bad), 'Untitled Document');
});

test('DM-7. description sanitization: control strip, trim, cap 1000, fallback ""', () => {
  assert.equal(M.sanitizeDocumentDescription('  desc' + String.fromCharCode(1) + '  '), 'desc');
  assert.equal(M.sanitizeDocumentDescription('y'.repeat(5000)).length, 1000, 'capped to 1000');
  assert.equal(M.sanitizeDocumentDescription(''), '');
  for (const bad of [null, undefined, 5, {}, []]) assert.equal(M.sanitizeDocumentDescription(bad), '');
});

test('DM-8. secret masking: password/token/Bearer/JWT/connect.sid/API key/SQL removed', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJYIn0.sigSIGsig';
  const title = M.sanitizeDocumentTitle(`Doc sk-ABCDEFGH12345678 Bearer tok123 password=hunter2 ${jwt} connect.sid=s%3Aabc api_key=zzzz`);
  for (const leak of ['sk-ABCDEFGH12345678', 'tok123', 'hunter2', jwt, 's%3Aabc', 'zzzz']) {
    assert.ok(!title.includes(leak), `secret ${leak} masked`);
  }
  assert.ok(title.includes('[REDACTED]'));
  const desc = M.sanitizeDocumentDescription('note: DROP TABLE users; and SELECT * FROM secrets');
  assert.ok(!/DROP TABLE users/i.test(desc) && !/SELECT \* FROM secrets/i.test(desc), 'SQL masked');
});

test('DM-9. document number: provided valid number kept; else built from parts', () => {
  const a = M.buildDocumentMetadata({ documentNumber: 'mel_eng_wi 000007', type: 'WORK_INSTRUCTION' });
  assert.equal(a.documentNumber, 'MEL-ENG-WI-000007', 'provided number normalized + kept');
  const b = M.buildDocumentMetadata({ type: 'FORM', site: 'bne', department: 'hr', sequence: 3 });
  assert.equal(b.documentNumber, 'BNE-HR-FORM-000003', 'built from parts');
  const c = M.buildDocumentMetadata({ documentNumber: 'not-valid' });
  assert.ok(/^X-X-X-\d{6,}$/.test(c.documentNumber) || /-\d{6,}$/.test(c.documentNumber), 'invalid provided → built default');
});

test('DM-version. version normalization across types', () => {
  assert.equal(M.buildDocumentMetadata({ version: 3 }).version, '3');          // finite number
  assert.equal(M.buildDocumentMetadata({ version: 'v2.0!!' }).version, 'v2.0'); // string stripped
  assert.equal(M.buildDocumentMetadata({ version: '   ' }).version, '1');       // empty string → default
  assert.equal(M.buildDocumentMetadata({ version: {} }).version, '1');          // non-number/string → default
  assert.equal(M.buildDocumentMetadata({ version: Infinity }).version, '1');    // non-finite → default
});

test('DM-11/12. no mutation of input; fresh objects each call', () => {
  const input = Object.freeze({ title: 'T', type: 'SOP', tags: Object.freeze([1, 2]) });
  assert.doesNotThrow(() => M.buildDocumentMetadata(input));
  assert.equal(input.title, 'T');
  const a = M.buildDocumentMetadata({ type: 'SOP' });
  const b = M.buildDocumentMetadata({ type: 'SOP' });
  assert.notEqual(a, b);
  assert.notEqual(a.governance, b.governance);
  a.governance.classification = 'X';
  assert.notEqual(M.buildDocumentMetadata({ type: 'SOP' }).governance.classification, 'X');
});

test('DM-13. never throws for any input (incl. non-object)', () => {
  for (const bad of [null, undefined, 5, 'str', [], Symbol('x'), true, () => {}, 10n]) {
    assert.doesNotThrow(() => M.buildDocumentMetadata(bad));
    const md = M.buildDocumentMetadata(bad);
    assert.equal(md.type, 'unknown');
    assert.equal(md.title, 'Untitled Document');
    assert.equal(md.documentNumber, 'X-X-X-000000');
  }
});

test('DM-normalize. normalizeDocumentMetadata is idempotent + canonical', () => {
  const built = M.buildDocumentMetadata({ title: 'T', type: 'POLICY', status: 'APPROVED', site: 'syd', department: 'leg', sequence: 9 });
  const norm1 = M.normalizeDocumentMetadata(built);
  const norm2 = M.normalizeDocumentMetadata(norm1);
  assert.deepEqual(norm1, norm2, 'idempotent');
  assert.equal(norm1.type, 'POLICY');
  assert.equal(norm1.documentNumber, built.documentNumber, 'document number round-trips');
});

test('DM-14. no DB / filesystem / logging (module source is pure)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'document', 'document-metadata.js'), 'utf8');
  for (const forbidden of ['database/db', 'require(\'fs\')', 'require("fs")', 'node:fs', 'console.', 'lib/logger', 'request-context', 'express']) {
    assert.ok(!src.includes(forbidden), `must not reference ${forbidden}`);
  }
});
