// WP-13 · S6 — Upload hardening helper tests.
// Proves filename normalization (traversal/null-byte-proof), allow-list checks,
// per-kind policies, filter/limits builders, safe handling of malformed input,
// and that no runtime route imports these modules yet.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const U = require(path.join(ROOT, 'lib', 'security', 'upload.js'));
const NUL = '\x00';
const KINDS = ['document', 'image', 'spreadsheet', 'presentation', 'archive'];

// 1 + 2 + 3. normalizeUploadFilename strips paths / null bytes / falls back.
test('S6-u1/2/3. normalizeUploadFilename strips paths, null bytes, and falls back', () => {
  assert.equal(U.normalizeUploadFilename('../../etc/passwd'), 'passwd');
  assert.equal(U.normalizeUploadFilename('..\\..\\secret.docx'), 'secret.docx');
  assert.equal(U.normalizeUploadFilename(`re${NUL}port.pdf`), 'report.pdf');
  assert.ok(!U.normalizeUploadFilename('/a/b/c.txt').includes('/'), 'no separators remain');
  // unsafe / empty → fallback
  assert.equal(U.normalizeUploadFilename('   '), 'upload');
  assert.equal(U.normalizeUploadFilename('////'), 'upload');
  assert.equal(U.normalizeUploadFilename('.pdf'), 'upload.pdf', 'extension-only → fallback name kept');
  for (const bad of [null, undefined, 5, {}]) assert.equal(U.normalizeUploadFilename(bad), 'upload');
  // traversal is impossible in the result
  assert.ok(!U.normalizeUploadFilename('../../../../a').includes('..'));
});

// 4 + 5. extension allow-list is case-insensitive; disallowed rejected.
test('S6-u4/5. extension allow-list is case-insensitive', () => {
  assert.equal(U.isAllowedUploadExtension('Report.PDF', ['.pdf', '.docx']), true);
  assert.equal(U.isAllowedUploadExtension('data.CSV', ['.csv']), true);
  assert.equal(U.isAllowedUploadExtension('evil.exe', ['.pdf']), false);
  assert.equal(U.isAllowedUploadExtension('noext', ['.pdf']), false);
  for (const bad of [null, 5, {}]) assert.equal(U.isAllowedUploadExtension(bad, ['.pdf']), false);
  assert.equal(U.isAllowedUploadExtension('a.pdf', 'not-array'), false);
});

// 6 + 7. MIME allow-list accepts exact lowercase; rejects unknown.
test('S6-u6/7. MIME allow-list exact lowercase match', () => {
  assert.equal(U.isAllowedMimeType('application/pdf', ['application/pdf']), true);
  assert.equal(U.isAllowedMimeType('APPLICATION/PDF', ['application/pdf']), true); // normalized
  assert.equal(U.isAllowedMimeType('application/x-evil', ['application/pdf']), false);
  for (const bad of [null, 5, {}]) assert.equal(U.isAllowedMimeType(bad, ['application/pdf']), false);
  assert.equal(U.isAllowedMimeType('application/pdf', 'not-array'), false);
});

// 8 + 9 + 10. Policies exist for all kinds; positive size; expected extensions.
test('S6-u8/9/10. per-kind policies are complete and conservative', () => {
  for (const kind of KINDS) {
    const p = U.getUploadPolicy(kind);
    assert.ok(p, `${kind} policy exists`);
    assert.ok(Array.isArray(p.allowedExtensions) && p.allowedExtensions.length > 0, `${kind} has extensions`);
    assert.ok(Array.isArray(p.allowedMimeTypes) && p.allowedMimeTypes.length > 0, `${kind} has mime types`);
    assert.ok(Number.isInteger(p.maxFileSizeBytes) && p.maxFileSizeBytes > 0, `${kind} has positive max size`);
  }
  assert.ok(U.getUploadPolicy('document').allowedExtensions.includes('.pdf'));
  assert.ok(U.getUploadPolicy('image').allowedExtensions.includes('.png'));
  assert.ok(U.getUploadPolicy('spreadsheet').allowedExtensions.includes('.xlsx'));
  assert.ok(U.getUploadPolicy('presentation').allowedExtensions.includes('.pptx'));
  assert.ok(U.getUploadPolicy('archive').allowedExtensions.includes('.zip'));
  assert.equal(U.getUploadPolicy('unknown-kind'), null);
  // returned policy is a fresh copy — mutating it must not affect the registry
  const p = U.getUploadPolicy('document');
  p.allowedExtensions.push('.exe');
  assert.ok(!U.getUploadPolicy('document').allowedExtensions.includes('.exe'), 'registry unaffected');
});

// 11 + 12. createUploadFilter accepts allowed and rejects disallowed safely.
test('S6-u11/12. createUploadFilter accepts allowed, rejects disallowed', () => {
  const policy = U.getUploadPolicy('document');
  const filter = U.createUploadFilter(policy);
  const call = (file) => new Promise((resolve) => filter({}, file, (err, ok) => resolve({ err, ok })));

  return Promise.all([
    call({ originalname: 'good.pdf', mimetype: 'application/pdf' }).then((r) => { assert.equal(r.err, null); assert.equal(r.ok, true); }),
    call({ originalname: 'bad.exe', mimetype: 'application/x-msdownload' }).then((r) => { assert.equal(r.err, null); assert.equal(r.ok, false); }),
    call({ originalname: 'good.pdf', mimetype: 'text/x-evil' }).then((r) => { assert.equal(r.ok, false, 'mime mismatch rejected'); }),
    call(null).then((r) => { assert.equal(r.err, null); assert.equal(r.ok, false, 'malformed file rejected safely'); }),
  ]);
});

// 13. buildUploadLimits returns the correct fileSize (positive int only).
test('S6-u13. buildUploadLimits returns positive fileSize', () => {
  assert.deepEqual(U.buildUploadLimits({ maxFileSizeBytes: 5000 }), { fileSize: 5000 });
  assert.equal(U.buildUploadLimits({ maxFileSizeBytes: -1 }).fileSize, U.DEFAULT_MAX_BYTES);
  assert.equal(U.buildUploadLimits({ maxFileSizeBytes: 1.5 }).fileSize, U.DEFAULT_MAX_BYTES);
  assert.equal(U.buildUploadLimits({}).fileSize, U.DEFAULT_MAX_BYTES);
  assert.equal(U.buildUploadLimits(undefined).fileSize, U.DEFAULT_MAX_BYTES);
});

// 14. malformed input never throws across every export.
test('S6-u14. no upload helper throws on malformed input', () => {
  const inputs = [undefined, null, NaN, {}, [], true, 0, '', `${NUL}`, () => {}];
  for (const i of inputs) {
    assert.doesNotThrow(() => U.normalizeUploadFilename(i));
    assert.doesNotThrow(() => U.isAllowedUploadExtension(i, i));
    assert.doesNotThrow(() => U.isAllowedMimeType(i, i));
    assert.doesNotThrow(() => U.buildUploadLimits(i));
    assert.doesNotThrow(() => U.getUploadPolicy(i));
    assert.doesNotThrow(() => U.createUploadFilter(i));
  }
});

// 15. No runtime route (or server.js) imports these modules yet.
test('S6-u15. no route or server imports the S6 modules yet', () => {
  const files = [path.join(ROOT, 'server.js')];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) files.push(path.join(routesDir, f));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!src.includes('security/validate'), `${path.basename(f)} must not import security/validate`);
    assert.ok(!src.includes('security/upload'), `${path.basename(f)} must not import security/upload`);
  }
});
