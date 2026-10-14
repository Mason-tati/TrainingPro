// WP-07 · C11 — PDF generation (offline, no AI, no network).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildPdfFromSegments } = require(path.join(__dirname, '..', '..', 'lib', 'pdfout.js'));

const FONTS = ['C:/Windows/Fonts/tahoma.ttf', 'C:/Windows/Fonts/leelawui.ttf', 'C:/Windows/Fonts/arialuni.ttf'];
const hasFont = FONTS.some((p) => { try { return fs.existsSync(p); } catch { return false; } });

// 1/2/3. Valid, non-empty PDF with a %PDF header (guarded by font availability).
test('1/2/3. buildPdfFromSegments produces a valid, non-empty PDF', async (t) => {
  if (!hasFont) return t.skip('no Unicode-capable system font available');
  const buf = await buildPdfFromSegments(
    [{ source: 'Hello', target: 'สวัสดี' }, { source: 'Safety first', target: 'ความปลอดภัยต้องมาก่อน' }],
    true,
    'C11 Test Document'
  );
  assert.ok(Buffer.isBuffer(buf), 'returns a Buffer');
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-', 'valid PDF header');
  assert.ok(buf.length > 500, 'PDF has non-empty content');
  // %%EOF trailer present
  assert.ok(buf.slice(-8).toString('latin1').includes('EOF'), 'PDF trailer present');
});

// Target-only mode also produces a valid PDF.
test('buildPdfFromSegments target-only mode is valid', async (t) => {
  if (!hasFont) return t.skip('no Unicode-capable system font available');
  const buf = await buildPdfFromSegments([{ target: 'Line one' }, { target: 'Line two' }], false, null);
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  assert.ok(buf.length > 400);
});
